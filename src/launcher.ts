import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceIdentity } from "./config/workspace-identity.js";
import { DoclingClient } from "./services/docling-client.js";
import { acquireLauncherMutex } from "./launcher/windows-mutex.js";
import { appLaunchSpec, defaultWorkspaceRoot, mineruLaunchSpec, writeRuntimeDescriptor, type LaunchSpec } from "./launcher/runtime.js";
import { chooseBackend, descriptorFor, PortReservation, readHealthyDescriptor, runSupervisor, type LauncherChild, type MineruBackend } from "./launcher/supervisor.js";

class LauncherFailure extends Error { constructor(message: string, public readonly code: number) { super(message); } }
class ShutdownRequested extends Error {}

const releaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = process.env.COURSE_AGENT_WORKSPACE ? path.resolve(process.env.COURSE_AGENT_WORKSPACE) : defaultWorkspaceRoot(process.env);
const identity = await resolveWorkspaceIdentity(workspaceRoot);
const descriptorFile = path.join(identity.canonicalRoot, "config", "runtime.json");
const mutex = await acquireLauncherMutex(identity.hash);

if (!mutex.acquired) {
  const existing = await readHealthyDescriptor(descriptorFile, { workspaceHash: identity.hash, isProcessAlive, processStartedAt: windowsProcessStartedAt, health: (url, token) => healthCheck(url, token) });
  if (!existing) fail("Course Agent 已在启动或运行，但运行状态无法安全确认。请稍后重试。", 3);
  openBrowser(existing.appUrl); process.exit(0);
}

await rm(descriptorFile, { force: true });

const appCandidates = Array.from({ length: 10 }, (_, index) => 3001 + index); let appReservation = await PortReservation.acquire(appCandidates);
const mineruCandidates = Array.from({ length: 10 }, (_, index) => 8000 + index); let mineruReservation = await PortReservation.acquire(mineruCandidates);
const backend = await chooseBackend({ forceCpu: process.env.COURSE_AGENT_FORCE_CPU === "1", probe: () => probeHardware(releaseRoot) });
let mineruReleased = false; let appReleased = false; let opened = false;
let requestShutdown!: () => void; let shuttingDown = false; const ownedInstanceIds = new Set<string>(); const shutdownController = new AbortController();
const shutdown = new Promise<void>((resolve) => { requestShutdown = () => { shuttingDown = true; shutdownController.abort(); resolve(); }; for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as NodeJS.Signals[]) process.once(signal, requestShutdown); });
let supervision: ReturnType<typeof runSupervisor> | undefined;

try {
  supervision = runSupervisor({
      initialBackend: backend, maxUnexpectedRestarts: 2,
      startMineru: async (selected) => {
        const remaining = [mineruReservation.port, ...mineruCandidates.filter((port) => port !== mineruReservation.port)];
        while (remaining.length > 0) {
          if (shuttingDown) throw new ShutdownRequested();
          if (mineruReleased) mineruReservation = await PortReservation.acquire(remaining); if (shuttingDown) throw new ShutdownRequested(); await mineruReservation.release(); mineruReleased = true;
          const child = startChild(mineruLaunchSpec(releaseRoot, mineruReservation.port));
          if (await waitForOwnedHealth(`http://127.0.0.1:${mineruReservation.port}/health`, child, 60_000, undefined, shutdownController.signal) && !shuttingDown) return child;
          await terminateTree(child.pid, child.startedAt); remaining.splice(remaining.indexOf(mineruReservation.port), 1);
          if (shuttingDown) throw new ShutdownRequested();
        }
        throw new Error("文档转换服务启动失败。");
      },
      smoke: (selected, signal) => smokeMineru(mineruReservation.port, selected, signal),
      startApp: async (selected) => {
        const remaining = [appReservation.port, ...appCandidates.filter((port) => port !== appReservation.port)];
        while (remaining.length > 0) {
          if (shuttingDown) throw new ShutdownRequested();
          if (appReleased) appReservation = await PortReservation.acquire(remaining); if (shuttingDown) throw new ShutdownRequested(); await appReservation.release(); appReleased = true;
          const instanceId = randomUUID(); const startedAt = Date.now();
          ownedInstanceIds.add(instanceId);
          const child = startChild(appLaunchSpec(releaseRoot, { workspaceRoot: identity.canonicalRoot, appPort: appReservation.port, mineruPort: mineruReservation.port, backend: selected, ownerToken: instanceId }));
          if (await waitForOwnedHealth(`http://127.0.0.1:${appReservation.port}/api/health`, child, 30_000, instanceId, shutdownController.signal) && !shuttingDown) {
            const supervisorStartedAt = Date.now() - Math.round(process.uptime() * 1_000);
            await writeRuntimeDescriptor(descriptorFile, descriptorFor({ workspaceHash: identity.hash, ownerToken: instanceId, pid: child.pid, processStartedAt: child.startedAt ?? startedAt, supervisorPid: process.pid, supervisorStartedAt, appPort: appReservation.port, mineruPort: mineruReservation.port, backend: selected, startedAt: new Date(startedAt).toISOString() }));
            if (!opened) { opened = true; openBrowser(`http://127.0.0.1:${appReservation.port}`); }
            return child;
          }
          await terminateTree(child.pid, child.startedAt); remaining.splice(remaining.indexOf(appReservation.port), 1);
          if (shuttingDown) throw new ShutdownRequested();
        }
        throw new Error("Course Agent 服务启动失败。");
      },
      isMineruHealthy: () => healthCheck(`http://127.0.0.1:${mineruReservation.port}/health`), terminateTree, shutdown, shutdownSignal: shutdownController.signal,
    });
  const result = await Promise.race([
    supervision,
    mutex.lost,
  ]);
  if (result.exitCode !== 0) throw new LauncherFailure("Course Agent 异常退出次数过多，请查看安全日志后重试。", result.exitCode);
} catch (error) { requestShutdown(); await supervision?.catch(() => undefined); if (error instanceof ShutdownRequested) process.exitCode = 0; else { const failure = error instanceof LauncherFailure ? error : new LauncherFailure("Course Agent 启动失败。请确认发布包完整且本机资源充足。", 1); process.stderr.write(`${failure.message}\n`); process.exitCode = failure.code; } }
finally {
  if (!appReleased) await appReservation.release(); if (!mineruReleased) await mineruReservation.release();
  await removeOwnedDescriptor(descriptorFile, ownedInstanceIds); await mutex.release();
}

