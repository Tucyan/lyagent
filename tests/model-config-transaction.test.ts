import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppConfig, saveAppConfig, type AppConfig } from "../src/config/app-config.js";
import { defaultSecretRoot, FileCredentialStore, type SecretProtector } from "../src/config/credential-store.js";
import { ModelConfigService } from "../src/services/model-config-service.js";
import { modelConfigMutexName, withModelConfigLock } from "../src/config/model-config-lock.js";
import { resolveWorkspaceIdentity } from "../src/config/workspace-identity.js";

const roots: string[] = [];
const protector: SecretProtector = {
  protect: async (value) => Buffer.concat([Buffer.from("encrypted:"), value]),
  unprotect: async (value) => value.subarray("encrypted:".length),
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function config(modelId: string): AppConfig {
  return {
    models: { primary: { providerId: "shared", modelId, baseUrl: "https://api.example/v1" } },
    converter: { baseUrl: "http://127.0.0.1:5001", pollIntervalMs: 1000, taskTimeoutSeconds: 3600, maxAttempts: 3 },
    webSearch: { enabled: true, provider: "ddgs", maxResults: 5 },
  };
}

async function setup() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-transaction-"));
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-transaction-secrets-"));
  roots.push(workspaceRoot, secretRoot);
  const credentials = new FileCredentialStore(secretRoot, protector);
  await saveAppConfig(workspaceRoot, config("old-model"));
  await credentials.setApiKey("shared", "old-key");
  const protectedOldKey = await readFile(path.join(secretRoot, `${Buffer.from("shared").toString("base64url")}.bin`));
  return { workspaceRoot, credentials, protectedOldKey };
}

describe("model configuration transaction recovery", () => {
  it.each(["prepared", "credentials", "config"] as const)("restores the old consistent state after a crash in the %s phase", async (phase) => {
    const { workspaceRoot, credentials, protectedOldKey } = await setup();
    const journalPath = path.join(workspaceRoot, "config", "model-settings.transaction.json");
    await writeFile(journalPath, JSON.stringify({ version: 1, state: "prepared", previousConfig: config("old-model"), credentials: { shared: protectedOldKey.toString("base64") } }), "utf8");
    if (phase !== "prepared") await credentials.setApiKey("shared", "new-key");
    if (phase === "config") await saveAppConfig(workspaceRoot, config("new-model"));

    const recovered = new ModelConfigService({ workspaceRoot, credentials, fetchImpl: async () => new Response() });
    expect((await recovered.loadConfig()).models.primary.modelId).toBe("old-model");
    expect((await recovered.status()).primary.modelId).toBe("old-model");
    await expect(recovered.apiKey("shared")).resolves.toBe("old-key");
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a committed state and only clears its leftover journal", async () => {
    const { workspaceRoot, credentials, protectedOldKey } = await setup();
    const journalPath = path.join(workspaceRoot, "config", "model-settings.transaction.json");
    await credentials.setApiKey("shared", "new-key");
    await saveAppConfig(workspaceRoot, config("new-model"));
    await writeFile(journalPath, JSON.stringify({ version: 1, state: "committed", previousConfig: config("old-model"), credentials: { shared: protectedOldKey.toString("base64") } }), "utf8");

    const recovered = new ModelConfigService({ workspaceRoot, credentials, fetchImpl: async () => new Response() });
    expect((await recovered.status()).primary.modelId).toBe("new-model");
    await expect(recovered.apiKey("shared")).resolves.toBe("new-key");
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a legacy DeepSeek credential when changing provider fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-transaction-"));
    const secretRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-transaction-secrets-"));
    roots.push(workspaceRoot, secretRoot);
    await mkdir(path.join(workspaceRoot, "config"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "config", "app.json"), JSON.stringify({ deepseekApiKey: "legacy-key" }), "utf8");
    const credentials = new FileCredentialStore(secretRoot, protector);
    const service = new ModelConfigService({
      workspaceRoot, credentials,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }),
      saveConfig: async () => { throw new Error("simulated config failure"); },
    });
    await expect(service.save({ primary: { providerId: "replacement", modelId: "replacement-model", baseUrl: "https://api.example/v1", apiKey: "replacement-key" } })).rejects.toThrow("simulated config failure");
    expect(await service.status()).toMatchObject({ primary: { providerId: "deepseek", configured: true } });
    await expect(service.apiKey("deepseek")).resolves.toBe("legacy-key");
  });
});

