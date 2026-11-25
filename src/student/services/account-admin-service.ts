import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertPasswordStrength, AuthError, hashToken, normalizeUsername, StudentAuthService, type AuthenticatedUser, type UserRole, type UserStatus } from "./auth-service.js";
import { generateReadablePassword, hashPassword } from "./password.js";

export interface ManagedUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  courseIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface InviteCodeRecord {
  code: string;
  label: string;
  courseIds: string[];
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  status: "active" | "revoked";
  createdAt: string;
}

export interface SyncTokenRecord {
  id: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface BulkImportPreviewRow {
  lineNumber: number;
  raw: string;
  username: string;
  displayName: string;
  action: "create" | "grant_courses" | "invalid";
  error?: string;
}

export interface BulkImportResult {
  createdCount: number;
  updatedCount: number;
  credentials: Array<{
    username: string;
    displayName: string;
    initialPassword?: string;
    action: "created" | "courses_added";
  }>;
  errors: Array<{ lineNumber: number; raw: string; error: string }>;
}

export class AccountAdminError extends Error {
  constructor(
    public readonly code:
      | "USER_NOT_FOUND"
      | "USERNAME_EXISTS"
      | "INVITE_INVALID"
      | "INVITE_EXHAUSTED"
      | "INVITE_EXPIRED"
      | "INVITE_REVOKED"
      | "VALIDATION_ERROR",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AccountAdminError";
  }
}

export class AccountAdminService {
  constructor(
    private readonly db: Database.Database,
    private readonly auth: StudentAuthService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  hasCourseAccess(user: Pick<AuthenticatedUser, "id" | "role">, courseId: string): boolean {
    if (user.role === "teacher") return true;
    const row = this.db.prepare("SELECT 1 AS found FROM course_enrollments WHERE user_id = ? AND course_id = ?").get(user.id, courseId) as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  listAuthorizedCourseIds(userId: string): string[] {
    const rows = this.db.prepare("SELECT course_id FROM course_enrollments WHERE user_id = ? ORDER BY created_at ASC").all(userId) as Array<{ course_id: string }>;
    return rows.map((r) => r.course_id);
  }

  listUsers(filter?: { courseId?: string; query?: string; role?: UserRole }): ManagedUserRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.role) {
      conditions.push("u.role = ?");
      params.push(filter.role);
    }
    if (filter?.query?.trim()) {
      const q = `%${filter.query.trim()}%`;
      conditions.push("(u.username LIKE ? OR u.display_name LIKE ?)");
      params.push(q, q);
    }
    if (filter?.courseId) {
      conditions.push("EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.user_id = u.id AND ce.course_id = ?)");
      params.push(filter.courseId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const users = this.db.prepare(`
      SELECT id, username, display_name, role, status, must_change_password, created_at, updated_at
      FROM users u
      ${whereClause}
      ORDER BY CASE WHEN role = 'teacher' THEN 0 ELSE 1 END, created_at DESC
    `).all(...params) as Array<{
      id: string;
      username: string;
      display_name: string;
      role: UserRole;
      status: UserStatus;
      must_change_password: number;
      created_at: string;
      updated_at: string;
    }>;

    const enrollments = this.db.prepare("SELECT user_id, course_id FROM course_enrollments").all() as Array<{ user_id: string; course_id: string }>;
    const courseMap = new Map<string, string[]>();
    for (const row of enrollments) {
      const list = courseMap.get(row.user_id) ?? [];
      list.push(row.course_id);
      courseMap.set(row.user_id, list);
    }

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      status: u.status,
      mustChangePassword: u.must_change_password === 1,
      courseIds: courseMap.get(u.id) ?? [],
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    }));
  }

  async createStudent(input: {
    username: string;
    displayName: string;
    password?: string;
    courseIds: string[];
    grantedBy: string;
  }): Promise<{ user: ManagedUserRecord; initialPassword: string }> {
    const username = normalizeUsername(input.username);
    const displayName = input.displayName.trim() || username;
    const existing = this.db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) throw new AccountAdminError("USERNAME_EXISTS", `账号 ${username} 已存在`, 409);

