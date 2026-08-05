import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
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
import type { PiRubricDesigner, RubricDesignEvent, RubricDesignerOutcome } from "../agents/rubric-designer/agent.js";
import { rubricSchema, validateRubric, type Rubric } from "../schemas/rubric.js";
import { RUBRIC_SAFE_PROCESS_SUMMARY, RubricConflictError, RubricService, RubricServiceError, RubricValidationError, type RubricConversationTool } from "../services/rubric-service.js";
import { registerGradingApi } from "./grading-routes.js";
import { StudentIdentityError, type StudentIdentityClient } from "../services/student-identity-service.js";
import type { DocumentConversionClient } from "../services/document-conversion-client.js";
import type { SubmissionConversionOptions } from "../services/submission-conversion-service.js";
import type { GradingAgentBuilder } from "./grading-routes.js";
import { GradingConflictError, GradingSessionError, GradingSessionNotFoundError, UnsupportedSubmissionTypeError } from "../services/grading-session-service.js";
import { GradingDraftConflictError, GradingResultServiceError, GradingReviewRequiredError } from "../services/grading-result-service.js";
import { GradingResultValidationError } from "../schemas/grading.js";
import { GradingBatchConflictError, GradingBatchError } from "../services/grading-batch-service.js";
import { ModelConfigService, ModelConfigurationError } from "../services/model-config-service.js";
import { modelBaseUrlSchema } from "../config/model-base-url.js";
import { modelProviderIdSchema } from "../config/app-config.js";

export type MaterialPlanner = (sections: SourceSection[]) => Promise<KnowledgePlan>;
export type CourseQaAgentFactory = (knowledge: Awaited<ReturnType<KnowledgeService["forCourse"]>>, web?: WebEvidenceService) => PiCourseQaAgent;
export type RubricDesignerFactory = (assignmentId: string, rubricService: RubricService) => PiRubricDesigner;

class RubricCourseBindingError extends Error {
  constructor() {
    super("Exactly one course is required to create a rubric assignment");
    this.name = "RubricCourseBindingError";
  }
}

export interface ServerOptions {
  workspaceRoot: string;
  materialPlanner?: MaterialPlanner;
  courseQaAgentFactory?: CourseQaAgentFactory;
  webEvidenceFactory?: () => WebEvidenceService;
  rubricDesignerFactory?: RubricDesignerFactory;
  studentIdentityClient?: StudentIdentityClient;
  mineruConversionClient?: DocumentConversionClient;
  submissionConversionOptions?: SubmissionConversionOptions;
  gradingAgentFactory?: GradingAgentBuilder;
  submissionTitleAgentFactory?: GradingAgentBuilder;
  modelStatus?: { provider: string; model: string; configured: boolean };
  modelConfigService?: ModelConfigService;
  modelApiSecurity?: {
    csrfToken: string;
    allowedOrigin: string;
    isLoopback(request: FastifyRequest): boolean;
  };
  runtimeStatus?: {
    appVersion: string; appPort: number; workspaceConfigured: boolean;
    mineru: { status: "starting" | "ready" | "unavailable"; version?: string; backend: "hybrid-engine" | "pipeline"; port: number };
  };
  requestRestart?: () => void;
  scheduleRestart?: (restart: () => void) => void;
  runtimeOwnerToken?: string;
}