it("serializes model transactions across two service instances", async () => {
  const { workspaceRoot, credentials } = await setup();
  let activeCommits = 0;
  let maxActiveCommits = 0;
  const saveConfig = async (root: string, value: AppConfig) => {
    activeCommits += 1;
    maxActiveCommits = Math.max(maxActiveCommits, activeCommits);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await saveAppConfig(root, value);
    activeCommits -= 1;
  };
  const create = () => new ModelConfigService({ workspaceRoot, credentials, saveConfig, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }) });
  const first = create();
  const second = create();
  await Promise.all([
    first.save({ primary: { providerId: "shared", modelId: "model-a", baseUrl: "https://api.example/v1", apiKey: "key-a" } }),
    second.save({ primary: { providerId: "shared", modelId: "model-b", baseUrl: "https://api.example/v1", apiKey: "key-b" } }),
  ]);
  expect(maxActiveCommits).toBe(1);
  const finalConfig = await loadAppConfig(workspaceRoot);
  expect(await credentials.getApiKey("shared")).toBe(finalConfig.models.primary.modelId === "model-a" ? "key-a" : "key-b");
});

it("keeps endpoint and key snapshots paired across different workspaces", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "course-agent-local-app-data-"));
  const workspaceA = await mkdtemp(path.join(os.tmpdir(), "course-agent-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(os.tmpdir(), "course-agent-workspace-b-"));
  roots.push(localAppData, workspaceA, workspaceB);
  const create = async (workspaceRoot: string) => {
    const identity = await resolveWorkspaceIdentity(workspaceRoot);
    const credentials = new FileCredentialStore(defaultSecretRoot(identity.hash, localAppData), protector);
    return new ModelConfigService({ workspaceRoot: identity.canonicalRoot, credentials, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 }) });
  };
  const serviceA = await create(workspaceA);
  const serviceB = await create(workspaceB);
  await Promise.all([
    serviceA.save({ primary: { providerId: "shared", modelId: "model-a", baseUrl: "https://a.example/v1", apiKey: "key-a" } }),
    serviceB.save({ primary: { providerId: "shared", modelId: "model-b", baseUrl: "https://b.example/v1", apiKey: "key-b" } }),
  ]);
  await expect(serviceA.loadRuntimeConfig()).resolves.toMatchObject({ config: { models: { primary: { modelId: "model-a" } } }, apiKeys: { shared: "key-a" } });
  await expect(serviceB.loadRuntimeConfig()).resolves.toMatchObject({ config: { models: { primary: { modelId: "model-b" } } }, apiKeys: { shared: "key-b" } });
});

it("derives a machine-global mutex name from the canonical workspace identity", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-lock-"));
  roots.push(workspaceRoot);
  const identity = await resolveWorkspaceIdentity(workspaceRoot);
  await expect(modelConfigMutexName(workspaceRoot)).resolves.toBe(`Global\\CourseAgent.ModelConfig.${identity.hash}`);
  await expect(modelConfigMutexName(workspaceRoot)).resolves.toMatch(/^Global\\CourseAgent\.ModelConfig\.[a-f0-9]{64}$/u);
});

it("returns startup config and primary credential from one locked snapshot", async () => {
  const { workspaceRoot, credentials } = await setup();
  const oldConfig = config("old-model");
  oldConfig.models.vision = { providerId: "vision", modelId: "old-vision", baseUrl: "https://vision.example/v1" };
  await saveAppConfig(workspaceRoot, oldConfig);
  await credentials.setApiKey("vision", "old-vision-key");
  const response = () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 });
  const writer = new ModelConfigService({ workspaceRoot, credentials, fetchImpl: async () => response() });
  const reader = new ModelConfigService({ workspaceRoot, credentials, fetchImpl: async () => response() });
  const saving = writer.save({
    primary: { providerId: "shared", modelId: "new-model", baseUrl: "https://new.example/v1", apiKey: "new-key" },
    vision: { providerId: "vision", modelId: "new-vision", baseUrl: "https://new-vision.example/v1", apiKey: "new-vision-key" },
  });
  const snapshot = await reader.loadRuntimeConfig();
  await saving;
  if (snapshot.config.models.primary.modelId === "old-model") {
    expect(snapshot.apiKeys).toEqual({ shared: "old-key", vision: "old-vision-key" });
    expect(snapshot.config.models.vision?.modelId).toBe("old-vision");
  }
  else {
    expect(snapshot.config.models.primary.modelId).toBe("new-model");
    expect(snapshot.config.models.vision?.modelId).toBe("new-vision");
    expect(snapshot.apiKeys).toEqual({ shared: "new-key", vision: "new-vision-key" });
  }
});

