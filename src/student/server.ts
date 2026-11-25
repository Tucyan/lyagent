import { access } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { CourseQaAgentFactory } from "../api/server.js";
import { KnowledgeAccessError } from "../services/knowledge-service.js";
import { SessionNotFoundError } from "../services/session-service.js";
import type { WebEvidenceService } from "../services/web-evidence-service.js";
import type { StudentServerConfig } from "./config.js";
import { openStudentDatabase } from "./db/student-db.js";
import { isAuthOrAdminError, registerAuthAndAdminRoutes, SESSION_COOKIE_NAME } from "./routes/auth-and-admin-routes.js";
import { registerStudentKnowledgeRoutes } from "./routes/student-knowledge-routes.js";
import { registerStudentQaRoutes } from "./routes/student-qa-routes.js";
import { registerStudentSyncRoutes } from "./routes/sync-routes.js";
import { AccountAdminService } from "./services/account-admin-service.js";
import { StudentAuthService, type AuthenticatedUser } from "./services/auth-service.js";
import { KnowledgeSyncService } from "./services/knowledge-sync-service.js";
import { QuotaExceededError, QuotaService } from "./services/quota-service.js";

export interface StudentServerOptions {
  config: StudentServerConfig;
  courseQaAgentFactory?: CourseQaAgentFactory;
  webEvidenceFactory?: () => WebEvidenceService;
  now?: () => Date;
}

export async function createStudentServer(options: StudentServerOptions): Promise<{
  app: FastifyInstance;
  auth: StudentAuthService;
  accounts: AccountAdminService;
  quotas: QuotaService;
  syncService: KnowledgeSyncService;
  close: () => Promise<void>;
}> {
  const { config } = options;
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });
  const db = openStudentDatabase(config.workspaceRoot, () => (options.now ? options.now() : new Date()).toISOString());
  const auth = new StudentAuthService(db, {
    sessionTtlHours: config.sessionTtlHours,
    ...(options.now ? { now: options.now } : {}),
  });
  await auth.ensureBootstrapAdmin(config.bootstrapAdmin);

  const accounts = new AccountAdminService(db, auth, options.now);
  const quotas = new QuotaService(db, {
    timeZone: config.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  quotas.refundOrphanedReservations();

  const syncService = new KnowledgeSyncService(config.workspaceRoot);

  const getSessionToken = (request: FastifyRequest): string | undefined => {
    const cookies = parseCookieHeader(request.headers.cookie);
    return cookies[SESSION_COOKIE_NAME];
  };

  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, token: string, expiresAt: string) => {
    const maxAge = Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    const secureFlag = isHttpsRequest(request) ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
    );
  };

  const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply) => {
    const secureFlag = isHttpsRequest(request) ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`,
    );
  };

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | undefined> => {
    const user = auth.authenticateToken(getSessionToken(request));
    if (!user) {
      await reply.code(401).send({ code: "UNAUTHORIZED", message: "请先登录账号" });
      return undefined;
    }
    return user;
  };

  const requireTeacher = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | undefined> => {
    const user = await requireAuth(request, reply);
    if (!user) return undefined;
    if (user.role !== "teacher") {
      await reply.code(403).send({ code: "FORBIDDEN", message: "仅教师管理员可执行此操作" });
      return undefined;
    }
    return user;
  };

  const requireCourseAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    courseId: string,
  ): Promise<AuthenticatedUser | undefined> => {
    const user = await requireAuth(request, reply);
    if (!user) return undefined;
    if (!accounts.hasCourseAccess(user, courseId)) {
      await reply.code(403).send({ code: "COURSE_ACCESS_DENIED", message: "您暂无该课程的访问权限，请联系授课教师" });
      return undefined;
    }
    return user;
  };

  // Origin check for browser state-changing requests
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/sync/")) return;
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (config.publicOrigin) {
      if (origin !== config.publicOrigin) {
        return reply.code(403).send({ code: "FORBIDDEN", message: "请求来源不被允许" });
      }
      return;
    }
    const reqHost = request.headers.host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reply.code(403).send({ code: "FORBIDDEN", message: "非法的请求来源" });
    }
    if (reqHost && originHost !== reqHost && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "跨源请求被拒绝" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "请求参数无效，请检查输入内容",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (isAuthOrAdminError(error)) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error instanceof QuotaExceededError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error instanceof KnowledgeAccessError) {
      return reply.code(error.code === "ACTIVE_RELEASE_NOT_FOUND" ? 409 : 422).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof SessionNotFoundError) {
      return reply.code(404).send({ code: "SESSION_NOT_FOUND", message: "答疑会话不存在" });
    }
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "服务内部错误，请稍后重试" });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "student-portal",
    modelConfigured: Boolean(options.courseQaAgentFactory),
  }));

  registerStudentSyncRoutes(app, { accounts, syncService });
  registerAuthAndAdminRoutes(app, {
    auth,
    accounts,
    syncService,
    quotas,
    getSessionToken,
    setSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireTeacher,
  });
  registerStudentKnowledgeRoutes(app, {
    workspaceRoot: config.workspaceRoot,
    accounts,
    requireAuth,
    requireCourseAccess,
  });
  registerStudentQaRoutes(app, {
    workspaceRoot: config.workspaceRoot,
    quotas,
    requireAuth,
    requireCourseAccess,
    ...(options.courseQaAgentFactory ? { courseQaAgentFactory: options.courseQaAgentFactory } : {}),
    ...(options.webEvidenceFactory ? { webEvidenceFactory: options.webEvidenceFactory } : {}),
  });

  return {
    app,
    auth,
    accounts,
    quotas,
    syncService,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

export async function registerStudentWebAssets(app: FastifyInstance, distRoot: string): Promise<void> {
  try {
    await access(path.join(distRoot, "index.html"));
  } catch {
    return;
  }
  await app.register(fastifyStatic, { root: distRoot, wildcard: false });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/assets/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "API route was not found" });
    }
    reply.header("cache-control", "no-store");
    return reply.sendFile("index.html");
  });
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

function isHttpsRequest(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const forwarded = request.headers["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.split(",")[0]?.trim().toLowerCase() === "https";
}
