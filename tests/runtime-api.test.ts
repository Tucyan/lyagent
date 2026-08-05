import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createServer } from "../src/api/server.js";

it("returns only sanitized launcher runtime state", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-api-"));
  const requestRestart: number[] = [];
  const app = await createServer({ workspaceRoot, runtimeStatus: { appVersion: "1.2.3", appPort: 3002, converter: { provider: "docling", status: "ready", version: "1.28.0", device: "auto", port: 8001 }, workspaceConfigured: true }, runtimeOwnerToken: "instance-1", requestRestart: () => requestRestart.push(42) });
  const response = await app.inject({ method: "GET", url: "/api/system/runtime" });
  expect(response.json()).toEqual({ appVersion: "1.2.3", appPort: 3002, converter: { provider: "docling", status: "ready", version: "1.28.0", device: "auto", port: 8001 }, workspaceConfigured: true });
  expect(response.body).not.toMatch(/[A-Z]:\\|"pid"|error/i);
  expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ ok: true, ready: true, instanceId: "instance-1" });
  await app.close(); await rm(workspaceRoot, { recursive: true, force: true });
});