    const initialPassword = input.password?.trim() || generateReadablePassword(8);
    assertPasswordStrength(initialPassword);
    const passwordHash = await hashPassword(initialPassword);
    const mustChange = input.password?.trim() ? 0 : 1;
    const nowIso = this.now().toISOString();
    const id = randomUUID();
    const courseIds = uniqueStrings(input.courseIds);

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, role, password_hash, status, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, 'student', ?, 'active', ?, ?, ?)
      `).run(id, username, displayName, passwordHash, mustChange, nowIso, nowIso);
      const insertEnroll = this.db.prepare(`
        INSERT OR IGNORE INTO course_enrollments (user_id, course_id, granted_by, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const courseId of courseIds) {
        insertEnroll.run(id, courseId, input.grantedBy, nowIso);
      }
    });
    tx.immediate();

    return {
      user: {
        id,
        username,
        displayName,
        role: "student",
        status: "active",
        mustChangePassword: mustChange === 1,
        courseIds,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      initialPassword,
    };
  }

  previewBulkImport(rawText: string): BulkImportPreviewRow[] {
    const lines = rawText.split(/\r?\n/);
    const existingRows = this.db.prepare("SELECT username FROM users").all() as Array<{ username: string }>;
    const existingSet = new Set(existingRows.map((r) => r.username.toLowerCase()));
    const seenInBatch = new Set<string>();
    const results: BulkImportPreviewRow[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]!.trim();
      if (!raw) continue;
      const parsed = parseStudentLine(raw);
      if (!parsed) {
        results.push({ lineNumber: index + 1, raw, username: "", displayName: "", action: "invalid", error: "格式应为：学号 姓名（可用空格、Tab 或逗号分隔）" });
        continue;
      }
      try {
        const username = normalizeUsername(parsed.username);
        const key = username.toLowerCase();
        if (seenInBatch.has(key)) {
          results.push({ lineNumber: index + 1, raw, username, displayName: parsed.displayName, action: "invalid", error: "名单内学号重复" });
          continue;
        }
        seenInBatch.add(key);
        results.push({
          lineNumber: index + 1,
          raw,
          username,
          displayName: parsed.displayName,
          action: existingSet.has(key) ? "grant_courses" : "create",
        });
      } catch (error) {
        results.push({
          lineNumber: index + 1,
          raw,
          username: parsed.username,
          displayName: parsed.displayName,
          action: "invalid",
          error: error instanceof Error ? error.message : "学号格式无效",
        });
      }
    }
    return results;
  }

  async bulkImportStudents(input: { rawText: string; courseIds: string[]; grantedBy: string }): Promise<BulkImportResult> {
    const preview = this.previewBulkImport(input.rawText);
    const courseIds = uniqueStrings(input.courseIds);
    const errors = preview.filter((r) => r.action === "invalid").map((r) => ({ lineNumber: r.lineNumber, raw: r.raw, error: r.error ?? "格式无效" }));
    const valid = preview.filter((r) => r.action !== "invalid");

    const preparedNew = await Promise.all(
      valid
        .filter((r) => r.action === "create")
        .map(async (r) => {
          const initialPassword = generateReadablePassword(8);
          const passwordHash = await hashPassword(initialPassword);
          return { ...r, initialPassword, passwordHash };
        }),
    );
    const preparedMap = new Map(preparedNew.map((item) => [item.username.toLowerCase(), item]));

    const nowIso = this.now().toISOString();
    const credentials: BulkImportResult["credentials"] = [];
    let createdCount = 0;
    let updatedCount = 0;

    const tx = this.db.transaction(() => {
      const insertUser = this.db.prepare(`
        INSERT INTO users (id, username, display_name, role, password_hash, status, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, 'student', ?, 'active', 1, ?, ?)
      `);
      const insertEnroll = this.db.prepare(`
        INSERT OR IGNORE INTO course_enrollments (user_id, course_id, granted_by, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findUser = this.db.prepare("SELECT id, username, display_name FROM users WHERE username = ?");

      for (const row of valid) {
        const existing = findUser.get(row.username) as { id: string; username: string; display_name: string } | undefined;
        if (existing) {
          for (const courseId of courseIds) {
            insertEnroll.run(existing.id, courseId, input.grantedBy, nowIso);
          }
          updatedCount += 1;
          credentials.push({ username: existing.username, displayName: existing.display_name, action: "courses_added" });
          continue;
        }
        const prepared = preparedMap.get(row.username.toLowerCase());
        if (!prepared) continue;
        const id = randomUUID();
        insertUser.run(id, prepared.username, prepared.displayName, prepared.passwordHash, nowIso, nowIso);
        for (const courseId of courseIds) {
          insertEnroll.run(id, courseId, input.grantedBy, nowIso);
        }
        createdCount += 1;
        credentials.push({
          username: prepared.username,
          displayName: prepared.displayName,
          initialPassword: prepared.initialPassword,
          action: "created",
        });
      }
    });
    tx.immediate();

    return { createdCount, updatedCount, credentials, errors };
  }

  setUserCourses(userId: string, courseIds: string[], grantedBy: string): ManagedUserRecord {
    const existing = this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!existing) throw new AccountAdminError("USER_NOT_FOUND", "用户不存在", 404);
    const normalized = uniqueStrings(courseIds);
    const nowIso = this.now().toISOString();

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM course_enrollments WHERE user_id = ?").run(userId);
      const insert = this.db.prepare("INSERT INTO course_enrollments (user_id, course_id, granted_by, created_at) VALUES (?, ?, ?, ?)");
      for (const courseId of normalized) {
        insert.run(userId, courseId, grantedBy, nowIso);
      }
      this.db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(nowIso, userId);
    });
    tx.immediate();

    return this.listUsers().find((u) => u.id === userId)!;
  }

  setUserStatus(userId: string, status: UserStatus, actorId: string): ManagedUserRecord {
    const existing = this.db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: UserRole } | undefined;
    if (!existing) throw new AccountAdminError("USER_NOT_FOUND", "用户不存在", 404);
    if (existing.id === actorId && status === "disabled") {
      throw new AccountAdminError("VALIDATION_ERROR", "不能停用当前登录的管理员账号", 400);
    }
    const nowIso = this.now().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso, userId);
      if (status === "disabled") {
        this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      }
    });
    tx.immediate();
    return this.listUsers().find((u) => u.id === userId)!;
  }

  async resetUserPassword(userId: string): Promise<{ username: string; temporaryPassword: string }> {
    const existing = this.db.prepare("SELECT id, username FROM users WHERE id = ?").get(userId) as { id: string; username: string } | undefined;
    if (!existing) throw new AccountAdminError("USER_NOT_FOUND", "用户不存在", 404);
    const temporaryPassword = generateReadablePassword(8);
    const hash = await hashPassword(temporaryPassword);
    const nowIso = this.now().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?").run(hash, nowIso, userId);
      this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
    });
    tx.immediate();
    return { username: existing.username, temporaryPassword };
  }

  createInviteCode(input: {
    label: string;
    courseIds: string[];
    maxUses?: number | null;
    expiresInDays?: number | null;
    createdBy: string;
  }): InviteCodeRecord {
    const courseIds = uniqueStrings(input.courseIds);
    if (courseIds.length === 0) throw new AccountAdminError("VALIDATION_ERROR", "邀请码至少需要绑定一门课程", 400);
    const label = input.label.trim() || "课程邀请码";
    const maxUses = input.maxUses ?? null;
    if (maxUses !== null && maxUses <= 0) throw new AccountAdminError("VALIDATION_ERROR", "使用上限必须大于 0", 400);
    const now = this.now();
    const expiresAt = input.expiresInDays && input.expiresInDays > 0
      ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString()
      : null;

    let code = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateInviteCode();
      const exists = this.db.prepare("SELECT 1 FROM invite_codes WHERE code = ?").get(candidate);
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) code = generateInviteCode(10);

    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO invite_codes (code, label, course_ids_json, max_uses, used_count, expires_at, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 'active', ?, ?)
    `).run(code, label, JSON.stringify(courseIds), maxUses, expiresAt, input.createdBy, nowIso);

    return { code, label, courseIds, maxUses, usedCount: 0, expiresAt, status: "active", createdAt: nowIso };
  }

  listInviteCodes(): InviteCodeRecord[] {
    const rows = this.db.prepare(`
      SELECT code, label, course_ids_json, max_uses, used_count, expires_at, status, created_at
      FROM invite_codes
      ORDER BY created_at DESC
    `).all() as Array<{
      code: string;
      label: string;
      course_ids_json: string;
      max_uses: number | null;
      used_count: number;
      expires_at: string | null;
      status: "active" | "revoked";
      created_at: string;
    }>;
    return rows.map((row) => ({
      code: row.code,
      label: row.label,
      courseIds: JSON.parse(row.course_ids_json) as string[],
      maxUses: row.max_uses,
      usedCount: row.used_count,
      expiresAt: row.expires_at,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  revokeInviteCode(code: string): void {
    const info = this.db.prepare("UPDATE invite_codes SET status = 'revoked' WHERE code = ?").run(code.trim());
    if (info.changes === 0) throw new AccountAdminError("INVITE_INVALID", "邀请码不存在", 404);
  }

  async registerWithInviteCode(input: {
    code: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string; courseIds: string[] }> {
    const username = normalizeUsername(input.username);
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 60) {
      throw new AccountAdminError("VALIDATION_ERROR", "请填写 1-60 字的姓名", 400);
    }
    assertPasswordStrength(input.password);
    const passwordHash = await hashPassword(input.password);
    const nowIso = this.now().toISOString();
    const userId = randomUUID();
    const normalizedCode = input.code.trim().toUpperCase();

    let grantedCourses: string[] = [];
    const tx = this.db.transaction(() => {
      const invite = this.db.prepare(`
        SELECT code, course_ids_json, max_uses, used_count, expires_at, status, created_by
        FROM invite_codes WHERE code = ?
      `).get(normalizedCode) as {
        code: string;
        course_ids_json: string;
        max_uses: number | null;
        used_count: number;
        expires_at: string | null;
        status: "active" | "revoked";
        created_by: string;
      } | undefined;

      if (!invite) throw new AccountAdminError("INVITE_INVALID", "邀请码无效，请向授课教师确认", 404);
      if (invite.status !== "active") throw new AccountAdminError("INVITE_REVOKED", "该邀请码已被停用", 403);
      if (invite.expires_at && invite.expires_at <= nowIso) throw new AccountAdminError("INVITE_EXPIRED", "该邀请码已过期", 403);
      if (invite.max_uses !== null && invite.used_count >= invite.max_uses) throw new AccountAdminError("INVITE_EXHAUSTED", "该邀请码已达到注册人数上限", 403);

      const existing = this.db.prepare("SELECT id FROM users WHERE username = ?").get(username);
      if (existing) throw new AccountAdminError("USERNAME_EXISTS", `学号/账号 ${username} 已注册，请直接登录`, 409);

      const updatedInvite = this.db.prepare(`
        UPDATE invite_codes
        SET used_count = used_count + 1
        WHERE code = ? AND status = 'active' AND (max_uses IS NULL OR used_count < max_uses)
      `).run(invite.code);
      if (updatedInvite.changes !== 1) {
        throw new AccountAdminError("INVITE_EXHAUSTED", "该邀请码已达到注册人数上限", 403);
      }

      this.db.prepare(`
        INSERT INTO users (id, username, display_name, role, password_hash, status, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, 'student', ?, 'active', 0, ?, ?)
      `).run(userId, username, displayName, passwordHash, nowIso, nowIso);

      grantedCourses = JSON.parse(invite.course_ids_json) as string[];
      const insertEnroll = this.db.prepare("INSERT OR IGNORE INTO course_enrollments (user_id, course_id, granted_by, created_at) VALUES (?, ?, ?, ?)");
      for (const courseId of grantedCourses) {
        insertEnroll.run(userId, courseId, invite.created_by, nowIso);
      }
    });
    tx.immediate();

    const session = this.auth.issueSession(userId);
    return {
      user: { id: userId, username, displayName, role: "student", status: "active", mustChangePassword: false },
      ...session,
      courseIds: grantedCourses,
    };
  }

  createSyncToken(label: string, createdBy: string): { record: SyncTokenRecord; plainToken: string } {
    const id = randomUUID();
    const plainToken = `stsync_${randomBytes(24).toString("base64url")}`;
    const nowIso = this.now().toISOString();
    const normalizedLabel = label.trim() || "教师端资料同步";
    this.db.prepare(`
      INSERT INTO sync_tokens (id, label, token_hash, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, normalizedLabel, hashToken(plainToken), createdBy, nowIso);
    return {
      record: { id, label: normalizedLabel, lastUsedAt: null, revokedAt: null, createdAt: nowIso },
      plainToken,
    };
  }

  listSyncTokens(): SyncTokenRecord[] {
    const rows = this.db.prepare(`
      SELECT id, label, last_used_at, revoked_at, created_at
      FROM sync_tokens ORDER BY created_at DESC
    `).all() as Array<{ id: string; label: string; last_used_at: string | null; revoked_at: string | null; created_at: string }>;
    return rows.map((r) => ({ id: r.id, label: r.label, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, createdAt: r.created_at }));
  }

  revokeSyncToken(id: string): void {
    const nowIso = this.now().toISOString();
    const info = this.db.prepare("UPDATE sync_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(nowIso, id);
    if (info.changes === 0) throw new AuthError("VALIDATION_ERROR", "同步令牌不存在", 404);
  }

  verifySyncToken(rawToken: string | undefined): boolean {
    if (!rawToken) return false;
    const tokenHash = hashToken(rawToken);
    const row = this.db.prepare("SELECT id, revoked_at FROM sync_tokens WHERE token_hash = ?").get(tokenHash) as { id: string; revoked_at: string | null } | undefined;
    if (!row || row.revoked_at) return false;
    this.db.prepare("UPDATE sync_tokens SET last_used_at = ? WHERE id = ?").run(this.now().toISOString(), row.id);
    return true;
  }
}

function parseStudentLine(line: string): { username: string; displayName: string } | undefined {
  const parts = line.split(/[\t,，\s]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [username, ...rest] = parts;
  if (!username) return undefined;
  const displayName = rest.join(" ").trim();
  if (!displayName) return undefined;
  return { username, displayName };
}

function generateInviteCode(suffixLength = 6): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let suffix = "";
  for (let i = 0; i < suffixLength; i += 1) {
    suffix += alphabet[randomInt(0, alphabet.length)];
  }
  return `COURSE-${suffix}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
