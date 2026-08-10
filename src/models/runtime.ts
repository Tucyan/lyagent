import { createPiAssignmentGrader, type PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { createPiCourseQaAgent, type PiCourseQaAgent } from "../agents/course-qa/agent.js";
import { createPiMaterialPlanner } from "../agents/material-import/agent.js";
import { createPiRubricDesigner, type PiRubricDesigner } from "../agents/rubric-designer/agent.js";
import type { GradingAgentBuilder } from "../api/grading-routes.js";
import type { CourseKnowledgeService } from "../services/knowledge-service.js";
import { KnowledgeAccessError, KnowledgeService } from "../services/knowledge-service.js";
import type { RubricService } from "../services/rubric-service.js";
import type { WebEvidenceService } from "../services/web-evidence-service.js";
import type { ConfiguredModels } from "./openai-compatible.js";

export function createPrimaryModelRuntime(options: {
  workspaceRoot: string;
  configured: ConfiguredModels;
  apiKey?: string;
  visionApiKey?: string;
  webFactory?: () => WebEvidenceService;
}): {
  materialPlanner: ReturnType<typeof createPiMaterialPlanner> | undefined;
  courseQaAgentFactory: ((knowledge: CourseKnowledgeService, web?: WebEvidenceService) => PiCourseQaAgent) | undefined;
  rubricDesignerFactory: ((assignmentId: string, rubricService: RubricService) => PiRubricDesigner) | undefined;
  gradingAgentFactory: GradingAgentBuilder | undefined;
  status: { provider: string; model: string; configured: boolean };
  visionAvailable: boolean;
} {
  const status = { provider: options.configured.primary.provider, model: options.configured.primary.id, configured: Boolean(options.apiKey) };
  const visionAvailable = Boolean(options.configured.vision && options.visionApiKey);
  if (!options.apiKey) return { materialPlanner: undefined, courseQaAgentFactory: undefined, rubricDesignerFactory: undefined, gradingAgentFactory: undefined, status, visionAvailable: false };
  const apiKey = options.apiKey;
  const common = { models: options.configured.models, model: options.configured.primary, getApiKey: () => apiKey };
  const knowledge = new KnowledgeService(options.workspaceRoot);
  const gradingAgentFactory: GradingAgentBuilder = (sessionId, runId, services): PiAssignmentGrader => ({
    async run(request, onEvent, signal) {
      const session = await services.sessions.getSession(sessionId);
      let courseKnowledge: CourseKnowledgeService | undefined;
      if (request.kind !== "name") {
        try { courseKnowledge = await knowledge.forCourse(session.courseId); }
        catch (error: unknown) {
          if (!(error instanceof KnowledgeAccessError) || error.code !== "ACTIVE_RELEASE_NOT_FOUND") throw error;
        }
      }
      return createPiAssignmentGrader({
        ...common,
        primaryModel: options.configured.primary,
        ...(visionAvailable && options.configured.vision ? { visionModel: options.configured.vision } : {}),
        getApiKey: options.configured.getApiKey,
        sessions: services.sessions,
        results: services.results,
        rubrics: services.rubrics,
        sessionId,
        runId,
        ...(courseKnowledge ? { knowledge: courseKnowledge } : {}),
        ...(options.webFactory ? { web: options.webFactory() } : {}),
      }).run(request, onEvent, signal);
    },
  });
  return {
    materialPlanner: createPiMaterialPlanner(common),
    courseQaAgentFactory: (courseKnowledge, web) => createPiCourseQaAgent({ ...common, knowledge: courseKnowledge, ...(web ? { web } : {}) }),
    rubricDesignerFactory: (assignmentId, rubricService) => createPiRubricDesigner({ ...common, assignmentId, rubricService }),
    gradingAgentFactory,
    status,
    visionAvailable,
  };
}