it("tests an endpoint with the credential snapshot taken before a concurrent save", async () => {
  const { workspaceRoot, credentials } = await setup();
  let credentialRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { credentialRead = resolve; });
  let releaseCredentialRead!: () => void;
  const credentialReadBlocked = new Promise<void>((resolve) => { releaseCredentialRead = resolve; });
  const readerCredentials = {
    getApiKey: async (providerId: string) => { credentialRead(); await credentialReadBlocked; return credentials.getApiKey(providerId); },
    setApiKey: (providerId: string, apiKey: string) => credentials.setApiKey(providerId, apiKey),
    deleteApiKey: (providerId: string) => credentials.deleteApiKey(providerId),
    listProviderIds: () => credentials.listProviderIds(),
    readProtected: (providerId: string) => credentials.readProtected(providerId),
    restoreProtected: (providerId: string, value: Buffer | undefined) => credentials.restoreProtected(providerId, value),
    protectApiKey: (apiKey: string) => credentials.protectApiKey(apiKey),
  };
  let releaseReaderFetch!: () => void;
  const readerFetchBlocked = new Promise<void>((resolve) => { releaseReaderFetch = resolve; });
  const authorizations: string[] = [];
  const response = () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "configuration_ok" } }] } }] }), { status: 200 });
  const reader = new ModelConfigService({ workspaceRoot, credentials: readerCredentials, fetchImpl: async (_url, init) => { authorizations.push(new Headers(init?.headers).get("authorization") ?? ""); await readerFetchBlocked; return response(); } });
  const writer = new ModelConfigService({ workspaceRoot, credentials, fetchImpl: async () => response() });
  const testing = reader.test({ primary: { providerId: "shared", modelId: "old-model", baseUrl: "https://api.example/v1" } });
  await readStarted;
  const saving = writer.save({ primary: { providerId: "shared", modelId: "new-model", baseUrl: "https://new.example/v1", apiKey: "new-key" } });
  releaseCredentialRead();
  await saving;
  releaseReaderFetch();
  await testing;
  expect(authorizations).toEqual(["Bearer old-key"]);
});

it("serializes long operations through independent OS lock helpers", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-lock-"));
  roots.push(workspaceRoot);
  let active = 0;
  let maxActive = 0;
  const completed: string[] = [];
  const operation = async (name: string, durationMs: number) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    completed.push(name);
    active -= 1;
  };
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  const first = withModelConfigLock(workspaceRoot, () => {
    markFirstEntered();
    return operation("first", 100);
  }, { timeoutMs: 500, pollMs: 5 });
  await firstEntered;
  const second = withModelConfigLock(workspaceRoot, () => operation("second", 0), { timeoutMs: 500, pollMs: 5 });
  await Promise.all([first, second]);
  expect(maxActive).toBe(1);
  expect(completed).toHaveLength(2);
  expect(completed).toEqual(expect.arrayContaining(["first", "second"]));
});

it("bounds the wait for an OS lock held by another helper", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-lock-"));
  roots.push(workspaceRoot);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const first = withModelConfigLock(workspaceRoot, async () => { started(); await blocker; });
  await entered;
  await expect(withModelConfigLock(workspaceRoot, async () => "stolen", { timeoutMs: 50 })).rejects.toThrow("Timed out waiting");
  release();
  await first;
});

it.runIf(process.platform === "win32")("invokes the fatal guard if the OS lock helper exits inside the critical section", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-lock-"));
  roots.push(workspaceRoot);
  const fatal = new Error("fatal lock loss");
  await expect(withModelConfigLock(workspaceRoot, () => new Promise<never>(() => undefined), {
    helperAcquired: (pid) => { process.kill(pid); },
    fatalHandler: () => { throw fatal; },
  })).rejects.toBe(fatal);
});

it.runIf(process.platform === "win32")("acquires the model configuration mutex without inheriting PATH", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "course-agent-lock-no-path-"));
  roots.push(workspaceRoot);
  const previousPath = process.env.Path;
  const previousUpperPath = process.env.PATH;
  delete process.env.Path;
  delete process.env.PATH;
  try {
    await expect(withModelConfigLock(workspaceRoot, async () => "locked")).resolves.toBe("locked");
  } finally {
    if (previousPath !== undefined) process.env.Path = previousPath;
    if (previousUpperPath !== undefined) process.env.PATH = previousUpperPath;
  }
});
