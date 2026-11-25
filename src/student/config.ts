import path from "node:path";
import { z } from "zod";
import { modelProviderIdSchema, type ModelEndpointConfig } from "../config/app-config.js";
import { modelBaseUrlSchema } from "../config/model-base-url.js";

export interface StudentServerConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  publicOrigin?: string;
  trustProxy: boolean;
  timeZone: string;
  sessionTtlHours: number;
  model?: {
    endpoint: ModelEndpointConfig;
    apiKey: string;
  };
  bootstrapAdmin?: {
    username: string;
    password: string;
    displayName: string;
  };
  webSearch: {
    enabled: boolean;
    maxResults: number;
    pythonCommand?: string;
  };
}

const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveIntSchema = z.coerce.number().int().min(1).max(24 * 365);

export function loadStudentServerConfig(env: NodeJS.ProcessEnv = process.env): StudentServerConfig {
  const host = env.STUDENT_HOST?.trim() || "127.0.0.1";
  const port = portSchema.parse(env.STUDENT_PORT?.trim() || "3010");
  const workspaceRoot = path.resolve(env.STUDENT_WORKSPACE_ROOT?.trim() || "workspace");
  const publicOriginRaw = env.STUDENT_PUBLIC_ORIGIN?.trim();
  const publicOrigin = publicOriginRaw ? new URL(publicOriginRaw).origin : undefined;
  const trustProxy = parseBoolean(env.STUDENT_TRUST_PROXY);
  const timeZone = validateTimeZone(env.STUDENT_TIMEZONE?.trim() || "Asia/Shanghai");
  const sessionTtlHours = positiveIntSchema.parse(env.STUDENT_SESSION_TTL_HOURS?.trim() || "168");

  const providerIdRaw = env.STUDENT_MODEL_PROVIDER?.trim();
  const modelIdRaw = env.STUDENT_MODEL_ID?.trim();
  const baseUrlRaw = env.STUDENT_MODEL_BASE_URL?.trim();
  const apiKeyRaw = env.STUDENT_MODEL_API_KEY?.trim();

  let model: StudentServerConfig["model"];
  if (providerIdRaw || modelIdRaw || baseUrlRaw || apiKeyRaw) {
    if (!providerIdRaw || !modelIdRaw || !baseUrlRaw || !apiKeyRaw) {
      throw new Error("Incomplete STUDENT_MODEL_* configuration: provider, model, baseUrl, and apiKey are all required when configuring a model");
    }
    const providerId = modelProviderIdSchema.parse(providerIdRaw);
    const modelId = z.string().trim().min(1).max(160).parse(modelIdRaw);
    const baseUrl = modelBaseUrlSchema.parse(baseUrlRaw);
    model = { endpoint: { providerId, modelId, baseUrl }, apiKey: apiKeyRaw };
  }

  const adminUser = env.STUDENT_BOOTSTRAP_ADMIN_USERNAME?.trim();
  const adminPass = env.STUDENT_BOOTSTRAP_ADMIN_PASSWORD?.trim();
  let bootstrapAdmin: StudentServerConfig["bootstrapAdmin"];
  if (adminUser || adminPass) {
    if (!adminUser || !adminPass) {
      throw new Error("Both STUDENT_BOOTSTRAP_ADMIN_USERNAME and STUDENT_BOOTSTRAP_ADMIN_PASSWORD are required");
    }
    bootstrapAdmin = {
      username: adminUser,
      password: adminPass,
      displayName: env.STUDENT_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "教师管理员",
    };
  }

  const webSearchEnabled = env.STUDENT_WEB_SEARCH_ENABLED === undefined
    ? true
    : parseBoolean(env.STUDENT_WEB_SEARCH_ENABLED);
  const webSearchMaxResults = z.coerce.number().int().min(1).max(10).parse(env.STUDENT_WEB_SEARCH_MAX_RESULTS?.trim() || "5");
  const webSearchPython = env.STUDENT_WEB_SEARCH_PYTHON?.trim();

  return {
    host,
    port,
    workspaceRoot,
    ...(publicOrigin ? { publicOrigin } : {}),
    trustProxy,
    timeZone,
    sessionTtlHours,
    ...(model ? { model } : {}),
    ...(bootstrapAdmin ? { bootstrapAdmin } : {}),
    webSearch: {
      enabled: webSearchEnabled,
      maxResults: webSearchMaxResults,
      ...(webSearchPython ? { pythonCommand: webSearchPython } : {}),
    },
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function validateTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new Error(`Invalid STUDENT_TIMEZONE: ${timeZone}`);
  }
}

export function formatDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}
