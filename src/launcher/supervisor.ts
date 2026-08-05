import net, { type Server } from "node:net";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const APP_RESTART_EXIT_CODE = 42;
export type MineruBackend = "hybrid-engine" | "pipeline";

export class PortReservation {
  private constructor(public readonly port: number, private readonly server: Server) {}
  static async acquire(candidates: number[]): Promise<PortReservation> {
    for (const port of candidates) {
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
        });
        return new PortReservation((server.address() as net.AddressInfo).port, server);
      } catch { server.removeAllListeners(); }
    }
    throw new Error("没有可用的本地端口，请关闭占用端口的程序后重试。");
  }
  async release(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

const descriptorSchema = z.object({
  schemaVersion: z.literal(1), workspaceHash: z.string().regex(/^[a-f0-9]{64}$/), ownerToken: z.string().uuid(),
  pid: z.number().int().positive(), appPort: z.number().int().min(1).max(65535), mineruPort: z.number().int().min(1).max(65535),
  backend: z.enum(["hybrid-engine", "pipeline"]), appUrl: z.string().url(), startedAt: z.string().datetime(), processStartedAt: z.number().int().positive(), supervisorPid: z.number().int().positive(), supervisorStartedAt: z.number().int().positive(),
}).strict();
export type RuntimeDescriptor = z.infer<typeof descriptorSchema>;

export function descriptorFor(input: Omit<RuntimeDescriptor, "schemaVersion" | "appUrl" | "processStartedAt" | "supervisorPid" | "supervisorStartedAt"> & { processStartedAt?: number; supervisorPid?: number; supervisorStartedAt?: number }): RuntimeDescriptor {
  return { schemaVersion: 1, ...input, processStartedAt: input.processStartedAt ?? Date.parse(input.startedAt), supervisorPid: input.supervisorPid ?? process.pid, supervisorStartedAt: input.supervisorStartedAt ?? Date.parse(input.startedAt), appUrl: `http://127.0.0.1:${input.appPort}` };
}

export async function readHealthyDescriptor(filename: string, options: {
  workspaceHash: string; ownerToken?: string; isProcessAlive(pid: number): boolean; processStartedAt?(pid: number): Promise<number | undefined>; health(url: string, ownerToken: string): Promise<boolean>;
}): Promise<RuntimeDescriptor | undefined> {
  try {
    const parsed = descriptorSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    const url = new URL(parsed.appUrl);
    const startedAt = Date.parse(parsed.startedAt); const age = Date.now() - startedAt;
    if (parsed.workspaceHash !== options.workspaceHash || (options.ownerToken && parsed.ownerToken !== options.ownerToken)) return undefined;
    if (!Number.isFinite(startedAt) || age < -30_000 || age > 30 * 24 * 60 * 60 * 1_000) return undefined;
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== parsed.appPort) return undefined;
    if (!options.isProcessAlive(parsed.supervisorPid)) return undefined;
    if (options.processStartedAt) { const actual = await options.processStartedAt(parsed.pid); if (actual === undefined || Math.abs(actual - parsed.processStartedAt) > 5_000) return undefined; }
    if (options.processStartedAt) { const actual = await options.processStartedAt(parsed.supervisorPid); if (actual === undefined || Math.abs(actual - parsed.supervisorStartedAt) > 5_000) return undefined; }
    if (!options.isProcessAlive(parsed.pid) || !(await options.health(`${parsed.appUrl}/api/health`, parsed.ownerToken))) return undefined;
    return parsed;
  } catch { return undefined; }
}

export interface HardwareProbe { torch: boolean; lmdeploy: boolean; cuda: boolean; vramBytes: number }
export async function chooseBackend(options: { forceCpu: boolean; probe(): Promise<HardwareProbe> }): Promise<MineruBackend> {
  if (options.forceCpu) return "pipeline";
  try {
    const result = await options.probe();
    return result.torch && result.lmdeploy && result.cuda && result.vramBytes >= 8 * 1024 ** 3 ? "hybrid-engine" : "pipeline";
  } catch { return "pipeline"; }
}

