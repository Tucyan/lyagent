import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceIdentity } from "./config/workspace-identity.js";
import { acquireLauncherMutex } from "./launcher/windows-mutex.js";
import { appLaunchSpec, defaultWorkspaceRoot, doclingLaunchSpec, DOCLING_SERVE_VERSION, writeRuntimeDescriptor, type LaunchSpec } from "./launcher/runtime.js";
import { chooseDoclingDevice, descriptorFor, PortReservation, readHealthyDescriptor, runSupervisor, type LauncherChild } from "./launcher/supervisor.js";
import { prepareDoclingArtifacts, type DoclingDownloadSpec } from "./launcher/docling-artifacts.js";

class LauncherFailure extends Error { constructor(message: string, public readonly code: number) { super(message); } }
class ShutdownRequested extends Error {}

const releaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.stdout.write("正在启动 Course Agent。请保持本窗口运行，不要重复双击启动文件。\n");
const workspaceRoot = process.env.COURSE_AGENT_WORKSPACE ? path.resolve(process.env.COURSE_AGENT_WORKSPACE) : defaultWorkspaceRoot(process.env);
const identity = await resolveWorkspaceIdentity(workspaceRoot);
const descriptorFile = path.join(identity.canonicalRoot, "config", "runtime.json");
const mutex = await acquireLauncherMutex(identity.hash);

if (!mutex.acquired) {
  const existing = await readHealthyDescriptor(descriptorFile, { workspaceHash: identity.hash, isProcessAlive, processStartedAt: windowsProcessStartedAt, health: (url, token) => healthCheck(url, token) });
  if (!existing) fail("Course Agent 已在启动或运行。请等待原启动窗口就绪；如果原窗口已报错，关闭它后再启动，勿并行重复运行。", 3);
  openBrowser(existing.appUrl); process.exit(0);
}

await rm(descriptorFile, { force: true });

const device = chooseDoclingDevice(process.env);
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) fail("无法确定 Docling 模型目录。", 1);
process.stdout.write("正在准备文档转换模型。full 包通常可直接使用本地模型；首次启动请耐心等待。\n");
const artifactsPath = await prepareDoclingArtifacts({ releaseRoot, localAppData, doclingServeVersion: DOCLING_SERVE_VERSION, runDownload: runDoclingDownload });
const appCandidates = Array.from({ length: 10 }, (_, index) => 3001 + index); let appReservation = await PortReservation.acquire(appCandidates);
const converterCandidates = Array.from({ length: 10 }, (_, index) => 8000 + index); let converterReservation = await PortReservation.acquire(converterCandidates);
let converterReleased = false; let appReleased = false; let opened = false;
let requestShutdown!: () => void; let shuttingDown = false; const ownedInstanceIds = new Set<string>(); const shutdownController = new AbortController();
const shutdown = new Promise<void>((resolve) => { requestShutdown = () => { shuttingDown = true; shutdownController.abort(); resolve(); }; for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as NodeJS.Signals[]) process.once(signal, requestShutdown); });
let supervision: ReturnType<typeof runSupervisor> | undefined;

