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

export function modelSettingsStateFromStatus(status: ModelSettingsStatus): ModelSettingsFormState {
  const vision = status.vision;
  const shared = Boolean(vision && vision.providerId === status.primary.providerId && vision.baseUrl === status.primary.baseUrl);
  return {
    primary: { ...status.primary, apiKey: "" },
    visionEnabled: Boolean(vision),
    visionConfigured: Boolean(vision?.configured),
    visionUsesPrimaryCredentials: vision ? shared : true,
    visionProviderId: vision?.providerId ?? "vision",
    visionModelId: vision?.modelId ?? "",
    visionBaseUrl: vision?.baseUrl ?? status.primary.baseUrl,
    visionApiKey: "",
  };
}

export function buildModelSettingsPayload(state: ModelSettingsFormState): ModelSettingsPayload {
  const primary = endpoint(state.primary.providerId, state.primary.modelId, state.primary.baseUrl, state.primary.apiKey, state.primary.configured, "主模型");
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
