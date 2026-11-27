import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentExecutionLimitError } from "../../core/agent-execution-budget.js";
import type { CourseQaAgentFactory } from "../../api/server.js";
import { sseComment, sseFrame } from "../../api/streaming/sse.js";
import { KnowledgeAccessError, KnowledgeService } from "../../services/knowledge-service.js";
import { SessionNotFoundError } from "../../services/session-service.js";
import type { WebEvidenceService } from "../../services/web-evidence-service.js";
import type { AuthenticatedUser } from "../services/auth-service.js";
import { QuotaExceededError, QuotaService } from "../services/quota-service.js";
import { StudentSessionService } from "../services/student-session-service.js";
import type { CourseQaTokenUsage } from "../../agents/course-qa/agent.js";

const courseIdSchema = z.string().uuid();
const sessionIdSchema = z.string().uuid();
const runIdSchema = z.string().uuid();
const titleSchema = z.object({ title: z.string().trim().min(1).max(80) });
const askSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  allowWebSearch: z.boolean().optional().default(false),
});
const lineContentQuerySchema = z.object({
  path: z.string().min(1).max(240),
  startLine: z.coerce.number().int().min(1),
  endLine: z.coerce.number().int().min(1),
});

export function registerStudentQaRoutes(
  app: FastifyInstance,
  deps: {
    workspaceRoot: string;
    quotas: QuotaService;
    courseQaAgentFactory?: CourseQaAgentFactory;
    webEvidenceFactory?: () => WebEvidenceService;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthenticatedUser | undefined>;
    requireCourseAccess: (request: FastifyRequest, reply: FastifyReply, courseId: string) => Promise<AuthenticatedUser | undefined>;
  },
): void {
  const knowledge = new KnowledgeService(deps.workspaceRoot);
  const sessions = new StudentSessionService(deps.workspaceRoot);
  const activeRuns = new Map<string, { userId: string; controller: AbortController }>();
  app.addHook("preClose", async () => {
    for (const { controller } of activeRuns.values()) controller.abort();
  });


  app.get<{ Params: { courseId: string } }>("/api/student/courses/:courseId/quota", async (request, reply) => {
    const courseId = courseIdSchema.parse(request.params.courseId);
    const user = await deps.requireCourseAccess(request, reply, courseId);
    if (!user) return;
    return {
      role: user.role,
      modelConfigured: Boolean(deps.courseQaAgentFactory),
      webSearchAvailable: Boolean(deps.webEvidenceFactory),
      quota: deps.quotas.getStudentQuotaSummary(user.id, courseId),
    };
  });

  app.get<{ Params: { courseId: string }; Querystring: { path?: string; startLine?: string; endLine?: string } }>(
    "/api/student/courses/:courseId/qa/content",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;
      const query = lineContentQuerySchema.parse(request.query);
      const courseKnowledge = await knowledge.forCourse(courseId);
      return courseKnowledge.readLines(query.path, query.startLine, query.endLine);
    },
  );

  app.post<{ Params: { runId: string } }>("/api/student/agent-runs/:runId/cancel", async (request, reply) => {
    const user = await deps.requireAuth(request, reply);
    if (!user) return;
    const runId = runIdSchema.parse(request.params.runId);
    const active = activeRuns.get(runId);
    if (!active || active.userId !== user.id) {
      return reply.code(404).send({ cancelled: false });
    }
    active.controller.abort();
    return { cancelled: true };
  });

  app.get<{ Params: { courseId: string } }>("/api/student/courses/:courseId/sessions", async (request, reply) => {
    const courseId = courseIdSchema.parse(request.params.courseId);
    const user = await deps.requireCourseAccess(request, reply, courseId);
    if (!user) return;
    return sessions.listWithDiagnostics(user.id, courseId);
  });

  app.post<{ Params: { courseId: string } }>("/api/student/courses/:courseId/sessions", async (request, reply) => {
    const courseId = courseIdSchema.parse(request.params.courseId);
    const user = await deps.requireCourseAccess(request, reply, courseId);
    if (!user) return;
    const courseKnowledge = await knowledge.forCourse(courseId);
    const session = await sessions.create(user.id, courseId, courseKnowledge.release.id);
    return reply.code(201).send(session);
  });

  app.get<{ Params: { courseId: string; sessionId: string } }>(
    "/api/student/courses/:courseId/sessions/:sessionId",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const sessionId = sessionIdSchema.parse(request.params.sessionId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;
      return sessions.get(user.id, courseId, sessionId);
    },
  );

  app.patch<{ Params: { courseId: string; sessionId: string } }>(
    "/api/student/courses/:courseId/sessions/:sessionId",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const sessionId = sessionIdSchema.parse(request.params.sessionId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;
      const { title } = titleSchema.parse(request.body);
      return sessions.rename(user.id, courseId, sessionId, title);
    },
  );

  app.delete<{ Params: { courseId: string; sessionId: string } }>(
    "/api/student/courses/:courseId/sessions/:sessionId",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const sessionId = sessionIdSchema.parse(request.params.sessionId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;
      await sessions.delete(user.id, courseId, sessionId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { courseId: string; sessionId: string } }>(
    "/api/student/courses/:courseId/sessions/:sessionId/ask",
    async (request, reply) => {
      const courseId = courseIdSchema.parse(request.params.courseId);
      const sessionId = sessionIdSchema.parse(request.params.sessionId);
      const user = await deps.requireCourseAccess(request, reply, courseId);
      if (!user) return;

      if (!deps.courseQaAgentFactory) {
        return reply.code(503).send({ code: "QA_MODEL_NOT_CONFIGURED", message: "管理员尚未配置答疑模型服务" });
      }

      const { question, allowWebSearch } = askSchema.parse(request.body);
      const existingSession = await sessions.get(user.id, courseId, sessionId);
      const courseKnowledge = await knowledge.forCourse(courseId);

      if (reply.raw.destroyed) return reply.hijack();

      // Reserve quota before starting model execution (teachers bypass quota deduction)
      let ledgerId: string | undefined;
      if (user.role === "student") {
        try {
          ledgerId = deps.quotas.reserveQuota({ userId: user.id, courseId, sessionId });
        } catch (error) {
          if (error instanceof QuotaExceededError) {
            return reply.code(error.statusCode).send({ code: error.code, message: error.message });
          }
          throw error;
        }
      }

      const runId = randomUUID();
      const controller = new AbortController();
      activeRuns.set(runId, { userId: user.id, controller });

      const onClose = () => controller.abort();
      reply.raw.once("close", onClose);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-agent-run-id": runId,
      });
      reply.raw.flushHeaders?.();
      const emit = (event: string, data: unknown) => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.write(sseFrame(event, data));
        }
      };

      const keepAlive = setInterval(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(sseComment("keepalive"));
      }, 15_000);

      emit("ready", { runId });

      const historyPrefix = existingSession.messages.length > 0
        ? `以下是本会话的先前问答上下文（仅作指代参考，不能替代课程证据）：\n${existingSession.messages
            .slice(-6)
            .map((m) => `${m.role === "user" ? "学生" : "助教"}：${m.content}`)
            .join("\n")}\n\n当前问题：`
        : "";

      let usage: CourseQaTokenUsage | undefined;
      try {
        const web = allowWebSearch ? deps.webEvidenceFactory?.() : undefined;
        const agent = deps.courseQaAgentFactory(courseKnowledge, web);
        const answer = await agent.answer(
          `${historyPrefix}${question}`,
          (event) => emit(event.type, event),
          controller.signal,
          (collected) => {
            usage = collected;
          },
        );

        if (controller.signal.aborted) {
          if (ledgerId) deps.quotas.refundQuota(ledgerId, "client_aborted");
          return reply;
        }

        // Re-verify active release did not switch mid-answer
        const latestKnowledge = await knowledge.forCourse(courseId);
        if (latestKnowledge.release.id !== courseKnowledge.release.id) {
          if (ledgerId) deps.quotas.refundQuota(ledgerId, "release_changed");
          emit("error", {
            code: "RELEASE_CHANGED",
            message: "课程资料在回答期间已更新，本次不扣减额度，请重新提问",
          });
          return reply;
        }

        if (controller.signal.aborted) {
          if (ledgerId) deps.quotas.refundQuota(ledgerId, "client_aborted");
          return reply;
        }
        const updatedSession = await sessions.appendCompletedTurn(
          user.id,
          courseId,
          sessionId,
          { role: "user", content: question },
          {
            role: "assistant",
            content: answer.answer,
            citations: answer.citations,
            ...(answer.insufficient ? { insufficient: true } : {}),
          },
          controller.signal,
        );
        if (ledgerId) deps.quotas.completeQuota(ledgerId, usage);
        const quota = deps.quotas.getStudentQuotaSummary(user.id, courseId);
        emit("final", { answer, session: updatedSession, quota });
      } catch (error) {
        if (ledgerId) {
          deps.quotas.refundQuota(ledgerId, controller.signal.aborted ? "client_aborted" : "agent_error");
        }
        if (!controller.signal.aborted) {
          if (error instanceof KnowledgeAccessError) {
            emit("error", { code: error.code, message: error.message });
          } else if (error instanceof SessionNotFoundError) {
            emit("error", { code: "SESSION_NOT_FOUND", message: "会话不存在" });
          } else if (error instanceof AgentExecutionLimitError) {
            emit("error", { code: error.code, message: error.message });
          } else {
            emit("error", { code: "QA_FAILED", message: "答疑处理未能完成，本次不扣减额度，请稍后重试" });
          }
        }
      } finally {
        clearInterval(keepAlive);
        reply.raw.removeListener("close", onClose);
        activeRuns.delete(runId);
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
      }
      return reply;
    },
  );
}
