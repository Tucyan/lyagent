import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { ModelSettings, ModelEndpointConfig } from "../config/app-config.js";
import { modelApiProtocol, normalizeModelBaseUrl } from "../config/model-base-url.js";

export interface ConfiguredModels {
  models: Models;
  primary: Model<any>;
  vision?: Model<any>;
  getApiKey(providerId: string): Promise<string | undefined>;
}

export function createConfiguredModels(options: {
  config: ModelSettings;
  getApiKey(providerId: string): Promise<string | undefined>;
}): ConfiguredModels {
  const models = createModels();
  const primary = configuredModel(options.config.primary, ["text"]);
  const configured = new Map<string, Model<any>[]>([[primary.provider, [primary]]]);
  const vision = options.config.vision ? configuredModel(options.config.vision, ["text", "image"]) : undefined;
  if (vision) configured.set(vision.provider, [...(configured.get(vision.provider) ?? []), vision]);
  for (const [providerId, providerModels] of configured) {
    models.setProvider(createProvider({
      id: providerId,
      name: providerId,
      baseUrl: providerModels[0]!.baseUrl,
      auth: { apiKey: { name: `${providerId} API key`, resolve: async () => {
        const apiKey = await options.getApiKey(providerId);
        return apiKey ? { auth: { apiKey }, source: "Windows DPAPI" } : undefined;
      } } },
      models: providerModels,
      api: {
        "openai-completions": openAICompletionsApi,
        "openai-responses": openAIResponsesApi(),
      },
    }));
  }
  return { models, primary, ...(vision ? { vision } : {}), getApiKey: options.getApiKey };
}

function configuredModel(config: ModelEndpointConfig, input: ("text" | "image")[]): Model<any> {
  const api = modelApiProtocol(config.baseUrl, config.providerId);
  const known = api === "openai-completions" ? deepseekProvider().getModels().find((model) => model.id === config.modelId) : undefined;
  return {
    ...(known ? {
      ...known,
      api,
    } : {
      id: config.modelId,
      name: config.modelId,
      api,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
    id: config.modelId,
    provider: config.providerId,
    baseUrl: normalizeModelBaseUrl(config.baseUrl),
    input,
  };
}
