import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";

interface LockOptions { timeoutMs?: number; pollMs?: number; fatalHandler?: (error: Error) => never; helperAcquired?: (pid: number) => void }
interface HelperExit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

export async function withModelConfigLock<T>(workspaceRoot: string, action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  if (process.platform === "win32") return withWindowsMutex(workspaceRoot, action, options.timeoutMs ?? 15_000, options.fatalHandler ?? abortForLostLock, options.helperAcquired);
  return withPortableDirectoryLock(workspaceRoot, action, options.timeoutMs ?? 15_000, options.pollMs ?? 25);
}

async function withWindowsMutex<T>(workspaceRoot: string, action: () => Promise<T>, timeoutMs: number, fatalHandler: (error: Error) => never, helperAcquired?: (pid: number) => void): Promise<T> {
  const mutexName = await modelConfigMutexName(workspaceRoot);
  const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsMutexScript], {
    env: { ...process.env, COURSE_AGENT_MUTEX_NAME: mutexName, COURSE_AGENT_MUTEX_TIMEOUT_MS: String(timeoutMs) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  helper.stdin.on("error", () => { /* EPIPE is reported through the helper exit guard. */ });
  const exited = observeExit(helper);
  await waitUntilReady(helper, exited, timeoutMs + 10_000);
  if (helper.pid !== undefined) helperAcquired?.(helper.pid);
  let releasing = false;
  const lostLock = exited.then<never>((result) => {
    if (releasing) return new Promise<never>(() => undefined);
    const detail = result.error?.message ?? `exit=${String(result.code)} signal=${String(result.signal)}`;
    return fatalHandler(new Error(`The model configuration lock helper exited during a critical section (${detail})`));
  });
  try { return await Promise.race([action(), lostLock]); }
  finally {
    releasing = true;
    if (!helper.stdin.destroyed) helper.stdin.end("release\n");
    await exited;
  }
}

export async function modelConfigMutexName(workspaceRoot: string): Promise<string> {
  return `Global\\CourseAgent.ModelConfig.${(await resolveWorkspaceIdentity(workspaceRoot)).hash}`;
}

function waitUntilReady(helper: ChildProcessWithoutNullStreams, exited: Promise<HelperExit>, outerTimeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let active = true;
    let timer: NodeJS.Timeout;
    const cleanup = () => { active = false; clearTimeout(timer); helper.stdout.off("data", onStdout); helper.stderr.off("data", onStderr); };
    const succeed = () => { cleanup(); resolve(); };
    const fail = (message: string) => { if (!active) return; cleanup(); helper.kill(); reject(new Error(message)); };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split(/\r?\n/u).includes("READY")) succeed();
      else if (stdout.split(/\r?\n/u).includes("TIMEOUT")) fail("Timed out waiting for the model configuration lock");
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf8"); };
    helper.stdout.on("data", onStdout);
    helper.stderr.on("data", onStderr);
    timer = setTimeout(() => fail("Timed out waiting for the model configuration lock"), outerTimeoutMs);
    void exited.then((result) => {
      const detail = result.error?.message ?? stderr.trim();
      fail(detail || "The model configuration lock helper exited unexpectedly");
    });
  });
}

function observeExit(helper: ChildProcessWithoutNullStreams): Promise<HelperExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HelperExit) => { if (!settled) { settled = true; resolve(result); } };
    helper.once("error", (error) => finish({ code: helper.exitCode, signal: helper.signalCode, error }));
    helper.once("exit", (code, signal) => finish({ code, signal }));
  });
}

function abortForLostLock(_error: Error): never { return process.abort(); }

async function withPortableDirectoryLock<T>(workspaceRoot: string, action: () => Promise<T>, timeoutMs: number, pollMs: number): Promise<T> {
  const configDirectory = path.resolve(workspaceRoot, "config");
  const lockDirectory = path.resolve(configDirectory, ".model-settings.lock");
  if (path.dirname(lockDirectory) !== configDirectory) throw new Error("Invalid model configuration lock path");
  await mkdir(configDirectory, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lockDirectory); break; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the model configuration lock");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try { return await action(); }
  finally {
    const released = `${lockDirectory}.released-${process.pid}-${Date.now()}`;
    try { await rename(lockDirectory, released); await rm(released, { recursive: true, force: true }); } catch { /* the lock is best-effort outside the Windows release target */ }
  }
}

const windowsMutexScript = String.raw`
$mutex = [System.Threading.Mutex]::new($false, $env:COURSE_AGENT_MUTEX_NAME)
$owned = $false
try {
  try { $owned = $mutex.WaitOne([int]$env:COURSE_AGENT_MUTEX_TIMEOUT_MS) }
  catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { [Console]::Out.WriteLine('TIMEOUT'); [Console]::Out.Flush(); exit 2 }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
}
finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
