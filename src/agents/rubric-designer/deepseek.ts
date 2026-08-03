import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createPiRubricDesigner, type PiRubricDesigner } from "./agent.js";
import type { RubricService } from "../../services/rubric-service.js";

export function createDeepSeekRubricDesignerFactory(apiKey?: string): {
  factory: ((assignmentId: string, rubricService: RubricService) => PiRubricDesigner) | undefined;
  status: { provider: string; model: string; configured: boolean };
} {
  const status = { provider: "deepseek", model: "deepseek-v4-flash", configured: Boolean(apiKey) };
  if (!status.configured) return { factory: undefined, status };
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", status.model);
  if (!model) throw new Error(`Configured Pi model is unavailable: ${status.model}`);
  return { factory: (assignmentId, rubricService) => createPiRubricDesigner({ models, model, rubricService, assignmentId, getApiKey: () => apiKey }), status };
}