export interface LauncherChild { pid: number; startedAt?: number; wait(): Promise<number | null> }
export async function runSupervisor(options: {
  initialBackend: MineruBackend; maxUnexpectedRestarts: number; maxRequestedRestarts?: number;
  startMineru(backend: MineruBackend): Promise<LauncherChild>; smoke(backend: MineruBackend, signal?: AbortSignal): Promise<boolean>;
  startApp(backend: MineruBackend): Promise<LauncherChild>; isMineruHealthy(): Promise<boolean>; terminateTree(pid: number, startedAt?: number): Promise<void>; shutdown?: Promise<void>; shutdownSignal?: AbortSignal;
}): Promise<{ exitCode: number; backend: MineruBackend; fallbackReason?: string }> {
  const owned = new Set<number>(); let mineru: LauncherChild | undefined; let app: LauncherChild | undefined;
  let backend = options.initialBackend; let fallbackReason: string | undefined; let mineruExit: Promise<number | null> | undefined;
  const stop = async (child: LauncherChild | undefined) => { if (child && owned.has(child.pid)) { owned.delete(child.pid); await options.terminateTree(child.pid, child.startedAt); } };
  try {
    mineru = await options.startMineru(backend); owned.add(mineru.pid); mineruExit = mineru.wait();
    const initialSmoke = await raceShutdown(options.smoke(backend, options.shutdownSignal), options.shutdown);
    if (initialSmoke === "shutdown") return { exitCode: 0, backend };
    if (!initialSmoke) {
      if (backend !== "hybrid-engine") return { exitCode: 1, backend };
      await stop(mineru); backend = "pipeline"; fallbackReason = "GPU 后端自检未通过，已安全回退到 CPU。";
      mineru = await options.startMineru(backend); owned.add(mineru.pid); mineruExit = mineru.wait();
      const fallbackSmoke = await raceShutdown(options.smoke(backend, options.shutdownSignal), options.shutdown);
      if (fallbackSmoke === "shutdown") return { exitCode: 0, backend, fallbackReason };
      if (!fallbackSmoke) return { exitCode: 1, backend, fallbackReason };
    }
    let failures = 0; let requestedRestarts = 0;
    for (;;) {
      app = await options.startApp(backend); owned.add(app.pid);
      const outcome = await Promise.race([
        app.wait().then((code) => ({ kind: "app" as const, code })),
        mineruExit!.then((code) => ({ kind: "mineru" as const, code })),
        ...(options.shutdown ? [options.shutdown.then(() => ({ kind: "shutdown" as const, code: 0 }))] : []),
      ]);
      if (outcome.kind === "mineru") { owned.delete(mineru!.pid); mineru = undefined; return { exitCode: 1, backend, ...(fallbackReason ? { fallbackReason } : {}) }; }
      if (outcome.kind === "shutdown") return { exitCode: 0, backend, ...(fallbackReason ? { fallbackReason } : {}) };
      const code = outcome.code; owned.delete(app.pid); app = undefined;
      if (code === 0) return { exitCode: 0, backend, ...(fallbackReason ? { fallbackReason } : {}) };
      if (!(await options.isMineruHealthy())) return { exitCode: 1, backend, ...(fallbackReason ? { fallbackReason } : {}) };
      if (code === APP_RESTART_EXIT_CODE) { if (requestedRestarts++ >= (options.maxRequestedRestarts ?? 5)) return { exitCode: 1, backend, ...(fallbackReason ? { fallbackReason } : {}) }; }
      else if (failures++ >= options.maxUnexpectedRestarts) return { exitCode: 1, backend, ...(fallbackReason ? { fallbackReason } : {}) };
    }
  } finally { await stop(app); await stop(mineru); }
}

async function raceShutdown<T>(operation: Promise<T>, shutdown?: Promise<void>): Promise<T | "shutdown"> {
  return shutdown ? Promise.race([operation, shutdown.then(() => "shutdown" as const)]) : operation;
}
