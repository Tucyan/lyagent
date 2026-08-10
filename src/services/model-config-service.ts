import type { CredentialStore } from "../config/credential-store.js";
import { loadAppConfig, parseAppConfigValue, saveAppConfig, type AppConfig, type ModelEndpointConfig, type ModelSettings } from "../config/app-config.js";
import { assertSafeModelBaseUrl, modelApiProtocol } from "../config/model-base-url.js";
import { withModelConfigLock } from "../config/model-config-lock.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ModelEndpointInput extends ModelEndpointConfig { apiKey?: string | undefined }
export interface ModelSettingsInput { primary: ModelEndpointInput; vision?: ModelEndpointInput | undefined }
export type ModelConfigurationFailureReason = "invalid_url" | "missing_api_key" | "network_error" | "authentication_failed" | "model_not_found" | "rate_limited" | "provider_unavailable" | "request_rejected" | "invalid_response" | "tool_call_missing" | "verification_failed";
type ModelStatus = { primary: ModelEndpointConfig & { configured: boolean }; vision?: ModelEndpointConfig & { configured: boolean } };
interface TransactionJournal {
  version: 1;
  state: "prepared" | "committed";
  previousConfig: AppConfig;
  credentials: Record<string, string | null>;
}

export class ModelConfigurationError extends Error {
  constructor(public readonly reason: ModelConfigurationFailureReason = "verification_failed") {
    super("The model configuration could not be verified");
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

  async status(): Promise<ModelStatus> {
    return withModelConfigLock(this.options.workspaceRoot, async () => {
      await this.recoverJournal();
      return this.statusUnlocked();
    });
  }

  async loadConfig(): Promise<AppConfig> {
    return withModelConfigLock(this.options.workspaceRoot, async () => {
      await this.recoverJournal();
      return loadAppConfig(this.options.workspaceRoot);
    });
  }

  async loadRuntimeConfig(): Promise<{ config: AppConfig; apiKeys: Readonly<Record<string, string>> }> {
    return withModelConfigLock(this.options.workspaceRoot, async () => {
      await this.recoverJournal();
      const config = await loadAppConfig(this.options.workspaceRoot);
      const apiKeys: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const endpoint of [config.models.primary, config.models.vision].filter((value): value is ModelEndpointConfig => Boolean(value))) {
        if (endpoint.providerId in apiKeys) continue;
        const apiKey = await this.resolveKey(endpoint, config);
        if (apiKey) apiKeys[endpoint.providerId] = apiKey;
      }
      return { config, apiKeys };
    });
  }

  private async statusUnlocked(): Promise<ModelStatus> {
    const config = await loadAppConfig(this.options.workspaceRoot);
    const primaryKey = await this.resolveKey(config.models.primary, config);
    const vision = config.models.vision;
    return {
      primary: { ...config.models.primary, configured: Boolean(primaryKey) },
      ...(vision ? { vision: { ...vision, configured: Boolean(await this.resolveKey(vision, config)) } } : {}),
    };
  }

  async test(input: ModelSettingsInput): Promise<{ ok: true }> {
    const apiKeys = await withModelConfigLock(this.options.workspaceRoot, async () => {
      await this.recoverJournal();
      return this.snapshotKeys(input, await loadAppConfig(this.options.workspaceRoot));
    });
    return this.testWithKeys(input, apiKeys);
  }

  private async testWithKeys(input: ModelSettingsInput, apiKeys: ReadonlyMap<string, string>): Promise<{ ok: true }> {
    await this.testEndpoint(input.primary, apiKeys.get(input.primary.providerId), false);
    if (input.vision) await this.testEndpoint(input.vision, apiKeys.get(input.vision.providerId), true);
    return { ok: true };
  }

  async save(input: ModelSettingsInput): Promise<Awaited<ReturnType<ModelConfigService["status"]>> & { restartRequired: true }> {
    const preceding = this.saveQueue;
    let release!: () => void;
    this.saveQueue = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try {
      return await withModelConfigLock(this.options.workspaceRoot, async () => {
        await this.recoverJournal();
        return this.saveTransaction(input);
      });
    } finally {
      release();
    }
  }

  async apiKey(providerId: string): Promise<string | undefined> {
    return withModelConfigLock(this.options.workspaceRoot, async () => {
      await this.recoverJournal();
      return this.apiKeyUnlocked(providerId);
    });
  }

