import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createServer } from "../src/api/server.js";
import { GradingBatchService } from "../src/services/grading-batch-service.js";
import { GradingBatchUploadService } from "../src/services/grading-batch-upload-service.js";

it("returns only sanitized launcher runtime state", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-api-"));
  const requestRestart: number[] = [];
  const app = await createServer({ workspaceRoot, runtimeStatus: { appVersion: "1.2.3", appPort: 3002, converter: { provider: "docling", status: "ready", version: "1.28.0", device: "auto", port: 8001 }, workspaceConfigured: true }, runtimeOwnerToken: "instance-1", requestRestart: () => requestRestart.push(42) });
  const response = await app.inject({ method: "GET", url: "/api/system/runtime" });
  expect(response.json()).toEqual({ appVersion: "1.2.3", appPort: 3002, converter: { provider: "docling", status: "ready", version: "1.28.0", device: "auto", port: 8001 }, workspaceConfigured: true, gradingRecovery: { status: "ready" } });
  expect(response.body).not.toMatch(/[A-Z]:\\|"pid"|error/i);
  expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ ok: true, ready: true, instanceId: "instance-1" });
  await app.close(); await rm(workspaceRoot, { recursive: true, force: true });
});

it("re-checks Docling health dynamically on /api/system/runtime and /api/health", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-api-live-"));
  let healthy = false;
  const conversionClient = {
    async health() {
      if (!healthy) throw new Error("converter offline");
      return { ok: true as const, version: "1.29.0" };
    },
    async submit() {
      throw new Error("not used");
    },
    async status() {
      throw new Error("not used");
    },
    async result() {
      throw new Error("not used");
    },
  };
  const app = await createServer({
    workspaceRoot,
    conversionClient,
    runtimeStatus: {
      appVersion: "1.2.3",
      appPort: 3002,
      converter: { provider: "docling", status: "unavailable", version: "development", device: "auto", port: 5001 },
      workspaceConfigured: true,
    },
  });
  try {
    expect((await app.inject({ method: "GET", url: "/api/system/runtime" })).json().converter.status).toBe("unavailable");
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ ok: true, ready: false });

    healthy = true;
    const recovered = (await app.inject({ method: "GET", url: "/api/system/runtime" })).json();
    expect(recovered.converter).toMatchObject({ status: "ready", version: "1.29.0" });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ ok: true, ready: true });
  } finally {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("waits for upload replacement recovery before reconciling batches and accepting grading writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-order-"));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const recoverUploads = GradingBatchUploadService.prototype.recover;
  const uploads = vi.spyOn(GradingBatchUploadService.prototype, "recover").mockImplementation(async function (this: GradingBatchUploadService, options) {
    enter();
    await waiting;
    return recoverUploads.call(this, options);
  });
  const batches = vi.spyOn(GradingBatchService.prototype, "recover");
  const app = await createServer({
    workspaceRoot: root,
    gradingAgentFactory: () => ({ async run() { return { kind: "reply", reply: "not invoked" }; } }),
  });
  try {
    await entered;
    expect(batches).not.toHaveBeenCalled();
    expect((await app.inject("/api/health")).json().gradingRecovery).toEqual({ status: "starting" });
    const blocked = await app.inject({ method: "POST", url: "/api/grading/batches", payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: "GRADING_RECOVERY_IN_PROGRESS" });
    expect((await app.inject("/api/grading/batches")).statusCode).toBe(200);
    release();
    await vi.waitFor(async () => {
      expect((await app.inject("/api/system/runtime")).json().gradingRecovery).toEqual({ status: "ready" });
    });
    expect(batches).toHaveBeenCalledOnce();
    expect((await app.inject({ method: "POST", url: "/api/grading/batches", payload: {} })).statusCode).toBe(400);
  } finally {
    release();
    await app.close();
    uploads.mockRestore();
    batches.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a fixed grading recovery code without disabling health or disclosing storage errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-error-"));
  const batches = vi.spyOn(GradingBatchService.prototype, "recover").mockRejectedValue(new Error("private storage error"));
  const app = await createServer({ workspaceRoot: root });
  try {
    await vi.waitFor(async () => {
      const health = await app.inject("/api/health");
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true, gradingRecovery: { status: "failed", errorCode: "GRADING_RECOVERY_FAILED" } });
      expect(health.body).not.toContain("private storage error");
    });
    const blocked = await app.inject({ method: "POST", url: "/api/grading/batches", payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: "GRADING_RECOVERY_FAILED" });
  } finally {
    await app.close();
    batches.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
