import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { sseComment, sseFrame } from "./streaming/sse.js";
import type { PiCourseQaAgent } from "../agents/course-qa/agent.js";
import { type CourseQaEvent } from "../schemas/qa-stream.js";
import { KnowledgeAccessError, KnowledgeService } from "../services/knowledge-service.js";
import { DashboardService } from "../services/dashboard-service.js";
import { SessionNotFoundError, SessionService } from "../services/session-service.js";
import type { WebEvidenceService } from "../services/web-evidence-service.js";
import {
  KnowledgeReleaseError,
  MaterialService,
  type KnowledgePlan,
  type SourceSection,
} from "../services/material-service.js";

export type MaterialPlanner = (sections: SourceSection[]) => Promise<KnowledgePlan>;
export type CourseQaAgentFactory = (knowledge: Awaited<ReturnType<KnowledgeService["forCourse"]>>, web?: WebEvidenceService) => PiCourseQaAgent;

export interface ServerOptions {
  workspaceRoot: string;
  materialPlanner?: MaterialPlanner;
  courseQaAgentFactory?: CourseQaAgentFactory;
  webEvidenceFactory?: () => WebEvidenceService;
  modelStatus?: { provider: string; model: string; configured: boolean };
}

const createCourseSchema = z.object({ name: z.string().trim().min(1).max(100) });
const importSchema = z.object({
  files: z.array(z.object({
    relativePath: z.string().min(1).max(240),
    content: z.string().max(10 * 1024 * 1024),
  })).min(1).max(200),
});
const publishSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/) });
const activateSchema = z.object({ releaseId: z.string().uuid() });
const questionSchema = z.object({ question: z.string().trim().min(1).max(4_000), allowWebSearch: z.boolean().optional().default(false) });
const sessionTitleSchema = z.object({ title: z.string().trim().min(1).max(80) });
const editSchema = z.object({
  expectedVersion: z.number().int().positive(),
  operations: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("rename"), path: z.string().min(1), name: z.string().min(1).max(160) }),
    z.object({ type: z.literal("move"), path: z.string().min(1), directory: z.string().min(1).max(200) }),
    z.object({ type: z.literal("delete"), path: z.string().min(1) }),
  ])).min(1).max(20),
});
const contentEditSchema = z.object({
  expectedVersion: z.number().int().positive(),
  path: z.string().min(1).max(240),
  content: z.string().max(10 * 1024 * 1024),
});

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const materials = new MaterialService(options.workspaceRoot);
  const knowledge = new KnowledgeService(options.workspaceRoot);
  const sessions = new SessionService(options.workspaceRoot);
  const modelStatus = options.modelStatus ?? { provider: "deepseek", model: "deepseek-v4-flash", configured: false };
  const dashboard = new DashboardService(options.workspaceRoot, modelStatus);
  const planner = options.materialPlanner ?? defaultPlanner;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: "VALIDATION_ERROR", message: "Request validation failed" });
    if (error instanceof KnowledgeAccessError) return reply.code(error.code === "ACTIVE_RELEASE_NOT_FOUND" ? 409 : 422).send({ code: error.code, message: error.message });
    if (error instanceof SessionNotFoundError) return reply.code(404).send({ code: "SESSION_NOT_FOUND", message: error.message });
    if (error instanceof KnowledgeReleaseError) return reply.code(error.message.includes("changed") ? 409 : 422).send({ code: error.message.includes("changed") ? "CONFLICT" : "KNOWLEDGE_ERROR", message: error.message });
    const requestError = error as NodeJS.ErrnoException & { statusCode?: unknown };
    if (typeof requestError.statusCode === "number" && requestError.statusCode >= 400 && requestError.statusCode < 500) {
      return reply.code(requestError.statusCode).send({ code: requestError.code ?? "REQUEST_ERROR", message: "Request validation failed" });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ code: "NOT_FOUND", message: "The requested resource does not exist" });
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Unexpected server error" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/system/model", async () => modelStatus);
  app.get("/api/dashboard", async () => dashboard.snapshot());
  app.get("/api/courses", async () => materials.listCourses());
  app.post("/api/courses", async (request, reply) => {
    const course = await materials.createCourse(createCourseSchema.parse(request.body).name);
    return reply.code(201).send(course);
  });

  app.post("/api/courses/:courseId/imports", async (request, reply) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    const payload = importSchema.parse(request.body);
    const imported = await materials.createImport(courseId, payload.files);
    const draft = await materials.renderPlan(courseId, imported.id, await planner(await materials.getSourceSections(courseId, imported.id)));
    return reply.code(201).send({ ...imported, draftVersion: draft.version, manifestHash: draft.manifestHash, status: "ready" });
  });

  app.get("/api/courses/:courseId/imports/:importId", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    return materials.getImport(courseId, importId);
  });
  app.get("/api/courses/:courseId/imports/:importId/tree", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    return materials.getDraft(courseId, importId);
  });
  app.get("/api/courses/:courseId/imports/:importId/content", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    const { path: relativePath } = z.object({ path: z.string().min(1).max(240) }).parse(request.query);
    return { content: await materials.readDraftContent(courseId, importId, relativePath) };
  });
  app.patch("/api/courses/:courseId/imports/:importId/content", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    const payload = contentEditSchema.parse(request.body);
    return materials.updateDraftContent(courseId, importId, payload.expectedVersion, payload.path, payload.content);
  });
  app.patch("/api/courses/:courseId/imports/:importId/tree", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    const payload = editSchema.parse(request.body);
    return materials.editDraft(courseId, importId, payload.expectedVersion, payload.operations);
  });
  app.post("/api/courses/:courseId/imports/:importId/rerun", async (request) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    return materials.renderPlan(courseId, importId, await planner(await materials.getSourceSections(courseId, importId)));
  });
  app.post("/api/courses/:courseId/imports/:importId/publish", async (request, reply) => {
    const { courseId, importId } = z.object({ courseId: z.string().uuid(), importId: z.string().uuid() }).parse(request.params);
    const payload = publishSchema.parse(request.body);
    return reply.code(201).send(await materials.publish(courseId, importId, payload.expectedVersion, payload.expectedManifestHash));
  });

  app.get("/api/courses/:courseId/releases", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    return materials.listReleases(courseId);
  });
  app.get("/api/courses/:courseId/drafts", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    return materials.listDrafts(courseId);
  });
  app.get("/api/courses/:courseId/active", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    return materials.getActiveRelease(courseId);
  });
  app.post("/api/courses/:courseId/active", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    return materials.activateRelease(courseId, activateSchema.parse(request.body).releaseId);
  });
  app.get("/api/courses/:courseId/releases/:releaseId/tree", async (request) => {
    const { courseId, releaseId } = z.object({ courseId: z.string().uuid(), releaseId: z.string().uuid() }).parse(request.params);
    return materials.getReleaseTree(courseId, releaseId);
  });
  app.post("/api/courses/:courseId/releases/:releaseId/revisions", async (request, reply) => {
    const { courseId, releaseId } = z.object({ courseId: z.string().uuid(), releaseId: z.string().uuid() }).parse(request.params);
    const { imported, draft } = await materials.createRevisionDraft(courseId, releaseId);
    return reply.code(201).send({
      ...imported,
      draftVersion: draft.version,
      manifestHash: draft.manifestHash,
      tree: draft.tree,
    });
  });
  app.get("/api/courses/:courseId/releases/:releaseId/content", async (request) => {
    const { courseId, releaseId } = z.object({ courseId: z.string().uuid(), releaseId: z.string().uuid() }).parse(request.params);
    const { path: relativePath } = z.object({ path: z.string().min(1).max(240) }).parse(request.query);
    return { content: await materials.readReleaseContent(courseId, releaseId, relativePath) };
  });

  app.post("/api/courses/:courseId/qa/sessions", async (request, reply) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    const courseKnowledge = await knowledge.forCourse(courseId);
    return reply.code(201).send(await sessions.create(courseId, courseKnowledge.release.id));
  });
  app.get("/api/courses/:courseId/qa/sessions", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    return sessions.list(courseId);
  });
  app.get("/api/courses/:courseId/qa/active", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    const courseKnowledge = await knowledge.forCourse(courseId);
    return { releaseId: courseKnowledge.release.id, documents: courseKnowledge.documents };
  });
  app.get("/api/courses/:courseId/qa/sessions/:sessionId", async (request) => {
    const { courseId, sessionId } = z.object({ courseId: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    return sessions.get(courseId, sessionId);
  });
  app.patch("/api/courses/:courseId/qa/sessions/:sessionId", async (request) => {
    const { courseId, sessionId } = z.object({ courseId: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    return sessions.rename(courseId, sessionId, sessionTitleSchema.parse(request.body).title);
  });
  app.delete("/api/courses/:courseId/qa/sessions/:sessionId", async (request, reply) => {
    const { courseId, sessionId } = z.object({ courseId: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    await sessions.delete(courseId, sessionId);
    return reply.code(204).send();
  });
  app.get("/api/courses/:courseId/qa/active/content", async (request) => {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.params);
    const payload = z.object({ path: z.string().min(1).max(240), startLine: z.coerce.number().int().min(1), endLine: z.coerce.number().int().min(1) }).parse(request.query);
    return (await knowledge.forCourse(courseId)).readLines(payload.path, payload.startLine, payload.endLine);
  });
  app.post("/api/courses/:courseId/qa/sessions/:sessionId/messages/stream", async (request, reply) => {
    const { courseId, sessionId } = z.object({ courseId: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    const { question, allowWebSearch } = questionSchema.parse(request.body);
    const session = await sessions.get(courseId, sessionId);
    const courseKnowledge = await knowledge.forCourse(courseId);
    if (session.releaseId !== courseKnowledge.release.id) return reply.code(409).send({ code: "SESSION_RELEASE_CHANGED", message: "Create a new session for the current knowledge release" });
    if (!options.courseQaAgentFactory) return reply.code(503).send({ code: "MODEL_NOT_CONFIGURED", message: "The course QA model is not configured" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(sseComment("course-qa"));
    const controller = new AbortController();
    const abortOnClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.once("close", abortOnClose);
    const keepAlive = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(sseComment("keep-alive")); }, 15_000);
    const emit = (event: CourseQaEvent) => { if (!controller.signal.aborted && !reply.raw.writableEnded) reply.raw.write(sseFrame(event.type, event)); };
    try {
      const web = allowWebSearch ? options.webEvidenceFactory?.() : undefined;
      const answer = await options.courseQaAgentFactory(courseKnowledge, web).answer(question, emit, controller.signal);
      if (!controller.signal.aborted) {
        await sessions.appendCompletedTurn(courseId, sessionId, { role: "user", content: question }, { role: "assistant", content: answer.answer, citations: answer.citations, ...(answer.insufficient ? { insufficient: true } : {}) });
        emit({ type: "final", ...answer, releaseId: courseKnowledge.release.id, sessionId });
      }
    } catch (error) {
      if (!controller.signal.aborted) emit({ type: "error", code: "QA_FAILED", message: "The course answer could not be completed" });
    } finally {
      clearInterval(keepAlive);
      request.raw.removeListener("close", abortOnClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  return app;
}

async function defaultPlanner(sections: SourceSection[]): Promise<KnowledgePlan> {
  return {
    documents: sections.map((section, index) => ({
      path: `资料/${String(index + 1).padStart(2, "0")}-${slug(section.title)}.md`,
      title: section.title,
      sectionIds: [section.id],
    })),
  };
}

function slug(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 50);
  return normalized || "未命名";
}