function startChild(spec: LaunchSpec): LauncherChild {
  const child = spawn(spec.command, spec.args, { cwd: releaseRoot, windowsHide: true, stdio: "ignore", env: childEnvironment(spec.env) });
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
async function waitForOwnedHealth(url: string, child: LauncherChild, timeoutMs: number, expectedOwner?: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const outcome = await Promise.race([healthCheck(url, expectedOwner, signal).then((healthy) => healthy ? "healthy" as const : "retry" as const), child.wait().then(() => "exited" as const), ...(signal ? [new Promise<"shutdown">((resolve) => signal.addEventListener("abort", () => resolve("shutdown"), { once: true }))] : [])]);
    if (outcome === "shutdown") return false;
    if (outcome === "exited") return false;
    if (outcome === "healthy") return Promise.race([child.wait().then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))]);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function probeHardware(root: string) {
  const python = path.join(root, "runtime", "python", "python.exe"); await access(python);
  const script = "import json; r={'torch':False,'lmdeploy':False,'cuda':False,'vramBytes':0}\ntry:\n import torch; r['torch']=True; r['cuda']=bool(torch.cuda.is_available()); r['vramBytes']=int(torch.cuda.get_device_properties(0).total_memory) if r['cuda'] else 0\nexcept Exception: pass\ntry:\n import lmdeploy; r['lmdeploy']=True\nexcept Exception: pass\nprint(json.dumps(r))";
  const output = await capture(python, ["-c", script]); return JSON.parse(output) as { torch: boolean; lmdeploy: boolean; cuda: boolean; vramBytes: number };
}
function capture(command: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, env: childEnvironment(), stdio: ["ignore", "pipe", "ignore"] }); let output = ""; child.stdout?.on("data", (chunk) => { if (output.length < 10_000) output += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error("硬件探测失败。"))); }); }
async function windowsProcessStartedAt(pid: number): Promise<number | undefined> { try { const powershell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"); const value = (await capture(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`])).trim(); const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; } catch { return undefined; } }
async function removeOwnedDescriptor(filename: string, ownerIds: Set<string>): Promise<void> { try { const value = JSON.parse(await readFile(filename, "utf8")) as { ownerToken?: unknown }; if (typeof value.ownerToken === "string" && ownerIds.has(value.ownerToken)) await rm(filename, { force: true }); } catch { /* absent or replaced by a newer owner */ } }

async function smokeMineru(port: number, selected: MineruBackend, signal?: AbortSignal): Promise<boolean> {
  try {
    const client = new DoclingClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000, ...(signal ? { signal } : {}) });
    const submitted = await client.submit({ filename: "smoke.pdf", bytes: minimalPdf() });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !signal?.aborted) { const status = await client.status(submitted.taskId); if (status.status === "completed") return true; if (status.status === "failed") return false; await new Promise((resolve) => setTimeout(resolve, 250)); }
  } catch { /* raw MinerU details are intentionally suppressed */ }
  return false;
}
function minimalPdf(): Uint8Array {
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>", "<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]/Contents 4 0 R>>", "<</Length 0>>\nstream\n\nendstream"];
  let source = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(new TextEncoder().encode(source).byteLength); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
function fail(message: string, code: number): never { process.stderr.write(`${message}\n`); process.exit(code); }
