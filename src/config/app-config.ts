import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const modelConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(160),
  baseUrl: z.string().url(),
}).strict();

const appConfigSchema = z.object({
  deepseekApiKey: z.string().trim().min(1).optional(),
  models: z.object({
    primary: modelConfigSchema.default({ providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" }),
    vision: modelConfigSchema.optional(),
  }).optional(),
  mineru: z.object({
    baseUrl: z.string().url().default("http://127.0.0.1:8000"),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000),
    taskTimeoutSeconds: z.number().int().min(10).max(86_400).default(3_600),
    maxAttempts: z.number().int().min(1).max(10).default(3),
  }).optional(),
  webSearch: z.object({
    enabled: z.boolean().default(true),
    provider: z.literal("ddgs").default("ddgs"),
    maxResults: z.number().int().min(1).max(10).default(5),
    pythonCommand: z.string().trim().min(1).optional(),
  }).optional(),
}).passthrough();

export interface AppConfig {
  /** Read-only compatibility for legacy workspace config. Never written. */
  deepseekApiKey?: string;
  models: ModelSettings;
  mineru: { baseUrl: string; pollIntervalMs: number; taskTimeoutSeconds: number; maxAttempts: number };
  webSearch: { enabled: boolean; provider: "ddgs"; maxResults: number; pythonCommand?: string };
}

export interface ModelEndpointConfig {
  providerId: string;
  modelId: string;
  baseUrl: string;
}

export interface ModelSettings {
  primary: ModelEndpointConfig;
  vision?: ModelEndpointConfig | undefined;
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

export async function loadAppConfig(workspaceRoot: string): Promise<AppConfig> {
  const filename = path.join(workspaceRoot, "config", "app.json");
  let raw: string;
  try {
    raw = await readFile(filename, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { models: defaultModels(), mineru: defaultMineru(), webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } };
    throw error;
  }
  try {
    const parsed = appConfigSchema.parse(JSON.parse(raw));
    return {
      ...(parsed.deepseekApiKey ? { deepseekApiKey: parsed.deepseekApiKey } : {}),
      models: parsed.models ?? defaultModels(),
      mineru: parsed.mineru ?? defaultMineru(),
      webSearch: parsed.webSearch ? {
        enabled: parsed.webSearch.enabled,
        provider: parsed.webSearch.provider,
        maxResults: parsed.webSearch.maxResults,
        ...(parsed.webSearch.pythonCommand ? { pythonCommand: parsed.webSearch.pythonCommand } : {}),
      } : { enabled: true, provider: "ddgs", maxResults: 5 },
    };
  } catch {
    throw new AppConfigError("workspace/config/app.json is not a valid local configuration");
  }
}

export async function saveAppConfig(workspaceRoot: string, config: AppConfig): Promise<void> {
  const directory = path.join(workspaceRoot, "config");
  const filename = path.join(directory, "app.json");
  const temporary = path.join(directory, `.app-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  const safe = {
    models: config.models,
    mineru: config.mineru,
    webSearch: config.webSearch,
  };
  await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filename);
}

function defaultMineru(): AppConfig["mineru"] {
  return { baseUrl: "http://127.0.0.1:8000", pollIntervalMs: 1_000, taskTimeoutSeconds: 3_600, maxAttempts: 3 };
}

function defaultModels(): ModelSettings {
  return { primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" } };
}
