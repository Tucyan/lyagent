import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const appConfigSchema = z.object({
  deepseekApiKey: z.string().trim().min(1).optional(),
  webSearch: z.object({
    enabled: z.boolean().default(true),
    provider: z.literal("ddgs").default("ddgs"),
    maxResults: z.number().int().min(1).max(10).default(5),
    pythonCommand: z.string().trim().min(1).optional(),
  }).optional(),
}).passthrough();

export interface AppConfig {
  deepseekApiKey?: string;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } };
    throw error;
  }
  try {
    const parsed = appConfigSchema.parse(JSON.parse(raw));
    return {
      ...(parsed.deepseekApiKey ? { deepseekApiKey: parsed.deepseekApiKey } : {}),
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
