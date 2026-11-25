import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStudentDatabase } from "../src/student/db/student-db.js";
import { AccountAdminError, AccountAdminService } from "../src/student/services/account-admin-service.js";
import { AuthError, StudentAuthService } from "../src/student/services/auth-service.js";

const tempDirs: string[] = [];

function createTestContext() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lyagent-student-auth-"));
  tempDirs.push(dir);
  const db = openStudentDatabase(dir);
  const auth = new StudentAuthService(db);
  const accounts = new AccountAdminService(db, auth);
  return { dir, db, auth, accounts };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("StudentAuthService & AccountAdminService", () => {
  it("initializes initial teacher once and enforces login/logout/disable/password-change", async () => {
    const { db, auth, accounts } = createTestContext();
    expect(auth.hasTeacherAccount()).toBe(false);

    const admin = await auth.createInitialTeacher({ username: "teacher01", password: "Secret123", displayName: "张老师" });
    expect(admin.user.role).toBe("teacher");
    expect(auth.hasTeacherAccount()).toBe(true);
    expect(auth.authenticateToken(admin.token)?.username).toBe("teacher01");

    await expect(auth.createInitialTeacher({ username: "teacher02", password: "Secret123", displayName: "李老师" })).rejects.toThrow(AuthError);

    const created = await accounts.createStudent({
      username: "2026001",
      displayName: "王小明",
      courseIds: ["c1", "c2"],
      grantedBy: admin.user.id,
    });
    expect(created.user.mustChangePassword).toBe(true);
    expect(created.user.courseIds).toEqual(["c1", "c2"]);

    const login1 = await auth.login("2026001", created.initialPassword);
    const login2 = await auth.login("2026001", created.initialPassword);
    expect(auth.authenticateToken(login1.token)?.id).toBe(created.user.id);
    expect(auth.authenticateToken(login2.token)?.id).toBe(created.user.id);

    await auth.changePassword(created.user.id, created.initialPassword, "NewPass123", login1.token);
    expect(auth.authenticateToken(login1.token)?.mustChangePassword).toBe(false);
    expect(auth.authenticateToken(login2.token)).toBeUndefined();

    accounts.setUserStatus(created.user.id, "disabled", admin.user.id);
    expect(auth.authenticateToken(login1.token)).toBeUndefined();
    await expect(auth.login("2026001", "NewPass123")).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });

    db.close();
  });

  it("supports invite code registration with usage limits, expiry, revocation, and course permissions", async () => {
    const { db, auth, accounts } = createTestContext();
    const admin = await auth.createInitialTeacher({ username: "admin", password: "Secret123", displayName: "Admin" });

    const invite = accounts.createInviteCode({
      label: "计网1班",
      courseIds: ["course-net", "course-os"],
      maxUses: 1,
      expiresInDays: 7,
      createdBy: admin.user.id,
    });

    const reg = await accounts.registerWithInviteCode({
      code: invite.code.toLowerCase(),
      username: "2026101",
      displayName: "陈同学",
      password: "Password123",
    });
    expect(reg.courseIds).toEqual(["course-net", "course-os"]);
    expect(accounts.hasCourseAccess(reg.user, "course-net")).toBe(true);
    expect(accounts.hasCourseAccess(reg.user, "course-db")).toBe(false);
    expect(accounts.hasCourseAccess(admin.user, "course-db")).toBe(true);

    await expect(
      accounts.registerWithInviteCode({ code: invite.code, username: "2026102", displayName: "李同学", password: "Password123" }),
    ).rejects.toBeInstanceOf(AccountAdminError);

    const invite2 = accounts.createInviteCode({ label: "临时码", courseIds: ["course-net"], createdBy: admin.user.id });
    accounts.revokeInviteCode(invite2.code);
    await expect(
      accounts.registerWithInviteCode({ code: invite2.code, username: "2026103", displayName: "赵同学", password: "Password123" }),
    ).rejects.toMatchObject({ code: "INVITE_REVOKED" });

    db.close();
  });

  it("bulk imports students idempotently and resets passwords with session revocation", async () => {
    const { db, auth, accounts } = createTestContext();
    const admin = await auth.createInitialTeacher({ username: "admin", password: "Secret123", displayName: "Admin" });

    const first = await accounts.bulkImportStudents({
      rawText: "2026201\t张三\n2026202,李四\nbadline\n2026201 重复",
      courseIds: ["c1"],
      grantedBy: admin.user.id,
    });
    expect(first.createdCount).toBe(2);
    expect(first.errors).toHaveLength(2);

    const second = await accounts.bulkImportStudents({
      rawText: "2026201 张三\n2026203 王五",
      courseIds: ["c2"],
      grantedBy: admin.user.id,
    });
    expect(second.createdCount).toBe(1);
    expect(second.updatedCount).toBe(1);

    const users = accounts.listUsers({ role: "student" });
    const zhang = users.find((u) => u.username === "2026201")!;
    expect(zhang.courseIds.sort()).toEqual(["c1", "c2"]);

    const cred = first.credentials.find((c) => c.username === "2026201")!;
    const s = await auth.login("2026201", cred.initialPassword!);
    expect(auth.authenticateToken(s.token)).toBeDefined();

    const reset = await accounts.resetUserPassword(zhang.id);
    expect(auth.authenticateToken(s.token)).toBeUndefined();
    const s2 = await auth.login("2026201", reset.temporaryPassword);
    expect(s2.user.mustChangePassword).toBe(true);

    const syncToken = accounts.createSyncToken("本地教师端", admin.user.id);
    expect(accounts.verifySyncToken(syncToken.plainToken)).toBe(true);
    accounts.revokeSyncToken(syncToken.record.id);
    expect(accounts.verifySyncToken(syncToken.plainToken)).toBe(false);

    db.close();
  });
});
