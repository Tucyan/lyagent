import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createPiAssignmentGrader, type PiAssignmentGrader } from "./agent.js";
import type { GradingAgentBuilder } from "../../api/grading-routes.js";
import { KnowledgeService } from "../../services/knowledge-service.js";
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
      const agent = createPiAssignmentGrader({
        models, model, sessions: services.sessions, results: services.results, rubrics: services.rubrics,
        sessionId, runId, knowledge: await knowledge.forCourse(session.courseId),
        ...(options.webFactory ? { web: options.webFactory() } : {}),
        getApiKey: () => options.apiKey,
      });
      return agent.run(request, onEvent, signal);
    },
  });
}