try {
  supervision = runSupervisor({
      device, maxUnexpectedRestarts: 2,
      startConverter: async () => {
        process.stdout.write("正在启动文档转换服务，首次加载可能需要数分钟。就绪后会自动打开网页。\n");
        const remaining = [converterReservation.port, ...converterCandidates.filter((port) => port !== converterReservation.port)];
        while (remaining.length > 0) {
          if (shuttingDown) throw new ShutdownRequested();
          if (converterReleased) converterReservation = await PortReservation.acquire(remaining);
          if (shuttingDown) throw new ShutdownRequested();
          await converterReservation.release(); converterReleased = true;
          const child = startChild(doclingLaunchSpec(releaseRoot, { port: converterReservation.port, device, artifactsPath }));
          if (await waitForOwnedHealth(`http://127.0.0.1:${converterReservation.port}/ready`, child, 10 * 60_000, undefined, shutdownController.signal, "文档转换服务") && !shuttingDown) { process.stdout.write("文档转换服务已就绪。\n"); return child; }
          await terminateTree(child.pid, child.startedAt); remaining.splice(remaining.indexOf(converterReservation.port), 1);
          if (shuttingDown) throw new ShutdownRequested();
        }
        throw new LauncherFailure("文档转换服务未能启动。请关闭本次窗口，确认没有重复启动的实例；若再次失败，请保留本窗口提示，提供发布包版本和是否有其他程序占用端口，暂时不要反复启动。", 1);
      },
      startApp: async (selected) => {
        process.stdout.write("正在启动应用网页服务。\n");
        const remaining = [appReservation.port, ...appCandidates.filter((port) => port !== appReservation.port)];
        while (remaining.length > 0) {
          if (shuttingDown) throw new ShutdownRequested();
          if (appReleased) appReservation = await PortReservation.acquire(remaining); if (shuttingDown) throw new ShutdownRequested(); await appReservation.release(); appReleased = true;
          const instanceId = randomUUID(); const startedAt = Date.now();
          ownedInstanceIds.add(instanceId);
          const child = startChild(appLaunchSpec(releaseRoot, { workspaceRoot: identity.canonicalRoot, appPort: appReservation.port, converterPort: converterReservation.port, device: selected, ownerToken: instanceId }));
          if (await waitForOwnedHealth(`http://127.0.0.1:${appReservation.port}/api/health`, child, 30_000, instanceId, shutdownController.signal, "应用网页服务") && !shuttingDown) {
            const supervisorStartedAt = Date.now() - Math.round(process.uptime() * 1_000);
            await writeRuntimeDescriptor(descriptorFile, descriptorFor({ workspaceHash: identity.hash, ownerToken: instanceId, pid: child.pid, processStartedAt: child.startedAt ?? startedAt, supervisorPid: process.pid, supervisorStartedAt, appPort: appReservation.port, converterPort: converterReservation.port, device: selected, startedAt: new Date(startedAt).toISOString() }));
            process.stdout.write(`应用已就绪：http://127.0.0.1:${appReservation.port} 。若浏览器未自动打开，请复制此地址；结束使用时关闭本窗口。\n`);
            if (!opened) { opened = true; openBrowser(`http://127.0.0.1:${appReservation.port}`); }
            return child;
          }
          await terminateTree(child.pid, child.startedAt); remaining.splice(remaining.indexOf(appReservation.port), 1);
          if (shuttingDown) throw new ShutdownRequested();
        }
        throw new LauncherFailure("应用网页服务未能启动。请关闭本次窗口后重新启动一次；仍失败时保留提示并提供发布包版本，已有业务数据请勿删除。", 1);
      },
      isConverterHealthy: () => healthCheck(`http://127.0.0.1:${converterReservation.port}/ready`), terminateTree, shutdown,
    });
  const result = await Promise.race([
    supervision,
    mutex.lost,
  ]);
  if (result.exitCode !== 0) throw new LauncherFailure("Course Agent 异常退出次数过多，请查看安全日志后重试。", result.exitCode);
} catch (error) { requestShutdown(); await supervision?.catch(() => undefined); if (error instanceof ShutdownRequested) process.exitCode = 0; else { const failure = error instanceof LauncherFailure ? error : new LauncherFailure("Course Agent 启动失败。请确认发布包完整且本机资源充足。", 1); process.stderr.write(`${failure.message}\n`); process.exitCode = failure.code; } }
finally {
  if (!appReleased) await appReservation.release(); if (!converterReleased) await converterReservation.release();
  await removeOwnedDescriptor(descriptorFile, ownedInstanceIds); await mutex.release();
}

function startChild(spec: LaunchSpec): LauncherChild {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, windowsHide: true, stdio: "ignore", env: childEnvironment(spec.env) });
  if (!child.pid) throw new Error("子进程未能启动。");
  const startedAt = Date.now(); const exited = childExit(child);
  return { pid: child.pid, startedAt, wait: () => exited };
}

function childEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const names = ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"] as const;
  const safe = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
  return { ...safe, ...overrides };
}

function childExit(child: ChildProcess): Promise<number | null> { return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); }); }
async function terminateTree(pid: number, expectedStartedAt?: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("拒绝终止未经验证的子进程。");
  if (!isProcessAlive(pid)) return;
  if (expectedStartedAt !== undefined) { const actual = await windowsProcessStartedAt(pid); if (actual === undefined || Math.abs(actual - expectedStartedAt) > 5_000) throw new Error("拒绝终止身份不匹配的子进程。"); }
  const code = await new Promise<number | null>((resolve, reject) => { const killer = spawn(systemBinary("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.once("error", reject); killer.once("exit", resolve); });
  if (code !== 0 && isProcessAlive(pid)) throw new Error("子进程树未能安全回收。");
}
function openBrowser(url: string): void { const parsed = new URL(url); if (parsed.hostname !== "127.0.0.1") return; spawn(systemBinary("rundll32.exe"), ["url.dll,FileProtocolHandler", parsed.toString()], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
function systemBinary(name: string): string { const root = process.env.SystemRoot ?? process.env.WINDIR; if (!root) throw new Error("无法确定 Windows 系统目录。"); return path.join(root, "System32", name); }
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function healthCheck(url: string, expectedOwner?: string, signal?: AbortSignal): Promise<boolean> { try { const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_500)]) : AbortSignal.timeout(1_500) }); if (!response.ok) return false; if (!expectedOwner) return true; const body = await response.json() as { instanceId?: unknown }; return body.instanceId === expectedOwner; } catch { return false; } }
async function waitForOwnedHealth(url: string, child: LauncherChild, timeoutMs: number, expectedOwner?: string, signal?: AbortSignal, label?: string): Promise<boolean> {
  const started = Date.now(); let nextProgress = started + 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (label && Date.now() >= nextProgress) { process.stdout.write(`${label}仍在准备，已等待约${Math.floor((Date.now() - started) / 1000)}秒。请保持窗口运行，不要重复启动。\n`); nextProgress += 30_000; }
    const outcome = await Promise.race([healthCheck(url, expectedOwner, signal).then((healthy) => healthy ? "healthy" as const : "retry" as const), child.wait().then(() => "exited" as const), ...(signal ? [new Promise<"shutdown">((resolve) => signal.addEventListener("abort", () => resolve("shutdown"), { once: true }))] : [])]);
    if (outcome === "shutdown") return false;
    if (outcome === "exited") return false;
    if (outcome === "healthy") return Promise.race([child.wait().then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))]);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function capture(command: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, env: childEnvironment(), stdio: ["ignore", "pipe", "ignore"] }); let output = ""; child.stdout?.on("data", (chunk) => { if (output.length < 10_000) output += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error("硬件探测失败。"))); }); }
async function windowsProcessStartedAt(pid: number): Promise<number | undefined> { try { const powershell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"); const value = (await capture(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`])).trim(); const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; } catch { return undefined; } }
async function removeOwnedDescriptor(filename: string, ownerIds: Set<string>): Promise<void> { try { const value = JSON.parse(await readFile(filename, "utf8")) as { ownerToken?: unknown }; if (typeof value.ownerToken === "string" && ownerIds.has(value.ownerToken)) await rm(filename, { force: true }); } catch { /* absent or replaced by a newer owner */ } }

function runDoclingDownload(spec: DoclingDownloadSpec): Promise<void> {
  process.stdout.write("Docling 首次启动正在准备模型，请保持网络连接…\n");
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, windowsHide: false, stdio: ["ignore", "inherit", "inherit"], env: childEnvironment(spec.env) });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Docling 模型准备失败。")));
  });
}
function fail(message: string, code: number): never { process.stderr.write(`${message}\n`); process.exit(code); }
