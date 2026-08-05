import type { CredentialStore } from "../config/credential-store.js";
import { loadAppConfig, saveAppConfig, type AppConfig, type ModelEndpointConfig, type ModelSettings } from "../config/app-config.js";

export interface ModelEndpointInput extends ModelEndpointConfig { apiKey?: string | undefined }
export interface ModelSettingsInput { primary: ModelEndpointInput; vision?: ModelEndpointInput | undefined }

export class ModelConfigurationError extends Error {
  constructor(message = "The model configuration could not be verified") {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

export class ModelConfigService {
  private readonly fetchImpl: typeof fetch;
  private readonly saveConfig: typeof saveAppConfig;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { workspaceRoot: string; credentials: CredentialStore; fetchImpl?: typeof fetch; saveConfig?: typeof saveAppConfig }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.saveConfig = options.saveConfig ?? saveAppConfig;
  }

  async status(): Promise<{
    primary: ModelEndpointConfig & { configured: boolean };
    vision?: ModelEndpointConfig & { configured: boolean };
  }> {
    const config = await loadAppConfig(this.options.workspaceRoot);
    const primaryKey = await this.resolveKey(config.models.primary, config);
    const vision = config.models.vision;
    return {
      primary: { ...config.models.primary, configured: Boolean(primaryKey) },
      ...(vision ? { vision: { ...vision, configured: Boolean(await this.resolveKey(vision, config)) } } : {}),
    };
  }

  async test(input: ModelSettingsInput): Promise<{ ok: true }> {
    const submittedKeys = submittedKeyMap(input);
    await this.testEndpoint(input.primary, submittedKeys);
    if (input.vision) await this.testEndpoint(input.vision, submittedKeys);
    return { ok: true };
  }

  async save(input: ModelSettingsInput): Promise<Awaited<ReturnType<ModelConfigService["status"]>> & { restartRequired: true }> {
    const preceding = this.saveQueue;
    let release!: () => void;
    this.saveQueue = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try {
      return await this.saveTransaction(input);
    } finally {
      release();
    }
  }

  async apiKey(providerId: string): Promise<string | undefined> {
    const stored = await this.options.credentials.getApiKey(providerId);
    if (stored) return stored;
    const config = await loadAppConfig(this.options.workspaceRoot);
    return providerId === "deepseek" ? config.deepseekApiKey : undefined;
  }

  private async testEndpoint(endpoint: ModelEndpointInput, submittedKeys: ReadonlyMap<string, string>): Promise<void> {
    const config = await loadAppConfig(this.options.workspaceRoot);
    const apiKey = submittedKeys.get(endpoint.providerId) || await this.resolveKey(endpoint, config);
    if (!apiKey) throw new ModelConfigurationError();
    let response: Response;
    try {
      response = await this.fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: endpoint.modelId,
          temperature: 0,
          max_tokens: 16,
          messages: [{ role: "user", content: "Call configuration_ok now." }],
          tools: [{ type: "function", function: { name: "configuration_ok", description: "Confirm model tool calling works", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
          tool_choice: { type: "function", function: { name: "configuration_ok" } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ModelConfigurationError();
    }
    if (!response.ok) throw new ModelConfigurationError();
    try {
      const payload = await response.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }> };
      if (payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name !== "configuration_ok") throw new Error("missing tool call");
    } catch {
      throw new ModelConfigurationError();
    }
  }

  private async saveTransaction(input: ModelSettingsInput): Promise<Awaited<ReturnType<ModelConfigService["status"]>> & { restartRequired: true }> {
    await this.test(input);
    const previous = await loadAppConfig(this.options.workspaceRoot);
    const endpoints = uniqueProviderEndpoints(input);
    const previousKeys = new Map<string, string | undefined>();
    for (const endpoint of endpoints) previousKeys.set(endpoint.providerId, await this.options.credentials.getApiKey(endpoint.providerId));
    const attempted: string[] = [];
    const models: ModelSettings = {
      primary: stripKey(input.primary),
      ...(input.vision ? { vision: stripKey(input.vision) } : {}),
    };
    try {
      for (const endpoint of endpoints) {
        attempted.push(endpoint.providerId);
        await this.persistKey(endpoint, previous, submittedKeyMap(input));
      }
      await this.saveConfig(this.options.workspaceRoot, { ...previous, models });
    } catch (error) {
      let rollbackFailed = false;
      for (const providerId of attempted.reverse()) {
        try {
          const oldKey = previousKeys.get(providerId);
          if (oldKey) await this.options.credentials.setApiKey(providerId, oldKey);
          else await this.options.credentials.deleteApiKey(providerId);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) throw new ModelConfigurationError();
      throw error;
    }
    return { ...(await this.status()), restartRequired: true };
  }

  private async resolveKey(endpoint: ModelEndpointConfig, config: AppConfig): Promise<string | undefined> {
    return await this.options.credentials.getApiKey(endpoint.providerId)
      ?? (endpoint.providerId === "deepseek" ? config.deepseekApiKey : undefined);
  }

  private async persistKey(endpoint: ModelEndpointInput, previous: AppConfig, submittedKeys: ReadonlyMap<string, string>): Promise<void> {
    const key = submittedKeys.get(endpoint.providerId)
      || await this.options.credentials.getApiKey(endpoint.providerId)
      || (endpoint.providerId === "deepseek" ? previous.deepseekApiKey : undefined);
    if (!key) throw new ModelConfigurationError();
    await this.options.credentials.setApiKey(endpoint.providerId, key);
  }
}

function submittedKeyMap(input: ModelSettingsInput): Map<string, string> {
  const keys = new Map<string, string>();
  for (const endpoint of [input.primary, input.vision].filter((value): value is ModelEndpointInput => Boolean(value))) {
    const key = endpoint.apiKey?.trim();
    if (!key) continue;
    const existing = keys.get(endpoint.providerId);
    if (existing && existing !== key) throw new ModelConfigurationError();
    keys.set(endpoint.providerId, key);
  }
  return keys;
}

function uniqueProviderEndpoints(input: ModelSettingsInput): ModelEndpointInput[] {
  const endpoints = [input.primary, input.vision].filter((value): value is ModelEndpointInput => Boolean(value));
  return [...new Map(endpoints.map((endpoint) => [endpoint.providerId, endpoint])).values()];
}

function stripKey(input: ModelEndpointInput): ModelEndpointConfig {
  return { providerId: input.providerId, modelId: input.modelId, baseUrl: input.baseUrl };
}
