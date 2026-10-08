import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { appLaunchSpec, defaultWorkspaceRoot, doclingLaunchSpec, writeRuntimeDescriptor } from "../src/launcher/runtime.js";
import { descriptorFor } from "../src/launcher/supervisor.js";
import { launcherMutexName } from "../src/launcher/windows-mutex.js";

it("uses LOCALAPPDATA and builds bundled loopback child commands without secrets", () => {
  expect(defaultWorkspaceRoot({ LOCALAPPDATA: "C:\\Users\\教师\\App Data" })).toBe(path.resolve("C:\\Users\\教师\\App Data", "CourseAgent", "workspace"));
  const releaseRoot = "C:\\发布 包";
  const docling = doclingLaunchSpec(releaseRoot, { port: 8001, device: "auto", artifactsPath: "C:\\models\\docling" });
  expect(docling.command).toBe(path.join(releaseRoot, "runtime", "python", "python.exe"));
  expect(docling.args).toEqual(["-m", "docling_serve", "run"]);
  expect(docling.cwd).toBe(releaseRoot);
  expect(docling.env).toMatchObject({
    UVICORN_HOST: "127.0.0.1",
    UVICORN_PORT: "8001",
    UVICORN_WORKERS: "1",
    DOCLING_SERVE_ARTIFACTS_PATH: "C:\\models\\docling",
    DOCLING_DEVICE: "auto",
    DOCLING_INFERENCE_COMPILE_TORCH_MODELS: "false",
    DOCLING_SERVE_ENABLE_UI: "false",
    DOCLING_SERVE_ENG_KIND: "local",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1",
  });
  const app = appLaunchSpec(releaseRoot, { workspaceRoot: "C:\\data", appPort: 3002, converterPort: 8001, device: "auto" });
  expect(app.command).toBe(path.join(releaseRoot, "runtime", "node", "node.exe"));
  expect(app.args).toEqual([path.join(releaseRoot, "app", "dist", "src", "main.js")]);
  expect(app.cwd).toBe(path.join(releaseRoot, "app"));
  expect(JSON.stringify(app)).not.toMatch(/api.?key|secret/i);
  expect(app.env).toMatchObject({ PORT: "3002", COURSE_AGENT_CONVERTER_PORT: "8001", COURSE_AGENT_DOCLING_DEVICE: "auto" });
  expect(app.env).not.toHaveProperty("COURSE_AGENT_MINERU_PORT");
});

it("atomically writes a private runtime descriptor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-write-")); const file = path.join(root, "config", "runtime.json");
  const descriptor = descriptorFor({ workspaceHash: "b".repeat(64), ownerToken: "11111111-1111-4111-8111-111111111111", pid: 12, appPort: 3001, converterPort: 8000, device: "auto", startedAt: new Date().toISOString() });
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
  expect(bat).not.toMatch(/mineru-api/i);
  expect(bat).toMatch(/if not exist/i);
});

it.skipIf(process.platform !== "win32")("BAT shows actionable Chinese guidance after a launcher failure in a spaced path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "启动提示 验证-"));
  try {
    await mkdir(path.join(root, "runtime/node"), { recursive: true });
    await mkdir(path.join(root, "runtime/python/Lib/site-packages/docling_serve"), { recursive: true });
    await mkdir(path.join(root, "app/dist/src"), { recursive: true });
    await copyFile(process.execPath, path.join(root, "runtime/node/node.exe"));
    await writeFile(path.join(root, "runtime/python/python.exe"), "test-only placeholder");
    await writeFile(path.join(root, "app/dist/src/launcher.js"), "process.exit(2);");
    const bat = path.join(root, "start-course-agent.bat");
    await copyFile(path.resolve("start-course-agent.bat"), bat);
    const result = spawnSync(path.join(process.env.SystemRoot!, "System32/cmd.exe"), ["/d", "/c", `""${bat}" <nul"`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("启动未完成。请保留上方提示；已有业务数据请勿删除，不要反复双击启动。");
    expect(result.stderr).not.toContain("not recognized");
  } finally {
    if (!path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Test cleanup path escaped temporary directory");
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for Docling model readiness rather than process liveness alone", async () => {
  const source = await readFile(path.resolve("src", "launcher.ts"), "utf8");
  expect(source).toContain("/ready");
  expect(source).not.toContain("/health`, child, 60_000");
  expect(source).toContain("cwd: spec.cwd");
});
