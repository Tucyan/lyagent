import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { ModelSettings, ModelEndpointConfig } from "../config/app-config.js";

export interface ConfiguredModels {
  models: Models;
  primary: Model<"openai-completions">;
  vision?: Model<"openai-completions">;
  getApiKey(providerId: string): Promise<string | undefined>;
}

export function createConfiguredModels(options: {
  config: ModelSettings;
  getApiKey(providerId: string): Promise<string | undefined>;
}): ConfiguredModels {
  const models = createModels();
  const primary = configuredModel(options.config.primary, ["text"]);
  const configured = new Map<string, Model<"openai-completions">[]>([[primary.provider, [primary]]]);
  const vision = options.config.vision ? configuredModel(options.config.vision, ["text", "image"]) : undefined;
  if (vision) configured.set(vision.provider, [...(configured.get(vision.provider) ?? []), vision]);
  for (const [providerId, providerModels] of configured) {
    models.setProvider(createProvider({
      id: providerId,
      name: providerId,
      baseUrl: providerModels[0]!.baseUrl,
      auth: { apiKey: { name: `${providerId} API key`, resolve: async () => undefined } },
      models: providerModels,
      api: openAICompletionsApi,
    }));
  }
  return { models, primary, ...(vision ? { vision } : {}), getApiKey: options.getApiKey };
}

function configuredModel(config: ModelEndpointConfig, input: ("text" | "image")[]): Model<"openai-completions"> {
  const known = deepseekProvider().getModels().find((model) => model.id === config.modelId);
  return {
    ...(known ? {
      ...known,
      api: "openai-completions" as const,
    } : {
      id: config.modelId,
      name: config.modelId,
      api: "openai-completions" as const,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
    id: config.modelId,
    provider: config.providerId,
    baseUrl: config.baseUrl.replace(/\/$/, ""),
    input,
  };
}
