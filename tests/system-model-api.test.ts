import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/api/server.js";
import { ModelConfigService } from "../src/services/model-config-service.js";
import { loadAppConfig } from "../src/config/app-config.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-model-api-"));
  roots.push(workspaceRoot);
  const keys = new Map<string, string>();
  const service = new ModelConfigService({
    workspaceRoot,
    credentials: {
      getApiKey: async (id) => keys.get(id),
      setApiKey: async (id, key) => { keys.set(id, key); },
      deleteApiKey: async (id) => { keys.delete(id); },
      listProviderIds: async () => [...keys.keys()],
    },
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok", arguments: "{}" } }] } }] }), { status: 200 })),
  });
  return { workspaceRoot, service, keys };
}

const security = { csrfToken: "csrf-test", isLoopback: () => true, allowedOrigin: "http://127.0.0.1:3001" };

it("returns only non-sensitive model configuration and keeps the legacy status route", async () => {
  const { workspaceRoot, service, keys } = await fixture();
  keys.set("deepseek", "never-return-this");
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });

  const response = await app.inject({ method: "GET", url: "/api/system/models" });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain("never-return-this");
  expect(response.json()).toMatchObject({ primary: { providerId: "deepseek", modelId: "deepseek-v4-flash", configured: true } });
  expect(response.headers["x-csrf-token"]).toBe(security.csrfToken);
  expect((await app.inject({ method: "GET", url: "/api/system/model" })).json()).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", configured: true });
  await app.close();
});

it("reuses one submitted key when primary and vision share a provider", async () => {
  const { workspaceRoot, service, keys } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const response = await app.inject({
    method: "POST", url: "/api/system/models/test",
    headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken },
    payload: {
      primary: { providerId: "shared", modelId: "text-model", baseUrl: "https://api.example/v1", apiKey: "shared-secret" },
      vision: { providerId: "shared", modelId: "vision-model", baseUrl: "https://api.example/v1" },
    },
  });
  expect(response.statusCode).toBe(200);
  expect(keys.size).toBe(0);
  await app.close();
});

it("rolls back credential changes when non-secret config persistence fails", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-model-api-"));
  roots.push(workspaceRoot);
  const keys = new Map([["existing", "old-secret"]]);
  const service = new ModelConfigService({
    workspaceRoot,
    credentials: {
      getApiKey: async (id) => keys.get(id),
      setApiKey: async (id, key) => { keys.set(id, key); },
      deleteApiKey: async (id) => { keys.delete(id); },
      listProviderIds: async () => [...keys.keys()],
    },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }),
    saveConfig: async () => { throw new Error("disk full"); },
  });
  await expect(service.save({ primary: { providerId: "existing", modelId: "model", baseUrl: "https://api.example/v1", apiKey: "replacement-secret" } })).rejects.toThrow("disk full");
  expect(keys.get("existing")).toBe("old-secret");
});

it("tests temporary settings without saving them", async () => {
  const { workspaceRoot, service, keys } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const body = { primary: { providerId: "temporary", modelId: "temp-model", baseUrl: "https://temp.example/v1", apiKey: "temporary-secret" } };
  const response = await app.inject({ method: "POST", url: "/api/system/models/test", headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken }, payload: body });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain("temporary-secret");
  expect(keys.size).toBe(0);
  await app.close();
});

it("protects writes and atomically saves validated settings with restart required", async () => {
  const { workspaceRoot, service, keys } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const body = { primary: { providerId: "custom", modelId: "model-a", baseUrl: "https://api.example/v1", apiKey: "new-secret" } };
  expect((await app.inject({ method: "PUT", url: "/api/system/models", payload: body })).statusCode).toBe(403);
  const bootstrap = await app.inject({ method: "GET", url: "/api/system/models" });
  const csrfToken = bootstrap.headers["x-csrf-token"] as string;
  expect(csrfToken).toBeTruthy();
  expect((await app.inject({ method: "PUT", url: "/api/system/models", headers: { origin: "https://evil.example", "x-csrf-token": csrfToken }, payload: body })).statusCode).toBe(403);
  const saved = await app.inject({ method: "PUT", url: "/api/system/models", headers: { origin: security.allowedOrigin, "x-csrf-token": csrfToken }, payload: body });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ restartRequired: true, primary: { providerId: "custom", configured: true } });
  expect(saved.body).not.toContain("new-secret");
  expect(keys.get("custom")).toBe("new-secret");
  await app.close();
});

it("restores earlier provider keys when a later credential write fails", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-model-api-"));
  roots.push(workspaceRoot);
  const keys = new Map([["primary", "old-primary"], ["vision", "old-vision"]]);
  let failVisionOnce = true;
  const service = new ModelConfigService({
    workspaceRoot,
    credentials: {
      getApiKey: async (id) => keys.get(id),
      setApiKey: async (id, key) => {
        if (id === "vision" && failVisionOnce) { failVisionOnce = false; throw new Error("credential write failed"); }
        keys.set(id, key);
      },
      deleteApiKey: async (id) => { keys.delete(id); },
      listProviderIds: async () => [...keys.keys()],
    },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }),
  });
  await expect(service.save({
    primary: { providerId: "primary", modelId: "text", baseUrl: "https://api.example/v1", apiKey: "new-primary" },
    vision: { providerId: "vision", modelId: "vision", baseUrl: "https://vision.example/v1", apiKey: "new-vision" },
  })).rejects.toThrow("credential write failed");
  expect(keys).toEqual(new Map([["primary", "old-primary"], ["vision", "old-vision"]]));
});

it("serializes concurrent saves across validation, credentials, and config commit", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-model-api-"));
  roots.push(workspaceRoot);
  const keys = new Map<string, string>();
  let active = 0;
  let maxActive = 0;
  const service = new ModelConfigService({
    workspaceRoot,
    credentials: {
      getApiKey: async (id) => keys.get(id),
      setApiKey: async (id, key) => { keys.set(id, key); },
      deleteApiKey: async (id) => { keys.delete(id); },
      listProviderIds: async () => [...keys.keys()],
    },
    fetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 });
    },
  });
  await Promise.all([
    service.save({ primary: { providerId: "shared", modelId: "model-a", baseUrl: "https://api.example/v1", apiKey: "key-a" } }),
    service.save({ primary: { providerId: "shared", modelId: "model-b", baseUrl: "https://api.example/v1", apiKey: "key-b" } }),
  ]);
  expect(maxActive).toBe(1);
  expect((await loadAppConfig(workspaceRoot)).models.primary.modelId).toBe("model-b");
  expect(keys.get("shared")).toBe("key-b");
});
