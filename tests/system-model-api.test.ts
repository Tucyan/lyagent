import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/api/server.js";
import { ModelConfigService } from "../src/services/model-config-service.js";
import { loadAppConfig } from "../src/config/app-config.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok", arguments: "{}" } }] } }] }), { status: 200 }))) {
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
      readProtected: async (id) => keys.has(id) ? Buffer.from(keys.get(id)!) : undefined,
      restoreProtected: async (id, value) => { if (value) keys.set(id, value.toString()); else keys.delete(id); },
      protectApiKey: async (key) => Buffer.from(key),
    },
    fetchImpl,
  });
  return { workspaceRoot, service, keys };
}

it("returns a safe model verification reason without exposing provider content", async () => {
  const fetchImpl = vi.fn(async () => new Response("provider detail must stay private", { status: 404 }));
  const { workspaceRoot, service } = await fixture(fetchImpl);
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const response = await app.inject({
    method: "POST", url: "/api/system/models/test",
    headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken },
    payload: { primary: { providerId: "custom", modelId: "missing", baseUrl: "https://api.example/v1", apiKey: "secret" } },
  });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ code: "MODEL_CONFIGURATION_FAILED", reason: "model_not_found" });
  expect(response.body).not.toContain("provider detail");
  expect(response.body).not.toContain("secret");
  await app.close();
});

it("retries one successful response that omits the required tool call", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }));
  const { workspaceRoot, service } = await fixture(fetchImpl);
  await expect(service.test({ primary: { providerId: "custom", modelId: "model", baseUrl: "https://api.example/v1", apiKey: "secret" } })).resolves.toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("retries without tool_choice when a compatible endpoint rejects that optional field", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response("tool_choice is unsupported", { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }));
  const { service } = await fixture(fetchImpl);
  await expect(service.test({ primary: { providerId: "custom", modelId: "model", baseUrl: "https://api.example/v1", apiKey: "secret" } })).resolves.toEqual({ ok: true });
  const retryBody = JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string) as { tool_choice?: unknown };
  expect(retryBody.tool_choice).toBeUndefined();
});

it("validates OpenAI providers through the Responses API", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: "function_call", name: "configuration_ok", arguments: "{}" }] }), { status: 200 }));
  const { service } = await fixture(fetchImpl);
  await expect(service.test({ primary: { providerId: "openai", modelId: "gpt-model", baseUrl: "https://api.example/v1", apiKey: "secret" } })).resolves.toEqual({ ok: true });
  const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls[0]![0]).toBe("https://api.example/v1/responses");
  const body = JSON.parse(calls[0]![1].body as string) as { input?: unknown; messages?: unknown; tools?: Array<{ name?: string; function?: unknown }> };
  expect(body.input).toBeDefined();
  expect(body.messages).toBeUndefined();
  expect(body.tools?.[0]).toMatchObject({ type: "function", name: "configuration_ok" });
  expect(body.tools?.[0]?.function).toBeUndefined();
});

it("validates an OpenAI provider using a full Chat Completions URL", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }));
  const { service } = await fixture(fetchImpl);
  await expect(service.test({ primary: { providerId: "openai", modelId: "gpt-model", baseUrl: "https://botcf.com/v1/chat/completions", apiKey: "secret" } })).resolves.toEqual({ ok: true });
  const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls[0]![0]).toBe("https://botcf.com/v1/chat/completions");
});

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

it("blocks core APIs before setup while leaving health and model setup available", async () => {
  const { workspaceRoot, service } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/system/models" })).statusCode).toBe(200);
  const blocked = await app.inject({ method: "GET", url: "/api/dashboard" });
  expect(blocked.statusCode).toBe(503);
  expect(blocked.json()).toEqual({ code: "SETUP_REQUIRED", message: "请先完成主模型设置" });
  expect((await app.inject({ method: "GET", url: "/api/grading/sessions" })).statusCode).toBe(503);
  await app.close();
});