  private async apiKeyUnlocked(providerId: string): Promise<string | undefined> {
    const stored = await this.options.credentials.getApiKey(providerId);
    if (stored) return stored;
    const config = await loadAppConfig(this.options.workspaceRoot);
    return providerId === "deepseek" ? config.deepseekApiKey : undefined;
  }

  private async testEndpoint(endpoint: ModelEndpointInput, apiKey: string | undefined, includeImage: boolean): Promise<void> {
    try { assertSafeModelBaseUrl(endpoint.baseUrl); } catch { throw new ModelConfigurationError("invalid_url"); }
    if (!apiKey) throw new ModelConfigurationError("missing_api_key");
    if (modelApiProtocol(endpoint.baseUrl, endpoint.providerId) === "openai-responses") return this.testResponsesEndpoint(endpoint, apiKey, includeImage);
    const requestBody: Record<string, unknown> = {
        model: endpoint.modelId,
        messages: [{
          role: "user",
          content: includeImage
            ? [
                { type: "text", text: "Inspect this image and call configuration_ok now." },
                { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } },
              ]
            : "Call configuration_ok now.",
        }],
        tools: [{ type: "function", function: { name: "configuration_ok", description: "Confirm model tool calling works", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
        tool_choice: "required",
    };
    let previousStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = { ...requestBody };
      if (attempt === 1 && previousStatus === 400) delete body.tool_choice;
      let response: Response;
      try {
        response = await this.fetchImpl(`${normalizeCompletionsUrl(endpoint.baseUrl)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ModelConfigurationError("network_error");
      }
      previousStatus = response.status;
      if (response.status === 400 && attempt === 0) continue;
      if (!response.ok) throw new ModelConfigurationError(modelFailureReasonForStatus(response.status));
      let payload: { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }> };
      try {
        payload = await response.json() as typeof payload;
      } catch {
        throw new ModelConfigurationError("invalid_response");
      }
      if (payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "configuration_ok") return;
    }
    throw new ModelConfigurationError("tool_call_missing");
  }

  private async testResponsesEndpoint(endpoint: ModelEndpointInput, apiKey: string, includeImage: boolean): Promise<void> {
    const requestBody: Record<string, unknown> = {
      model: endpoint.modelId,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: includeImage ? "Inspect this image and call configuration_ok now." : "Call configuration_ok now." },
          ...(includeImage ? [{ type: "input_image", image_url: TEST_IMAGE_DATA_URL }] : []),
        ],
      }],
      tools: [{ type: "function", name: "configuration_ok", description: "Confirm model tool calling works", parameters: { type: "object", properties: {}, additionalProperties: false } }],
      tool_choice: { type: "function", name: "configuration_ok" },
    };
    let previousStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = { ...requestBody };
      if (attempt === 1 && previousStatus === 400) delete body.tool_choice;
      let response: Response;
      try {
      response = await this.fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ModelConfigurationError("network_error");
      }
      previousStatus = response.status;
      if (response.status === 400 && attempt === 0) continue;
      if (!response.ok) throw new ModelConfigurationError(modelFailureReasonForStatus(response.status));
      let payload: { output?: Array<{ type?: string; name?: string }> };
      try { payload = await response.json() as typeof payload; }
      catch { throw new ModelConfigurationError("invalid_response"); }
      if (payload.output?.some((item) => item.type === "function_call" && item.name === "configuration_ok")) return;
    }
    throw new ModelConfigurationError("tool_call_missing");
  }

  private async saveTransaction(input: ModelSettingsInput): Promise<Awaited<ReturnType<ModelConfigService["status"]>> & { restartRequired: true }> {
    const previous = await loadAppConfig(this.options.workspaceRoot);
    const submittedKeys = submittedKeyMap(input);
    await this.testWithKeys(input, await this.snapshotKeys(input, previous, submittedKeys));
    const endpoints = uniqueProviderEndpoints(input);
    const credentialSnapshots: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
    const providerIds = new Set([previous.models.primary.providerId, previous.models.vision?.providerId, ...endpoints.map((endpoint) => endpoint.providerId)].filter((value): value is string => Boolean(value)));
    for (const providerId of providerIds) {
      let snapshot = await this.options.credentials.readProtected(providerId);
      if (!snapshot && providerId === "deepseek" && previous.deepseekApiKey) snapshot = await this.options.credentials.protectApiKey(previous.deepseekApiKey);
      credentialSnapshots[providerId] = snapshot?.toString("base64") ?? null;
    }
    const models: ModelSettings = {
      primary: stripKey(input.primary),
      ...(input.vision ? { vision: stripKey(input.vision) } : {}),
    };
    const journal: TransactionJournal = { version: 1, state: "prepared", previousConfig: safeConfig(previous), credentials: credentialSnapshots };
    await this.writeJournal(journal);
    try {
      for (const endpoint of endpoints) {
        await this.persistKey(endpoint, previous, submittedKeys);
      }
      const activeProviderIds = new Set(endpoints.map((endpoint) => endpoint.providerId));
      const previousVisionProvider = previous.models.vision?.providerId;
      if (previousVisionProvider && !activeProviderIds.has(previousVisionProvider)) await this.options.credentials.deleteApiKey(previousVisionProvider);
      await this.saveConfig(this.options.workspaceRoot, { ...previous, models });
      await this.writeJournal({ ...journal, state: "committed" });
      await rm(this.journalPath(), { force: true });
    } catch (error) {
      try { await this.recoverJournal(); } catch { throw new ModelConfigurationError(); }
      throw error;
    }
    return { ...(await this.statusUnlocked()), restartRequired: true };
  }

  private journalPath(): string { return path.join(this.options.workspaceRoot, "config", "model-settings.transaction.json"); }

  private async writeJournal(journal: TransactionJournal): Promise<void> {
    const filename = this.journalPath();
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, filename);
  }

  private async recoverJournal(): Promise<void> {
    let journal: TransactionJournal;
    try { journal = parseJournal(JSON.parse(await readFile(this.journalPath(), "utf8"))); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ModelConfigurationError();
    }
    if (journal.state === "prepared") {
      for (const [providerId, encoded] of Object.entries(journal.credentials)) {
        await this.options.credentials.restoreProtected(providerId, encoded === null ? undefined : Buffer.from(encoded, "base64"));
      }
      await saveAppConfig(this.options.workspaceRoot, journal.previousConfig);
    }
    await rm(this.journalPath(), { force: true });
  }

  private async resolveKey(endpoint: ModelEndpointConfig, config: AppConfig): Promise<string | undefined> {
    return await this.options.credentials.getApiKey(endpoint.providerId)
      ?? (endpoint.providerId === "deepseek" ? config.deepseekApiKey : undefined);
  }

  private async snapshotKeys(input: ModelSettingsInput, config: AppConfig, submittedKeys = submittedKeyMap(input)): Promise<ReadonlyMap<string, string>> {
    const apiKeys = new Map<string, string>();
    for (const endpoint of [input.primary, input.vision].filter((value): value is ModelEndpointInput => Boolean(value))) {
      if (apiKeys.has(endpoint.providerId)) continue;
      const apiKey = submittedKeys.get(endpoint.providerId) || await this.resolveKey(endpoint, config);
      if (apiKey) apiKeys.set(endpoint.providerId, apiKey);
    }
    return apiKeys;
  }

  private async persistKey(endpoint: ModelEndpointInput, previous: AppConfig, submittedKeys: ReadonlyMap<string, string>): Promise<void> {
    const key = submittedKeys.get(endpoint.providerId)
      || await this.options.credentials.getApiKey(endpoint.providerId)
      || (endpoint.providerId === "deepseek" ? previous.deepseekApiKey : undefined);
    if (!key) throw new ModelConfigurationError();
    await this.options.credentials.setApiKey(endpoint.providerId, key);
  }
}

const TEST_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RwQ0AMAjDwJT9d05HMB9+vgGCZF7bXJrT9XhgwR8gEyETIRMhEyETIRMhEyEThXzH8QM9OMM6fAAAAABJRU5ErkJggg==";

function normalizeCompletionsUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = /\/chat\/completions$/iu.test(pathname) ? pathname : `${pathname}/chat/completions`;
  return url.toString();
}

function modelFailureReasonForStatus(status: number): ModelConfigurationFailureReason {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "request_rejected";
}

function parseJournal(value: unknown): TransactionJournal {
  if (!value || typeof value !== "object") throw new Error("invalid journal");
  const candidate = value as Partial<TransactionJournal>;
  if (candidate.version !== 1 || (candidate.state !== "prepared" && candidate.state !== "committed") || !candidate.previousConfig || !candidate.credentials || typeof candidate.credentials !== "object") throw new Error("invalid journal");
  for (const encoded of Object.values(candidate.credentials)) if (encoded !== null && typeof encoded !== "string") throw new Error("invalid journal");
  return { ...candidate, previousConfig: parseAppConfigValue(candidate.previousConfig) } as TransactionJournal;
}

function safeConfig(config: AppConfig): AppConfig {
  return { models: config.models, converter: config.converter, webSearch: config.webSearch };
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
