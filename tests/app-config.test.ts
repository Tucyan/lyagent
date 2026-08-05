import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfigError, loadAppConfig, saveAppConfig } from "../src/config/app-config.js";

const roots: string[] = [];

async function temporaryWorkspace(config?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-config-"));
  roots.push(root);
  if (config !== undefined) {
    await mkdir(path.join(root, "config"));
    await writeFile(path.join(root, "config", "app.json"), config, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local app configuration", () => {
  it("loads the DeepSeek key only from workspace/config/app.json", async () => {
    const root = await temporaryWorkspace('{"deepseekApiKey":"test-key"}');

    await expect(loadAppConfig(root)).resolves.toEqual({ deepseekApiKey: "test-key", models: { primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" } }, converter: { baseUrl: "http://127.0.0.1:5001", pollIntervalMs: 1000, taskTimeoutSeconds: 3600, maxAttempts: 3 }, webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } });
  });

  it("uses DDGS web-search defaults when the local file is absent", async () => {
    const root = await temporaryWorkspace();

    await expect(loadAppConfig(root)).resolves.toEqual({ models: { primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" } }, converter: { baseUrl: "http://127.0.0.1:5001", pollIntervalMs: 1000, taskTimeoutSeconds: 3600, maxAttempts: 3 }, webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } });
  });

  it("rejects an invalid local key type", async () => {
    const root = await temporaryWorkspace('{"deepseekApiKey":42}');

    await expect(loadAppConfig(root)).rejects.toBeInstanceOf(AppConfigError);
  });

  it("loads bounded loopback converter settings", async () => {
    const root = await temporaryWorkspace('{"converter":{"baseUrl":"http://localhost:9000","pollIntervalMs":250,"taskTimeoutSeconds":120,"maxAttempts":2}}');
    await expect(loadAppConfig(root)).resolves.toMatchObject({ converter: { baseUrl: "http://localhost:9000", pollIntervalMs: 250, taskTimeoutSeconds: 120, maxAttempts: 2 } });
  });

  it.each(["https://converter.example", "http://192.168.1.10:5001", "http://user:secret@127.0.0.1:5001", "http://127.0.0.1:5001?token=value"]) (
    "rejects an unsafe converter base URL: %s",
    async (baseUrl) => {
      const root = await temporaryWorkspace(JSON.stringify({ converter: { baseUrl } }));
      await expect(loadAppConfig(root)).rejects.toBeInstanceOf(AppConfigError);
    },
  );

  it("reads legacy mineru settings once but saves only the converter field", async () => {
    const root = await temporaryWorkspace('{"mineru":{"baseUrl":"http://localhost:9001","pollIntervalMs":500,"taskTimeoutSeconds":240,"maxAttempts":2}}');
    const config = await loadAppConfig(root);
    expect(config.converter).toEqual({ baseUrl: "http://localhost:9001", pollIntervalMs: 500, taskTimeoutSeconds: 240, maxAttempts: 2 });

    await saveAppConfig(root, config);
    const saved = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "config", "app.json"), "utf8")));
    expect(saved.converter).toEqual(config.converter);
    expect(saved).not.toHaveProperty("mineru");
  });

  it("prefers converter settings when legacy mineru settings are also present", async () => {
    const root = await temporaryWorkspace(JSON.stringify({
      converter: { baseUrl: "http://127.0.0.1:5002" },
      mineru: { baseUrl: "http://127.0.0.1:9002" },
    }));
    await expect(loadAppConfig(root)).resolves.toMatchObject({ converter: { baseUrl: "http://127.0.0.1:5002" } });
  });

  it("loads independent primary and vision OpenAI-compatible settings", async () => {
    const root = await temporaryWorkspace(JSON.stringify({ models: {
      primary: { providerId: "primary-provider", modelId: "chat-model", baseUrl: "https://models.example/v1" },
      vision: { providerId: "vision-provider", modelId: "vision-model", baseUrl: "https://vision.example/v1" },
    } }));

    await expect(loadAppConfig(root)).resolves.toMatchObject({ models: {
      primary: { providerId: "primary-provider", modelId: "chat-model", baseUrl: "https://models.example/v1" },
      vision: { providerId: "vision-provider", modelId: "vision-model", baseUrl: "https://vision.example/v1" },
    } });
  });

  it.each([
    "http://models.example/v1",
    "http://2130706433/v1",
    "http://127.1/v1",
    "https://user:password@models.example/v1",
    "https://models.example/v1?key=value",
    "https://models.example/v1#fragment",
  ])("rejects an unsafe model base URL: %s", async (baseUrl) => {
    const root = await temporaryWorkspace(JSON.stringify({ models: { primary: { providerId: "unsafe", modelId: "model", baseUrl } } }));
    await expect(loadAppConfig(root)).rejects.toBeInstanceOf(AppConfigError);
  });

  it.each(["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1", "https://models.example/v1"])("allows a safe model base URL: %s", async (baseUrl) => {
    const root = await temporaryWorkspace(JSON.stringify({ models: { primary: { providerId: "safe", modelId: "model", baseUrl } } }));
    await expect(loadAppConfig(root)).resolves.toMatchObject({ models: { primary: { baseUrl } } });
  });

  it.each(["__proto__", "constructor", "contains space", "slash/provider"])("rejects an unsafe provider ID: %s", async (providerId) => {
    const root = await temporaryWorkspace(JSON.stringify({ models: { primary: { providerId, modelId: "model", baseUrl: "https://models.example/v1" } } }));
    await expect(loadAppConfig(root)).rejects.toBeInstanceOf(AppConfigError);
  });

  it("atomically saves non-secret model settings and removes the legacy plaintext key", async () => {
    const root = await temporaryWorkspace('{"deepseekApiKey":"legacy-secret","unrelated":true}');
    const config = await loadAppConfig(root);
    await saveAppConfig(root, { ...config, models: { primary: { providerId: "custom", modelId: "model-a", baseUrl: "https://api.example/v1" } } });

    const saved = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "config", "app.json"), "utf8"));
    expect(saved).not.toContain("legacy-secret");
    expect(JSON.parse(saved)).toMatchObject({ models: { primary: { providerId: "custom", modelId: "model-a", baseUrl: "https://api.example/v1" } } });
  });
});
