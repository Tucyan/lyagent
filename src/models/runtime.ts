import { createPiAssignmentGrader, type PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { createPiCourseQaAgent, type PiCourseQaAgent } from "../agents/course-qa/agent.js";
import { createPiMaterialPlanner } from "../agents/material-import/agent.js";
import { createPiRubricDesigner, type PiRubricDesigner } from "../agents/rubric-designer/agent.js";
import type { GradingAgentBuilder } from "../api/grading-routes.js";
import type { CourseKnowledgeService } from "../services/knowledge-service.js";
import { KnowledgeService } from "../services/knowledge-service.js";
import type { RubricService } from "../services/rubric-service.js";
import type { WebEvidenceService } from "../services/web-evidence-service.js";
import type { ConfiguredModels } from "./openai-compatible.js";

export function createPrimaryModelRuntime(options: {
  workspaceRoot: string;
  configured: ConfiguredModels;
  apiKey?: string;
  webFactory?: () => WebEvidenceService;
}): {
  materialPlanner: ReturnType<typeof createPiMaterialPlanner> | undefined;
  courseQaAgentFactory: ((knowledge: CourseKnowledgeService, web?: WebEvidenceService) => PiCourseQaAgent) | undefined;
  rubricDesignerFactory: ((assignmentId: string, rubricService: RubricService) => PiRubricDesigner) | undefined;
  gradingAgentFactory: GradingAgentBuilder | undefined;
  status: { provider: string; model: string; configured: boolean };
} {
  const status = { provider: options.configured.primary.provider, model: options.configured.primary.id, configured: Boolean(options.apiKey) };
  if (!options.apiKey) return { materialPlanner: undefined, courseQaAgentFactory: undefined, rubricDesignerFactory: undefined, gradingAgentFactory: undefined, status };
  const apiKey = options.apiKey;
  const common = { models: options.configured.models, model: options.configured.primary, getApiKey: () => apiKey };
  const knowledge = new KnowledgeService(options.workspaceRoot);
  const gradingAgentFactory: GradingAgentBuilder = (sessionId, runId, services): PiAssignmentGrader => ({
    async run(request, onEvent, signal) {
      const session = await services.sessions.getSession(sessionId);
      return createPiAssignmentGrader({
        ...common,
        sessions: services.sessions,
        results: services.results,
        rubrics: services.rubrics,
        sessionId,
        runId,
        knowledge: await knowledge.forCourse(session.courseId),
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
  };
}
