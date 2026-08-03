import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createPiMaterialPlanner } from "./agent.js";

export function createDeepSeekMaterialPlanner(apiKey?: string): {
  planner: ReturnType<typeof createPiMaterialPlanner> | undefined;
  status: { provider: string; model: string; configured: boolean };
} {
  const status = { provider: "deepseek", model: "deepseek-v4-flash", configured: Boolean(apiKey) };
  if (!status.configured) return { planner: undefined, status };
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", status.model);
  if (!model) throw new Error(`Configured Pi model is unavailable: ${status.model}`);
  return { planner: createPiMaterialPlanner({ models, model, getApiKey: () => apiKey }), status };
}