const modelEndpointInputSchema = z.object({
  providerId: modelProviderIdSchema,
  modelId: z.string().trim().min(1).max(160),
  baseUrl: modelBaseUrlSchema,
  apiKey: z.string().trim().min(1).max(20_000).optional(),
}).strict();
const modelSettingsInputSchema = z.object({ primary: modelEndpointInputSchema, vision: modelEndpointInputSchema.optional() }).strict();

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
const rubricAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  totalScore: z.number().positive(),
  requirements: z.string().trim().max(100_000).default(""),
  sources: z.array(z.object({ role: z.enum(["rubric_draft", "note"]), name: z.string().trim().min(1).max(160), content: z.string().max(1024 * 1024) })).max(10).default([]),
});
const rubricAssignmentIdSchema = z.object({ assignmentId: z.string().uuid() });
const rubricVersionParamsSchema = z.object({ assignmentId: z.string().uuid(), version: z.coerce.number().int().positive() });
const rubricModeSchema = z.object({ mode: z.enum(["additive", "deductive", "hybrid"]) });
const rubricDraftSchema = z.object({ expectedVersion: z.number().int().nonnegative(), rubric: z.unknown() });
const rubricValueSchema = z.object({ rubric: z.unknown() });
const rubricFreezeSchema = z.object({ expectedVersion: z.number().int().positive(), acknowledgedWarningCodes: z.array(z.string().min(1).max(120)).max(100) });
const rubricChatSchema = z.object({ message: z.string().trim().min(1).max(8_000) });
const rubricTitleSchema = z.object({ title: z.string().trim().min(1).max(120) });

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const setupRequired = options.modelConfigService ? !(await options.modelConfigService.status()).primary.configured : false;
  const materials = new MaterialService(options.workspaceRoot);
  const knowledge = new KnowledgeService(options.workspaceRoot);
  const sessions = new SessionService(options.workspaceRoot);
  const rubrics = new RubricService(options.workspaceRoot);
  const modelStatus = options.modelStatus ?? { provider: "deepseek", model: "deepseek-v4-flash", configured: false };
  const dashboard = new DashboardService(options.workspaceRoot, modelStatus);
  const gradingApi = registerGradingApi(app, {
    workspaceRoot: options.workspaceRoot,
    rubrics,
    ...(options.studentIdentityClient ? { identityClient: options.studentIdentityClient } : {}),
    ...(options.mineruConversionClient ? { conversionClient: options.mineruConversionClient } : {}),
    ...(options.submissionConversionOptions ? { conversionOptions: options.submissionConversionOptions } : {}),
    ...(options.gradingAgentFactory ? { gradingAgentFactory: options.gradingAgentFactory } : {}),
    ...(options.submissionTitleAgentFactory ? { submissionTitleAgentFactory: options.submissionTitleAgentFactory } : {}),
  });
  const planner = options.materialPlanner ?? defaultPlanner;
  const activeAgentRuns = new Map<string, AbortController>();
  app.addHook("onRequest", async (request, reply) => {
    if (!options.modelConfigService || !request.url.startsWith("/api/") || request.url === "/api/health" || request.url.startsWith("/api/system/model") || request.url === "/api/system/runtime") return;
    if (setupRequired) return reply.code(503).send({ code: "SETUP_REQUIRED", message: "请先完成主模型设置" });
  });
  const startupCourses = await materials.listCourses();
  if (startupCourses.length === 1) await rubrics.bindUnboundAssignments(startupCourses[0]!.id);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: "VALIDATION_ERROR", message: "Request validation failed", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof KnowledgeAccessError) return reply.code(error.code === "ACTIVE_RELEASE_NOT_FOUND" ? 409 : 422).send({ code: error.code, message: error.message });
    if (error instanceof SessionNotFoundError) return reply.code(404).send({ code: "SESSION_NOT_FOUND", message: error.message });
    if (error instanceof KnowledgeReleaseError) return reply.code(error.message.includes("changed") ? 409 : 422).send({ code: error.message.includes("changed") ? "CONFLICT" : "KNOWLEDGE_ERROR", message: error.message });
    if (error instanceof RubricConflictError) return reply.code(409).send({ code: "RUBRIC_CONFLICT", message: "The rubric draft has changed; refresh and try again" });
    if (error instanceof RubricCourseBindingError) return reply.code(422).send({ code: "RUBRIC_COURSE_BINDING_ERROR", message: error.message });
    if (error instanceof RubricValidationError) return reply.code(422).send({ code: "RUBRIC_VALIDATION_FAILED", errors: error.validation.errors, warnings: error.validation.warnings });
    if (error instanceof RubricServiceError) {
      if (error.message.includes("was not found")) return reply.code(404).send({ code: "RUBRIC_NOT_FOUND", message: "The requested rubric session does not exist" });
      return reply.code(422).send({ code: "RUBRIC_STATE_ERROR", message: "The rubric request is not valid for the current session state" });
    }
    if (error instanceof UnsupportedSubmissionTypeError) return reply.code(415).send({ code: error.code, message: error.message });
    if (error instanceof StudentIdentityError) return reply.code(422).send({ code: "STUDENT_IDENTITY_ERROR", message: error.message });
    if (error instanceof GradingSessionNotFoundError) return reply.code(404).send({ code: "GRADING_SESSION_NOT_FOUND", message: error.message });
    if (error instanceof GradingConflictError || error instanceof GradingDraftConflictError) return reply.code(409).send({ code: "GRADING_CONFLICT", message: error.message });
    if (error instanceof GradingBatchConflictError) return reply.code(409).send({ code: "GRADING_BATCH_CONFLICT", message: error.message });
    if (error instanceof GradingBatchError) return reply.code(422).send({ code: "GRADING_BATCH_ERROR", message: error.message });
    if (error instanceof GradingResultValidationError) return reply.code(422).send({ code: "GRADING_RESULT_INVALID", message: error.message });
    if (error instanceof ModelConfigurationError) return reply.code(422).send({ code: "MODEL_CONFIGURATION_FAILED", message: "The model configuration could not be verified" });
    if (error instanceof GradingReviewRequiredError || error instanceof GradingResultServiceError || error instanceof GradingSessionError) return reply.code(422).send({ code: "GRADING_ERROR", message: error.message });
    const requestError = error as NodeJS.ErrnoException & { statusCode?: unknown };
    if (typeof requestError.statusCode === "number" && requestError.statusCode >= 400 && requestError.statusCode < 500) {
      return reply.code(requestError.statusCode).send({ code: requestError.code ?? "REQUEST_ERROR", message: "Request validation failed" });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ code: "NOT_FOUND", message: "The requested resource does not exist" });
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Unexpected server error" });
  });

  app.get("/api/health", async (_request, reply) => {
    if (options.runtimeOwnerToken) reply.header("x-course-agent-owner", options.runtimeOwnerToken);
    return { ok: true, ...(options.runtimeStatus ? { ready: options.runtimeStatus.mineru.status === "ready" } : {}), ...(options.runtimeOwnerToken ? { instanceId: options.runtimeOwnerToken } : {}) };
  });
  app.get("/api/system/runtime", async () => options.runtimeStatus ?? ({
    appVersion: "0.1.0", appPort: 0, mineru: { status: "unavailable", backend: "pipeline", port: 0 }, workspaceConfigured: false,
  }));
  app.post("/api/agent-runs/:runId/cancel", async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const controller = activeAgentRuns.get(runId);
    if (!controller) {
      const cancelled = await gradingApi.cancel(runId);
      return cancelled === undefined ? reply.code(404).send({ cancelled: false }) : { cancelled };
    }
    controller.abort();
    return { cancelled: true };
  });
  app.get("/api/system/models", async (_request, reply) => {
    if (options.modelApiSecurity) {
      reply.header("cache-control", "no-store");
      reply.header("x-csrf-token", options.modelApiSecurity.csrfToken);
    }
    return options.modelConfigService ? options.modelConfigService.status() : ({ primary: { providerId: modelStatus.provider, modelId: modelStatus.model, baseUrl: "https://api.deepseek.com", configured: modelStatus.configured } });
  });
  app.post("/api/system/models/test", async (request, reply) => {
    if (!authorizeModelWrite(request, options.modelApiSecurity)) return reply.code(403).send({ code: "FORBIDDEN", message: "Model settings writes are allowed only from the local application" });
    if (!options.modelConfigService) return reply.code(503).send({ code: "MODEL_SETTINGS_UNAVAILABLE", message: "Model settings are unavailable" });
    return options.modelConfigService.test(modelSettingsInputSchema.parse(request.body));
  });
  app.put("/api/system/models", async (request, reply) => {
    if (!authorizeModelWrite(request, options.modelApiSecurity)) return reply.code(403).send({ code: "FORBIDDEN", message: "Model settings writes are allowed only from the local application" });
    if (!options.modelConfigService) return reply.code(503).send({ code: "MODEL_SETTINGS_UNAVAILABLE", message: "Model settings are unavailable" });
    const saved = await options.modelConfigService.save(modelSettingsInputSchema.parse(request.body));
    const response = { ...saved, restartScheduled: Boolean(options.requestRestart), ...(options.runtimeOwnerToken ? { instanceId: options.runtimeOwnerToken } : {}) };
    if (options.requestRestart) reply.raw.once("finish", () => (options.scheduleRestart ?? ((restart) => setTimeout(restart, 50)))(options.requestRestart!));
    reply.send(response);
    return reply;
  });
  app.get("/api/system/model", async () => {
    if (!options.modelConfigService) return modelStatus;
    const status = (await options.modelConfigService.status()).primary;
    return { provider: status.providerId, model: status.modelId, configured: status.configured };
  });
  app.get("/api/dashboard", async () => dashboard.snapshot());
  app.get("/api/rubrics/assignments", async () => rubrics.listAssignments());
  app.post("/api/rubrics/assignments", async (request, reply) => {
    const courses = await materials.listCourses();
    if (courses.length !== 1) throw new RubricCourseBindingError();
    return reply.code(201).send(await rubrics.createAssignment({ ...rubricAssignmentSchema.parse(request.body), courseId: courses[0]!.id }));
  });
  app.get("/api/rubrics/assignments/:assignmentId", async (request) => rubrics.getAssignment(rubricAssignmentIdSchema.parse(request.params).assignmentId));
  app.get("/api/rubrics/assignments/:assignmentId/session", async (request) => (await rubrics.getDesignSession(rubricAssignmentIdSchema.parse(request.params).assignmentId)) ?? null);
  app.patch("/api/rubrics/assignments/:assignmentId", async (request) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    return rubrics.renameAssignment(assignmentId, rubricTitleSchema.parse(request.body).title);
  });
  app.delete("/api/rubrics/assignments/:assignmentId", async (request, reply) => {
    await rubrics.deleteAssignment(rubricAssignmentIdSchema.parse(request.params).assignmentId);
    return reply.code(204).send();
  });
  app.get("/api/rubrics/assignments/:assignmentId/recommendations", async (request) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const assignment = await rubrics.getAssignment(assignmentId);
    if (assignment.sources.length === 0 || !options.rubricDesignerFactory) return { source: "static" as const, ...staticRubricRecommendation() };
    try {
      const sources = await Promise.all(assignment.sources.map((source) => rubrics.readSource(assignmentId, source.id)));
      return { source: "model" as const, ...(await options.rubricDesignerFactory(assignmentId, rubrics).recommendModes(sources)) };
    } catch {
      return { source: "static" as const, ...staticRubricRecommendation() };
    }
  });
  app.put("/api/rubrics/assignments/:assignmentId/mode", async (request) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const session = await rubrics.selectMode(assignmentId, rubricModeSchema.parse(request.body).mode);
    return { ...session, state: options.rubricDesignerFactory ? "ready" : "manual" };
  });
  app.put("/api/rubrics/assignments/:assignmentId/mode/stream", async (request, reply) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const { mode } = rubricModeSchema.parse(request.body);
    await assertRubricCanOpenDraft(rubrics, assignmentId);
    await rubrics.selectMode(assignmentId, mode);
    if (!options.rubricDesignerFactory) {
      const assignment = await rubrics.getAssignment(assignmentId);
      const draft = (await rubrics.getDraft(assignmentId)) ?? await rubrics.createDraft(assignmentId, manualRubric(mode, assignment.totalScore));
      return { selectedMode: mode, state: "manual", draft };
    }
    return streamRubricDesign(request, reply, options.rubricDesignerFactory(assignmentId, rubrics), "请根据当前作业要求和参考资料生成第一版评分表。", (outcome) => persistRubricDesignOutcome(rubrics, assignmentId, outcome), (user, assistant) => rubrics.appendConversationTurn(assignmentId, user, assistant), activeAgentRuns);
  });
  app.get("/api/rubrics/assignments/:assignmentId/draft", async (request) => (await rubrics.getDraft(rubricAssignmentIdSchema.parse(request.params).assignmentId)) ?? null);
  app.put("/api/rubrics/assignments/:assignmentId/draft", async (request) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const payload = rubricDraftSchema.parse(request.body);
    const parsed = rubricSchema.parse(payload.rubric);
    if (payload.expectedVersion === 0) return rubrics.createDraft(assignmentId, parsed);
    return rubrics.replaceDraft(assignmentId, payload.expectedVersion, parsed);
  });
  app.post("/api/rubrics/assignments/:assignmentId/validate", async (request, reply) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    await rubrics.getAssignment(assignmentId);
    const rubric = rubricSchema.parse(rubricValueSchema.parse(request.body).rubric);
    const validation = validateRubric(rubric);
    if (validation.errors.length > 0) return reply.code(422).send({ code: "RUBRIC_VALIDATION_FAILED", ...validation });
    return validation;
  });
  app.post("/api/rubrics/assignments/:assignmentId/freeze", async (request, reply) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const payload = rubricFreezeSchema.parse(request.body);
    return reply.code(201).send(await rubrics.freeze(assignmentId, payload.expectedVersion, payload.acknowledgedWarningCodes));
  });
  app.get("/api/rubrics/assignments/:assignmentId/versions", async (request) => rubrics.listVersions(rubricAssignmentIdSchema.parse(request.params).assignmentId));
  app.get("/api/rubrics/assignments/:assignmentId/versions/:version", async (request) => {
    const { assignmentId, version } = rubricVersionParamsSchema.parse(request.params);
    return rubrics.getVersion(assignmentId, version);
  });
  app.post("/api/rubrics/assignments/:assignmentId/versions/:version/revisions", async (request) => {
    const { assignmentId, version } = rubricVersionParamsSchema.parse(request.params);
    return rubrics.createRevision(assignmentId, version);
  });
  app.get("/api/rubrics/assignments/:assignmentId/versions/:version/export.json", async (request, reply) => {
    const { assignmentId, version } = rubricVersionParamsSchema.parse(request.params);
    return reply.type("application/json; charset=utf-8").send(await rubrics.getVersion(assignmentId, version));
  });
  app.get("/api/rubrics/assignments/:assignmentId/versions/:version/export.md", async (request, reply) => {
    const { assignmentId, version } = rubricVersionParamsSchema.parse(request.params);
    return reply.type("text/markdown; charset=utf-8").send(await rubrics.renderVersionMarkdown(assignmentId, version));
  });
  app.post("/api/rubrics/assignments/:assignmentId/messages/stream", async (request, reply) => {
    const { assignmentId } = rubricAssignmentIdSchema.parse(request.params);
    const { message } = rubricChatSchema.parse(request.body);
    if (!await rubrics.getDesignSession(assignmentId)) throw new RubricServiceError("Select a scoring mode before starting rubric design");
    await assertRubricCanOpenDraft(rubrics, assignmentId);
    if (!options.rubricDesignerFactory) return reply.code(200).send({ state: "manual", message: "Manual rubric editing is available while the model is not configured." });
    return streamRubricDesign(request, reply, options.rubricDesignerFactory(assignmentId, rubrics), message, (outcome) => persistRubricDesignOutcome(rubrics, assignmentId, outcome), (user, assistant) => rubrics.appendConversationTurn(assignmentId, user, assistant), activeAgentRuns);
  });
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
    const controller = new AbortController();
    const runId = randomUUID();
    activeAgentRuns.set(runId, controller);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-agent-run-id": runId,
    });
    reply.raw.write(sseComment("course-qa"));
    const keepAlive = setInterval(() => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(sseComment("keep-alive")); }, 15_000);
    const emit = (event: CourseQaEvent) => { if (!controller.signal.aborted && !reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(sseFrame(event.type, event)); };
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
      activeAgentRuns.delete(runId);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    }
    return reply;
  });

  app.addHook("onClose", async () => gradingApi.close());
  return app;
}

