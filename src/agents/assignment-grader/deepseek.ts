import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createPiAssignmentGrader, type PiAssignmentGrader } from "./agent.js";
import type { GradingAgentBuilder } from "../../api/grading-routes.js";
import { KnowledgeAccessError, KnowledgeService, type CourseKnowledgeService } from "../../services/knowledge-service.js";
import type { WebEvidenceService } from "../../services/web-evidence-service.js";

export function createDeepSeekAssignmentGraderFactory(options: { workspaceRoot: string; apiKey?: string; webFactory?: () => WebEvidenceService }): GradingAgentBuilder | undefined {
  if (!options.apiKey) return undefined;
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", "deepseek-v4-flash");
  if (!model) throw new Error("Configured DeepSeek grading model is unavailable");
  const knowledge = new KnowledgeService(options.workspaceRoot);
  return (sessionId, runId, services): PiAssignmentGrader => ({
    async run(request, onEvent, signal) {
      const session = await services.sessions.getSession(sessionId);
      let courseKnowledge: CourseKnowledgeService | undefined;
      if (request.kind !== "name") {
        try { courseKnowledge = await knowledge.forCourse(session.courseId); }
        catch (error: unknown) {
          if (!(error instanceof KnowledgeAccessError) || error.code !== "ACTIVE_RELEASE_NOT_FOUND") throw error;
        }
      }
      const agent = createPiAssignmentGrader({
        models, primaryModel: model, sessions: services.sessions, results: services.results, rubrics: services.rubrics,
        sessionId, runId, ...(courseKnowledge ? { knowledge: courseKnowledge } : {}),
        ...(options.webFactory ? { web: options.webFactory() } : {}),
        getApiKey: () => options.apiKey,
      });
      return agent.run(request, onEvent, signal);
    },
  });
}
