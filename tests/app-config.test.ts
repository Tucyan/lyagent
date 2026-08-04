import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfigError, loadAppConfig } from "../src/config/app-config.js";

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

    await expect(loadAppConfig(root)).resolves.toEqual({ deepseekApiKey: "test-key", mineru: { baseUrl: "http://127.0.0.1:8000", pollIntervalMs: 1000, taskTimeoutSeconds: 3600, maxAttempts: 3 }, webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } });
  });

  it("uses DDGS web-search defaults when the local file is absent", async () => {
    const root = await temporaryWorkspace();

    await expect(loadAppConfig(root)).resolves.toEqual({ mineru: { baseUrl: "http://127.0.0.1:8000", pollIntervalMs: 1000, taskTimeoutSeconds: 3600, maxAttempts: 3 }, webSearch: { enabled: true, provider: "ddgs", maxResults: 5 } });
  });

  it("rejects an invalid local key type", async () => {
    const root = await temporaryWorkspace('{"deepseekApiKey":42}');

    await expect(loadAppConfig(root)).rejects.toBeInstanceOf(AppConfigError);
  });

  it("loads bounded loopback MinerU settings", async () => {
    const root = await temporaryWorkspace('{"mineru":{"baseUrl":"http://localhost:9000","pollIntervalMs":250,"taskTimeoutSeconds":120,"maxAttempts":2}}');
    await expect(loadAppConfig(root)).resolves.toMatchObject({ mineru: { baseUrl: "http://localhost:9000", pollIntervalMs: 250, taskTimeoutSeconds: 120, maxAttempts: 2 } });
  });
});
