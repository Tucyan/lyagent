import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const appConfigSchema = z.object({
  deepseekApiKey: z.string().trim().min(1).optional(),
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
  deepseekApiKey?: string;
  mineru: { baseUrl: string; pollIntervalMs: number; taskTimeoutSeconds: number; maxAttempts: number };
  webSearch: { enabled: boolean; provider: "ddgs"; maxResults: number; pythonCommand?: string };
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mineru: defaultMineru(), webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } };
    throw error;
  }
  try {
    const parsed = appConfigSchema.parse(JSON.parse(raw));
    return {
      ...(parsed.deepseekApiKey ? { deepseekApiKey: parsed.deepseekApiKey } : {}),
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

function defaultMineru(): AppConfig["mineru"] {
  return { baseUrl: "http://127.0.0.1:8000", pollIntervalMs: 1_000, taskTimeoutSeconds: 3_600, maxAttempts: 3 };
}