it("removes an unused vision provider credential when vision is disabled", async () => {
  const { workspaceRoot, service, keys } = await fixture();
  await service.save({
    primary: { providerId: "primary", modelId: "text", baseUrl: "https://primary.example/v1", apiKey: "primary-secret" },
    vision: { providerId: "vision", modelId: "image", baseUrl: "https://vision.example/v1", apiKey: "vision-secret" },
  });
  expect(keys.get("vision")).toBe("vision-secret");
  await service.save({ primary: { providerId: "primary", modelId: "text", baseUrl: "https://primary.example/v1" } });
  expect(keys.get("primary")).toBe("primary-secret");
  expect(keys.has("vision")).toBe(false);
  expect((await service.status()).vision).toBeUndefined();
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

it("tests vision endpoints with an image while keeping tool calls broadly OpenAI-compatible", async () => {
  const { workspaceRoot, service } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const response = await app.inject({
    method: "POST", url: "/api/system/models/test",
    headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken },
    payload: {
      primary: { providerId: "primary", modelId: "text-model", baseUrl: "https://api.example/v1", apiKey: "primary-secret" },
      vision: { providerId: "vision", modelId: "vision-model", baseUrl: "https://vision.example/v1", apiKey: "vision-secret" },
    },
  });
  expect(response.statusCode).toBe(200);
  const fetchImpl = (service as unknown as { options: { fetchImpl: ReturnType<typeof vi.fn> } }).options.fetchImpl;
  const primaryBody = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { tool_choice?: unknown; temperature?: unknown; max_tokens?: unknown; messages: Array<{ content: unknown }> };
  const visionBody = JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string) as { tool_choice?: unknown; temperature?: unknown; max_tokens?: unknown; messages: Array<{ content: unknown }> };
  expect(primaryBody.tool_choice).toBe("required");
  expect(primaryBody.temperature).toBeUndefined();
  expect(primaryBody.max_tokens).toBeUndefined();
  expect(primaryBody.messages[0]!.content).toBeTypeOf("string");
  expect(visionBody.tool_choice).toBe("required");
  expect(visionBody.temperature).toBeUndefined();
  expect(visionBody.max_tokens).toBeUndefined();
  expect(visionBody.messages[0]!.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/png;base64,/) }) }),
  ]));
  const imagePart = (visionBody.messages[0]!.content as Array<{ type: string; image_url?: { url: string } }>).find((part) => part.type === "image_url")!;
  const image = Buffer.from(imagePart.image_url!.url.split(",", 2)[1]!, "base64");
  expect(image.readUInt32BE(16)).toBeGreaterThanOrEqual(32);
  expect(image.readUInt32BE(20)).toBeGreaterThanOrEqual(32);
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
      readProtected: async (id) => keys.has(id) ? Buffer.from(keys.get(id)!) : undefined,
      restoreProtected: async (id, value) => { if (value) keys.set(id, value.toString()); else keys.delete(id); },
      protectApiKey: async (key) => Buffer.from(key),
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

it.each(["http://remote.example/v1", "https://secret@remote.example/v1", "https://remote.example/v1?token=x"])("does not send a key to an unsafe endpoint: %s", async (baseUrl) => {
  const { workspaceRoot, service } = await fixture();
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security });
  const response = await app.inject({ method: "POST", url: "/api/system/models/test", headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken }, payload: { primary: { providerId: "unsafe", modelId: "model", baseUrl, apiKey: "must-not-leak" } } });
  expect(response.statusCode).toBe(400);
  expect((service as unknown as { options: { fetchImpl: ReturnType<typeof vi.fn> } }).options.fetchImpl).not.toHaveBeenCalled();
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
  expect(saved.json()).toMatchObject({ restartScheduled: false });
  expect(saved.body).not.toContain("new-secret");
  expect(keys.get("custom")).toBe("new-secret");
  await app.close();
});

it("acknowledges a saved configuration before requesting a supervised restart", async () => {
  const { workspaceRoot, service } = await fixture();
  const requestRestart = vi.fn(); let scheduled: (() => void) | undefined;
  const app = await createServer({ workspaceRoot, modelConfigService: service, modelApiSecurity: security, requestRestart, runtimeOwnerToken: "instance-old", scheduleRestart: (restart) => { scheduled = restart; } });
  const response = await app.inject({ method: "PUT", url: "/api/system/models", headers: { origin: security.allowedOrigin, "x-csrf-token": security.csrfToken }, payload: { primary: { providerId: "custom", modelId: "model-a", baseUrl: "https://api.example/v1", apiKey: "secret" } } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ restartRequired: true, restartScheduled: true, instanceId: "instance-old" });
  expect(requestRestart).not.toHaveBeenCalled();
  scheduled?.();
  expect(requestRestart).toHaveBeenCalledOnce();
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
      readProtected: async (id) => keys.has(id) ? Buffer.from(keys.get(id)!) : undefined,
      restoreProtected: async (id, value) => { if (value) keys.set(id, value.toString()); else keys.delete(id); },
      protectApiKey: async (key) => Buffer.from(key),
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
      readProtected: async (id) => keys.has(id) ? Buffer.from(keys.get(id)!) : undefined,
      restoreProtected: async (id, value) => { if (value) keys.set(id, value.toString()); else keys.delete(id); },
      protectApiKey: async (key) => Buffer.from(key),
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
