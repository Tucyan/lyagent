import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export function launcherMutexName(workspaceHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(workspaceHash)) throw new Error("Invalid workspace identity");
  return `Global\\CourseAgent.Launcher.${workspaceHash}`;
}

export interface LauncherMutex { acquired: boolean; lost: Promise<never>; release(): Promise<void> }

export async function acquireLauncherMutex(workspaceHash: string): Promise<LauncherMutex> {
  if (process.platform !== "win32") throw new Error("The release launcher requires Windows");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("无法确定 Windows 系统目录。");
  const helper = spawn(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", mutexScript], {
    env: { SystemRoot: process.env.SystemRoot, COURSE_AGENT_MUTEX_NAME: launcherMutexName(workspaceHash) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  helper.stdin.on("error", () => undefined);
  const exit = observeExit(helper);
  const acquired = await handshake(helper, exit);
  if (!acquired) return { acquired: false, lost: new Promise<never>(() => undefined), release: async () => undefined };
  let releasing = false;
  return {
    acquired: true,
    lost: exit.then((value) => releasing ? new Promise<never>(() => undefined) : Promise.reject(new Error(`单实例锁异常退出（${String(value.code)}）。`))),
    release: async () => { releasing = true; if (!helper.stdin.destroyed) helper.stdin.end("release\n"); await exit; },
  };
}

function observeExit(helper: ChildProcessWithoutNullStreams): Promise<{ code: number | null }> {
  return new Promise((resolve) => { helper.once("error", () => resolve({ code: helper.exitCode })); helper.once("exit", (code) => resolve({ code })); });
}

function handshake(helper: ChildProcessWithoutNullStreams, exit: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => { helper.kill(); reject(new Error("无法建立单实例锁。")); }, 10_000);
    const done = (value: boolean) => { clearTimeout(timer); helper.stdout.removeAllListeners("data"); resolve(value); };
    helper.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.includes("READY")) done(true); else if (output.includes("BUSY")) done(false); });
    void exit.then(() => { clearTimeout(timer); if (!output.includes("READY") && !output.includes("BUSY")) reject(new Error("单实例锁辅助进程异常退出。")); });
  });
}

const mutexScript = String.raw`
$mutex = [System.Threading.Mutex]::new($false, $env:COURSE_AGENT_MUTEX_NAME)
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { [Console]::Out.WriteLine('BUSY'); [Console]::Out.Flush(); exit 2 }
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}`;
