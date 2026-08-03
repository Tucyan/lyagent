import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { CourseKnowledgeService } from "../../services/knowledge-service.js";
import type { WebEvidenceService } from "../../services/web-evidence-service.js";
import { createPiCourseQaAgent, type PiCourseQaAgent } from "./agent.js";

export function createDeepSeekCourseQaAgentFactory(apiKey?: string): {
  factory: ((knowledge: CourseKnowledgeService, web?: WebEvidenceService) => PiCourseQaAgent) | undefined;
  status: { provider: string; model: string; configured: boolean };
} {
  const status = { provider: "deepseek", model: "deepseek-v4-flash", configured: Boolean(apiKey) };
  if (!status.configured) return { factory: undefined, status };
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", status.model);
  if (!model) throw new Error(`Configured Pi model is unavailable: ${status.model}`);
  return { factory: (knowledge, web) => createPiCourseQaAgent({ models, model, knowledge, ...(web ? { web } : {}), getApiKey: () => apiKey }), status };
}
