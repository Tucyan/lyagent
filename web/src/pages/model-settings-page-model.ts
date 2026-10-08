type SaveNoticeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
const SAVE_NOTICE_KEY = "course-agent-model-save-completed";
export function rememberModelSettingsSave(storage: SaveNoticeStorage): boolean {
  try { storage.setItem(SAVE_NOTICE_KEY, "completed"); return true; } catch { return false; }
}
export function consumeModelSettingsSave(storage: SaveNoticeStorage): string {
  try {
    const completed = storage.getItem(SAVE_NOTICE_KEY) === "completed";
    storage.removeItem(SAVE_NOTICE_KEY);
    return completed ? "设置已生效，应用已重启。请点击“返回工作台并继续”开展业务。" : "";
  } catch { return ""; }
}

export interface ModelEndpointStatus {
  providerId: string;
  modelId: string;
  baseUrl: string;
  configured: boolean;
}

export interface ModelSettingsStatus {
  primary: ModelEndpointStatus;
  vision?: ModelEndpointStatus;
}

export interface ModelSettingsFormState {
  primary: ModelEndpointStatus & { apiKey: string };
  visionEnabled: boolean;
  visionConfigured: boolean;
  visionUsesPrimaryCredentials: boolean;
  visionProviderId: string;
  visionModelId: string;
  visionBaseUrl: string;
  visionApiKey: string;
}

export interface ModelEndpointPayload {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelSettingsPayload {
  primary: ModelEndpointPayload;
  vision?: ModelEndpointPayload;
}

export type SupportedModelProvider = "qwen-openai" | "openai";

export function modelConfigurationFailureMessage(reason: unknown): string {
  const messages: Record<string, string> = {
    invalid_url: "Base URL 不符合安全要求，请使用 HTTPS 或本机环回地址。",
    missing_api_key: "API Key 为必填项。",
    network_error: "无法连接模型服务，请检查网络和 Base URL。",
    authentication_failed: "模型服务拒绝了 API Key，请检查凭据是否有效。",
    model_not_found: "模型服务未找到该模型 ID，请检查模型名称和部署范围。",
    rate_limited: "模型服务当前限流或免费额度已耗尽，请稍后重试。",
    provider_unavailable: "模型服务暂时不可用，请稍后重试。",
    request_rejected: "模型服务拒绝了验证请求，当前接口可能不兼容工具调用或图片输入。",
    invalid_response: "模型服务返回了无法识别的响应格式。",
    tool_call_missing: "连接成功，但模型未完成必需的工具调用，因此不能用于 Course Agent。",
  };
  return typeof reason === "string" && messages[reason]
    ? messages[reason]
    : "模型连接或保存失败，请检查模型 ID、Base URL 和 API Key。当前表单与已保存设置均未被覆盖。";
}

export async function modelConfigurationFailureReason(response: Pick<Response, "json">): Promise<unknown> {
  try { return (await response.json() as { reason?: unknown }).reason; }
  catch { return undefined; }
}

export function modelSettingsStateFromStatus(status: ModelSettingsStatus): ModelSettingsFormState {
  const vision = status.vision;
  const primaryProviderId = supportedProviderId(status.primary);
  const visionProviderId = vision ? supportedProviderId(vision) : "qwen-openai";
  const shared = Boolean(vision && visionProviderId === primaryProviderId && vision.baseUrl === status.primary.baseUrl);
  return {
    primary: { ...status.primary, providerId: primaryProviderId, configured: status.primary.configured && primaryProviderId === status.primary.providerId, apiKey: "" },
    visionEnabled: Boolean(vision),
    visionConfigured: Boolean(vision?.configured),
    visionUsesPrimaryCredentials: vision ? shared : true,
    visionProviderId,
    visionModelId: vision?.modelId ?? "",
    visionBaseUrl: vision?.baseUrl ?? status.primary.baseUrl,
    visionApiKey: "",
  };
}

export function buildModelSettingsPayload(state: ModelSettingsFormState): ModelSettingsPayload {
  const primaryProviderId = effectivePrimaryProviderId(state.primary.providerId, state.primary.baseUrl);
  const primary = endpoint(primaryProviderId, state.primary.modelId, state.primary.baseUrl, state.primary.apiKey, state.primary.configured && primaryProviderId === state.primary.providerId, "主模型");
  if (!state.visionEnabled) return { primary };
  const modelId = required(state.visionModelId, "视觉模型 ID");
  if (state.visionUsesPrimaryCredentials) {
    return { primary, vision: { providerId: primary.providerId, modelId, baseUrl: primary.baseUrl } };
  }
  return {
    primary,
    vision: endpoint(
      state.visionProviderId && state.visionProviderId !== primary.providerId ? state.visionProviderId : independentVisionProviderId(primary.providerId),
      modelId,
      state.visionBaseUrl,
      state.visionApiKey,
      state.visionConfigured && state.visionProviderId !== primary.providerId,
      "视觉模型",
    ),
  };
}

export function modelSettingsRequest(method: "POST" | "PUT", csrfToken: string, payload: ModelSettingsPayload): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(payload),
  };
}

export async function waitForRestartHealth(options: { health(): Promise<boolean>; sleep(milliseconds: number): Promise<void>; maxAttempts?: number }): Promise<boolean> {
  for (let attempt = 0; attempt < (options.maxAttempts ?? 60); attempt += 1) {
    try { if (await options.health()) return true; } catch { /* restarting */ }
    await options.sleep(500);
  }
  return false;
}

export type AppRoute = { kind: "setup" } | { kind: "settings" } | { kind: "app"; path: string } | { kind: "redirect"; href: "/setup" };

export function resolveAppRoute(path: string, primaryConfigured: boolean): AppRoute {
  if (path === "/setup") return { kind: "setup" };
  if (!primaryConfigured) return { kind: "redirect", href: "/setup" };
  if (path === "/settings/models") return { kind: "settings" };
  return { kind: "app", path };
}

function endpoint(providerId: string, modelId: string, baseUrl: string, apiKey: string, configured: boolean, label: string): ModelEndpointPayload {
  const value = {
    providerId: required(providerId, `${label}服务标识`),
    modelId: required(modelId, `${label} ID`),
    baseUrl: required(baseUrl, `${label} Base URL`),
  };
  const secret = apiKey.trim();
  if (!secret && !configured) throw new Error(`${label} API Key 为必填项`);
  return { ...value, ...(secret ? { apiKey: secret } : {}) };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}为必填项`);
  return normalized;
}

function independentVisionProviderId(primaryProviderId: string): string {
  return primaryProviderId === "vision" ? "vision-independent" : "vision";
}

function effectivePrimaryProviderId(providerId: string, baseUrl: string): string {
  if (providerId === "qwen-openai" || providerId === "openai") return providerId;
  return supportedProviderId({ providerId, modelId: "", baseUrl });
}

function supportedProviderId(endpoint: Pick<ModelEndpointStatus, "providerId" | "modelId" | "baseUrl">): SupportedModelProvider {
  if (endpoint.providerId === "openai") return "openai";
  if (endpoint.providerId === "qwen-openai") return "qwen-openai";
  return /qwen|compatible-mode/iu.test(`${endpoint.modelId} ${endpoint.baseUrl}`) ? "qwen-openai" : "openai";
}