function authorizeModelWrite(request: FastifyRequest, security: ServerOptions["modelApiSecurity"]): boolean {
  if (!security) return false;
  return security.isLoopback(request)
    && request.headers.origin === security.allowedOrigin
    && request.headers["x-csrf-token"] === security.csrfToken;
}

function staticRubricRecommendation() {
  return {
    options: [
      { mode: "additive" as const, recommended: false, benefit: "各评分项的权重与得分清晰，适合按完成质量逐项给分。" },
      { mode: "deductive" as const, recommended: true, reason: "尚无参考资料时，以满分为基准并列明扣分规则，最便于教师快速建立可执行标准。" },
      { mode: "hybrid" as const, recommended: false, benefit: "可同时表达基础评分项、奖励表现与明确扣分。" },
    ],
  };
}

function manualRubric(mode: Rubric["mode"], totalScore: number): Rubric {
  const criterion = {
    id: "overall_quality",
    name: "整体完成质量",
    description: "请将本项拆分为适合当前作业的可观察评分维度。",
    maxScore: totalScore,
    scorePolicy: "continuous" as const,
    evidenceRequired: true,
  };
  if (mode === "additive") return { schemaVersion: "1.0", mode, totalScore, partialCreditAllowed: true, criteria: [criterion] };
  if (mode === "deductive") return {
    schemaVersion: "1.0",
    mode,
    totalScore,
    rules: [{ id: "general_issue", name: "通用问题", condition: "请填写明确、可观察的扣分触发条件。", deduction: Math.min(1, totalScore), maxDeduction: totalScore, occurrence: "once", evidenceRequired: true }],
    overlapGroups: [],
  };
  return { schemaVersion: "1.0", mode, totalScore, partialCreditAllowed: true, criteria: [criterion], bonusRules: [], deductionRules: [], overlapGroups: [] };
}

