import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccountAdminError, AccountAdminService } from "../services/account-admin-service.js";
import { AuthError, StudentAuthService, type AuthenticatedUser } from "../services/auth-service.js";
import { KnowledgeSyncService } from "../services/knowledge-sync-service.js";
import { QuotaService } from "../services/quota-service.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

const setupSchema = z.object({
  username: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(60),
  password: z.string().min(6).max(128),
});

const registerSchema = z.object({
  code: z.string().trim().min(2).max(64),
  username: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(60),
  password: z.string().min(6).max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(6).max(128),
});

const createStudentSchema = z.object({
  username: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(60),
  password: z.string().min(6).max(128).optional(),
  courseIds: z.array(z.string().uuid()).max(100).default([]),
});

const bulkTextSchema = z.object({
  rawText: z.string().min(1).max(500_000),
});

const bulkImportSchema = z.object({
  rawText: z.string().min(1).max(500_000),
  courseIds: z.array(z.string().uuid()).max(100).default([]),
});

const setUserCoursesSchema = z.object({
  courseIds: z.array(z.string().uuid()).max(100),
});

const setUserStatusSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const createInviteSchema = z.object({
  label: z.string().trim().min(1).max(80),
  courseIds: z.array(z.string().uuid()).min(1).max(100),
  maxUses: z.number().int().positive().max(10_000).nullable().optional(),
  expiresInDays: z.number().int().positive().max(365).nullable().optional(),
});

const createSyncTokenSchema = z.object({
  label: z.string().trim().min(1).max(80).default("教师工作台同步"),
});

const updateGlobalQuotaSchema = z.object({
  emergencyQaPaused: z.boolean().optional(),
  globalDailyQaLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  globalDailyTokenLimit: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});

const updateCourseQuotaSchema = z.object({
  dailyQaLimit: z.number().int().min(0).max(10_000),
  totalQaLimit: z.number().int().min(0).max(1_000_000).nullable(),
  perMinuteLimit: z.number().int().min(1).max(120),
  maxConcurrent: z.number().int().min(1).max(5),
});

const updateStudentQuotaSchema = z.object({
  dailyQaLimit: z.number().int().min(0).max(10_000).nullable(),
  totalQaLimit: z.number().int().min(0).max(1_000_000).nullable(),
  note: z.string().max(200).optional(),
});

export const SESSION_COOKIE_NAME = "ly_student_session";

