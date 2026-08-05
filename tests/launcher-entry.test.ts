import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { appLaunchSpec, defaultWorkspaceRoot, mineruLaunchSpec, writeRuntimeDescriptor } from "../src/launcher/runtime.js";
import { descriptorFor } from "../src/launcher/supervisor.js";
import { launcherMutexName } from "../src/launcher/windows-mutex.js";

it("uses LOCALAPPDATA and builds bundled loopback child commands without secrets", () => {
  expect(defaultWorkspaceRoot({ LOCALAPPDATA: "C:\\Users\\教师\\App Data" })).toBe(path.resolve("C:\\Users\\教师\\App Data", "CourseAgent", "workspace"));
  const releaseRoot = "C:\\发布 包";
  const mineru = mineruLaunchSpec(releaseRoot, 8001);
  expect(mineru.command).toBe(path.join(releaseRoot, "runtime", "python", "Scripts", "mineru-api.exe"));
  expect(mineru.args).toEqual(["--host", "127.0.0.1", "--port", "8001"]);
  const app = appLaunchSpec(releaseRoot, { workspaceRoot: "C:\\data", appPort: 3002, mineruPort: 8001, backend: "pipeline" });
  expect(app.command).toBe(path.join(releaseRoot, "runtime", "node", "node.exe"));
  expect(app.args).toEqual([path.join(releaseRoot, "app", "dist", "src", "main.js")]);
  expect(JSON.stringify(app)).not.toMatch(/api.?key|secret/i);
  expect(app.env).toMatchObject({ PORT: "3002", COURSE_AGENT_MINERU_PORT: "8001", COURSE_AGENT_MINERU_BACKEND: "pipeline" });
});

it("atomically writes a private runtime descriptor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-write-")); const file = path.join(root, "config", "runtime.json");
  const descriptor = descriptorFor({ workspaceHash: "b".repeat(64), ownerToken: "11111111-1111-4111-8111-111111111111", pid: 12, appPort: 3001, mineruPort: 8000, backend: "pipeline", startedAt: new Date().toISOString() });
  await writeRuntimeDescriptor(file, descriptor);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(descriptor);
  await rm(root, { recursive: true, force: true });
});

it("scopes the Global Windows mutex to canonical workspace identity", () => {
  expect(launcherMutexName("a".repeat(64))).toBe(`Global\\CourseAgent.Launcher.${"a".repeat(64)}`);
});

it("BAT launches only the bundled launcher through a quoted relative path", async () => {
  const bat = await readFile(path.resolve("start-course-agent.bat"), "utf8");
  expect(bat).toContain('"%~dp0runtime\\node\\node.exe" "%~dp0app\\dist\\src\\launcher.js"');
  expect(bat).not.toMatch(/\bnode\s|\bpython\s|mineru-api/i);
  expect(bat).toMatch(/if not exist/i);
});