async function streamRubricDesign(
  request: FastifyRequest,
  reply: FastifyReply,
  designer: PiRubricDesigner,
  message: string,
  persistOutcome: (outcome: RubricDesignerOutcome) => Promise<void>,
  persistTurn: (user: { role: "user"; content: string }, assistant: { role: "assistant"; content: string; process?: string; tools?: RubricConversationTool[]; options?: string[] }) => Promise<unknown>,
  activeAgentRuns: Map<string, AbortController>,
): Promise<FastifyReply> {
  reply.hijack();
  const controller = new AbortController();
  const runId = randomUUID();
  activeAgentRuns.set(runId, controller);
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-agent-run-id": runId,
  });
  reply.raw.write(sseComment("rubric-designer"));
  const keepAlive = setInterval(() => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(sseComment("keep-alive")); }, 15_000);
  const emit = (event: string, value: unknown) => {
    if (!controller.signal.aborted && !reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(sseFrame(event, value));
  };
  let process = "";
  const tools = new Map<string, RubricConversationTool>();
  const onEvent = (event: RubricDesignEvent) => {
    if (event.type === "process_delta") return;
    emit(event.type, event);
    if (event.type === "status" && !process) {
      process = RUBRIC_SAFE_PROCESS_SUMMARY;
      emit("process_delta", { type: "process_delta", delta: process });
    }
    if (event.type === "tool_start") tools.set(event.id, { id: event.id, name: event.name, label: event.label, summary: event.summary, status: "completed" });
    if (event.type === "tool_end") tools.set(event.id, { id: event.id, name: event.name, label: event.label, summary: event.summary, status: event.status });
  };
  try {
    const outcome = await designer.design(message, onEvent, controller.signal);
    if (!controller.signal.aborted) {
      await persistOutcome(outcome);
      const content = outcome.kind === "question"
        ? outcome.question.question
        : outcome.kind === "reply"
          ? outcome.reply
          : "评分表草稿已更新，可以在右侧预览并继续修改。";
      await persistTurn(
        { role: "user", content: message },
        { role: "assistant", content, ...(process ? { process } : {}), ...(tools.size > 0 ? { tools: [...tools.values()] } : {}), ...(outcome.kind === "question" && outcome.question.options ? { options: outcome.question.options } : {}) },
      );
      if (outcome.kind === "question") emit("question", { question: outcome.question });
      else if (outcome.kind === "reply") emit("reply", { reply: outcome.reply });
      else emit("draft", { version: outcome.draft.version, updatedAt: outcome.draft.updatedAt });
      emit("final", { kind: outcome.kind, message: outcome.message });
    }
  } catch {
    if (!controller.signal.aborted) emit("error", { code: "RUBRIC_DESIGN_FAILED", message: "评分表设计未能完成，请稍后重试或先使用人工编辑。" });
  } finally {
    clearInterval(keepAlive);
    activeAgentRuns.delete(runId);
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
  return reply;
}

async function persistRubricDesignOutcome(rubrics: RubricService, assignmentId: string, outcome: RubricDesignerOutcome): Promise<void> {
  if (outcome.kind !== "draft") return;
  const stored = await rubrics.getDraft(assignmentId);
  if (!stored) {
    const created = await rubrics.createDraft(assignmentId, outcome.draft.rubric);
    if (!sameRubricDraft(created, outcome.draft)) throw new RubricServiceError("The generated rubric draft version could not be verified");
    return;
  }
  if (sameRubricDraft(stored, outcome.draft)) return;
  if (outcome.draft.version !== stored.version + 1) throw new RubricServiceError("The generated rubric draft version could not be verified");
  const updated = await rubrics.replaceDraft(assignmentId, stored.version, outcome.draft.rubric);
  if (!sameRubricDraft(updated, outcome.draft)) throw new RubricServiceError("The generated rubric draft version could not be verified");
}

async function assertRubricCanOpenDraft(rubrics: RubricService, assignmentId: string): Promise<void> {
  if (await rubrics.getDraft(assignmentId)) return;
  if ((await rubrics.listVersions(assignmentId)).length > 0) throw new RubricServiceError("Create a revision from a frozen rubric version before editing again");
}

function sameRubricDraft(left: { version: number; rubric: unknown }, right: { version: number; rubric: unknown }): boolean {
  return left.version === right.version && JSON.stringify(left.rubric) === JSON.stringify(right.rubric);
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
