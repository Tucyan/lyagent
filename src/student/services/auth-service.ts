import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "./password.js";

export type UserRole = "teacher" | "student";
export type UserStatus = "active" | "disabled";

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CREDENTIALS"
      | "ACCOUNT_DISABLED"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "SETUP_ALREADY_COMPLETED"
      | "RATE_LIMITED"
      | "WEAK_PASSWORD"
      | "VALIDATION_ERROR",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  status: UserStatus;
  must_change_password: number;
}

export class StudentAuthService {
  private readonly loginFailures = new Map<string, number[]>();

  constructor(
    private readonly db: Database.Database,
    private readonly options: {
      sessionTtlHours?: number;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private sessionTtlMs(): number {
    return (this.options.sessionTtlHours ?? 168) * 3600 * 1000;
  }

  hasTeacherAccount(): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM users WHERE role = 'teacher' LIMIT 1").get() as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  async ensureBootstrapAdmin(input?: { username: string; password: string; displayName: string }): Promise<void> {
    if (!input || this.hasTeacherAccount()) return;
    await this.createInitialTeacher(input);
  }

  async createInitialTeacher(input: { username: string; password: string; displayName: string }): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
    if (this.hasTeacherAccount()) {
      throw new AuthError("SETUP_ALREADY_COMPLETED", "教师管理员账号已初始化", 409);
    }
    const username = normalizeUsername(input.username);
    const displayName = input.displayName.trim() || "教师管理员";
    assertPasswordStrength(input.password);
    const passwordHash = await hashPassword(input.password);
    const nowIso = this.now().toISOString();
    const id = randomUUID();

    const insert = this.db.transaction(() => {
      if (this.hasTeacherAccount()) {
        throw new AuthError("SETUP_ALREADY_COMPLETED", "教师管理员账号已初始化", 409);
      }
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, role, password_hash, status, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, 'teacher', ?, 'active', 0, ?, ?)
      `).run(id, username, displayName, passwordHash, nowIso, nowIso);
    });
    insert.immediate();

    const user: AuthenticatedUser = { id, username, displayName, role: "teacher", status: "active", mustChangePassword: false };
    const session = this.issueSession(id);
    return { user, ...session };
  }

  async login(usernameInput: string, password: string, clientKey = "local"): Promise<{ user: AuthenticatedUser; token: string; expiresAt: string }> {
    const rateKey = `${clientKey}:${usernameInput.trim().toLowerCase()}`;
    this.checkRateLimit(rateKey);

    const row = this.db.prepare(`
      SELECT id, username, display_name, role, password_hash, status, must_change_password
      FROM users WHERE username = ?
    `).get(usernameInput.trim()) as UserRow | undefined;

    if (!row || !(await verifyPassword(password, row.password_hash))) {
      this.recordFailure(rateKey);
      throw new AuthError("INVALID_CREDENTIALS", "账号或密码错误", 401);
    }
    if (row.status !== "active") {
      throw new AuthError("ACCOUNT_DISABLED", "该账号已被停用，请联系授课教师", 403);
    }

    this.loginFailures.delete(rateKey);
    const session = this.issueSession(row.id);
    return {
      user: mapUserRow(row),
      ...session,
    };
  }

  authenticateToken(rawToken: string | undefined): AuthenticatedUser | undefined {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const nowIso = this.now().toISOString();
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.status, u.must_change_password, s.expires_at
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash) as (UserRow & { expires_at: string }) | undefined;

    if (!row) return undefined;
    if (row.expires_at <= nowIso || row.status !== "active") {
      this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash);
      return undefined;
    }

    this.db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso, tokenHash);
    return mapUserRow(row);
  }

  logout(rawToken: string | undefined): void {
    if (!rawToken) return;
    this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hashToken(rawToken));
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, currentToken?: string): Promise<void> {
    assertPasswordStrength(newPassword);
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ? AND status = 'active'").get(userId) as { password_hash: string } | undefined;
    if (!row) throw new AuthError("UNAUTHORIZED", "账号不存在或已停用", 401);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw new AuthError("INVALID_CREDENTIALS", "当前密码不正确", 401);
    }
    const newHash = await hashPassword(newPassword);
    const nowIso = this.now().toISOString();
    const currentHash = currentToken ? hashToken(currentToken) : undefined;

    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?").run(newHash, nowIso, userId);
      if (currentHash) {
        this.db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?").run(userId, currentHash);
      } else {
        this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      }
    });
    tx();
  }

  issueSession(userId: string): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs()).toISOString();
    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hashToken(token), userId, expiresAt, nowIso, nowIso);
    return { token, expiresAt };
  }

  private checkRateLimit(key: string): void {
    const nowMs = this.now().getTime();
    const windowStart = nowMs - 60_000;
    const recent = (this.loginFailures.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length > 0) this.loginFailures.set(key, recent);
    else this.loginFailures.delete(key);
    if (recent.length >= 10) {
      throw new AuthError("RATE_LIMITED", "登录尝试过于频繁，请 1 分钟后再试", 429);
    }
  }

  private recordFailure(key: string): void {
    const nowMs = this.now().getTime();
    const windowStart = nowMs - 60_000;
    const recent = (this.loginFailures.get(key) ?? []).filter((ts) => ts > windowStart);
    recent.push(nowMs);
    this.loginFailures.set(key, recent);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeUsername(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{2,64}$/u.test(trimmed)) {
    throw new AuthError("VALIDATION_ERROR", "账号/学号仅支持 2-64 位字母、数字、点、下划线或连字符", 400);
  }
  return trimmed;
}

export function assertPasswordStrength(password: string): void {
  if (password.length < 6 || password.length > 128) {
    throw new AuthError("WEAK_PASSWORD", "密码长度需在 6 到 128 位之间", 400);
  }
}

function mapUserRow(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
  };
}