export function registerAuthAndAdminRoutes(
  app: FastifyInstance,
  deps: {
    auth: StudentAuthService;
    accounts: AccountAdminService;
    syncService: KnowledgeSyncService;
    quotas: QuotaService;
    getSessionToken: (request: FastifyRequest) => string | undefined;
    setSessionCookie: (request: FastifyRequest, reply: FastifyReply, token: string, expiresAt: string) => void;
    clearSessionCookie: (request: FastifyRequest, reply: FastifyReply) => void;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedUser | undefined>;
    requireTeacher: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedUser | undefined>;
  },
): void {
  app.get("/api/auth/status", async (request) => {
    const initialized = deps.auth.hasTeacherAccount();
    const token = deps.getSessionToken(request);
    const user = deps.auth.authenticateToken(token);
    return { initialized, user: user ?? null };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    const input = setupSchema.parse(request.body);
    const result = await deps.auth.createInitialTeacher(input);
    deps.setSessionCookie(request, reply, result.token, result.expiresAt);
    return { user: result.user };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await deps.auth.login(input.username, input.password, request.ip);
    deps.setSessionCookie(request, reply, result.token, result.expiresAt);
    return { user: result.user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    deps.auth.logout(deps.getSessionToken(request));
    deps.clearSessionCookie(request, reply);
    return { ok: true };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await deps.accounts.registerWithInviteCode(input);
    deps.setSessionCookie(request, reply, result.token, result.expiresAt);
    return { user: result.user, courseIds: result.courseIds };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const user = await deps.requireAuth(request, reply);
    if (!user) return;
    const input = changePasswordSchema.parse(request.body);
    await deps.auth.changePassword(user.id, input.currentPassword, input.newPassword, deps.getSessionToken(request));
    return { ok: true };
  });

  // --- Teacher Admin Console ---

  app.get("/api/admin/courses", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    return { courses: await deps.syncService.listSyncedCourses() };
  });

  app.get<{ Querystring: { courseId?: string; q?: string; role?: string } }>("/api/admin/users", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const role = request.query.role === "teacher" || request.query.role === "student" ? request.query.role : undefined;
    return {
      users: deps.accounts.listUsers({
        ...(request.query.courseId ? { courseId: request.query.courseId } : {}),
        ...(request.query.q ? { query: request.query.q } : {}),
        ...(role ? { role } : {}),
      }),
    };
  });

  app.post("/api/admin/users", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = createStudentSchema.parse(request.body);
    const result = await deps.accounts.createStudent({
      username: input.username,
      displayName: input.displayName,
      courseIds: input.courseIds,
      grantedBy: teacher.id,
      ...(input.password ? { password: input.password } : {}),
    });
    return reply.code(201).send(result);
  });

  app.post("/api/admin/users/bulk-preview", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = bulkTextSchema.parse(request.body);
    return { rows: deps.accounts.previewBulkImport(input.rawText) };
  });

  app.post("/api/admin/users/bulk-import", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = bulkImportSchema.parse(request.body);
    return deps.accounts.bulkImportStudents({ ...input, grantedBy: teacher.id });
  });

  app.put<{ Params: { userId: string } }>("/api/admin/users/:userId/courses", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const userId = z.string().uuid().parse(request.params.userId);
    const input = setUserCoursesSchema.parse(request.body);
    return { user: deps.accounts.setUserCourses(userId, input.courseIds, teacher.id) };
  });

  app.patch<{ Params: { userId: string } }>("/api/admin/users/:userId/status", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const userId = z.string().uuid().parse(request.params.userId);
    const input = setUserStatusSchema.parse(request.body);
    return { user: deps.accounts.setUserStatus(userId, input.status, teacher.id) };
  });

  app.post<{ Params: { userId: string } }>("/api/admin/users/:userId/reset-password", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const userId = z.string().uuid().parse(request.params.userId);
    return deps.accounts.resetUserPassword(userId);
  });

  app.get("/api/admin/invites", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    return { invites: deps.accounts.listInviteCodes() };
  });

  app.post("/api/admin/invites", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = createInviteSchema.parse(request.body);
    const invite = deps.accounts.createInviteCode({
      label: input.label,
      courseIds: input.courseIds,
      createdBy: teacher.id,
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
    });
    return reply.code(201).send({ invite });
  });

  app.post<{ Params: { code: string } }>("/api/admin/invites/:code/revoke", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    deps.accounts.revokeInviteCode(request.params.code);
    return { ok: true };
  });

  app.get("/api/admin/sync-tokens", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    return { tokens: deps.accounts.listSyncTokens() };
  });

  app.post("/api/admin/sync-tokens", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = createSyncTokenSchema.parse(request.body);
    return reply.code(201).send(deps.accounts.createSyncToken(input.label, teacher.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/sync-tokens/:id/revoke", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    deps.accounts.revokeSyncToken(z.string().uuid().parse(request.params.id));
    return { ok: true };
  });

  // --- Teacher Quota Backend ---

  app.get("/api/admin/quotas/dashboard", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const courses = await deps.syncService.listSyncedCourses();
    return {
      courses,
      ...deps.quotas.getAdminDashboard(courses.map((c) => c.id)),
    };
  });

  app.put("/api/admin/quotas/global", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const input = updateGlobalQuotaSchema.parse(request.body);
    const settings = deps.quotas.updateGlobalSettings({
      ...(input.emergencyQaPaused !== undefined ? { emergencyQaPaused: input.emergencyQaPaused } : {}),
      ...(input.globalDailyQaLimit !== undefined ? { globalDailyQaLimit: input.globalDailyQaLimit } : {}),
      ...(input.globalDailyTokenLimit !== undefined ? { globalDailyTokenLimit: input.globalDailyTokenLimit } : {}),
    });
    return { globalSettings: settings };
  });

  app.put<{ Params: { courseId: string } }>("/api/admin/quotas/courses/:courseId", async (request, reply) => {
    const teacher = await deps.requireTeacher(request, reply);
    if (!teacher) return;
    const courseId = z.string().uuid().parse(request.params.courseId);
    const input = updateCourseQuotaSchema.parse(request.body);
    return { policy: deps.quotas.updateCoursePolicy(courseId, input) };
  });

  app.put<{ Params: { userId: string; courseId: string } }>(
    "/api/admin/quotas/users/:userId/courses/:courseId",
    async (request, reply) => {
      const teacher = await deps.requireTeacher(request, reply);
      if (!teacher) return;
      const userId = z.string().uuid().parse(request.params.userId);
      const courseId = z.string().uuid().parse(request.params.courseId);
      const input = updateStudentQuotaSchema.parse(request.body);
      const override = deps.quotas.upsertStudentOverride({
        userId,
        courseId,
        dailyQaLimit: input.dailyQaLimit,
        totalQaLimit: input.totalQaLimit,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { override };
    },
  );
}

export function isAuthOrAdminError(error: unknown): error is AuthError | AccountAdminError {
  return error instanceof AuthError || error instanceof AccountAdminError;
}
