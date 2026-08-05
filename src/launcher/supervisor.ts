import net, { type Server } from "node:net";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const APP_RESTART_EXIT_CODE = 42;
export type DoclingDevice = "auto" | "cpu";

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
  pid: z.number().int().positive(), appPort: z.number().int().min(1).max(65535), converterPort: z.number().int().min(1).max(65535),
  device: z.enum(["auto", "cpu"]), appUrl: z.string().url(), startedAt: z.string().datetime(), processStartedAt: z.number().int().positive(), supervisorPid: z.number().int().positive(), supervisorStartedAt: z.number().int().positive(),
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

export function chooseDoclingDevice(environment: NodeJS.ProcessEnv): DoclingDevice {
  return environment.COURSE_AGENT_DOCLING_DEVICE?.toLowerCase() === "cpu" ? "cpu" : "auto";
}

export interface LauncherChild { pid: number; startedAt?: number; wait(): Promise<number | null> }
export async function runSupervisor(options: {
  device: DoclingDevice; maxUnexpectedRestarts: number; maxRequestedRestarts?: number;
  startConverter(): Promise<LauncherChild>; startApp(device: DoclingDevice): Promise<LauncherChild>;
  isConverterHealthy(): Promise<boolean>; terminateTree(pid: number, startedAt?: number): Promise<void>; shutdown?: Promise<void>;
}): Promise<{ exitCode: number; device: DoclingDevice }> {
  const owned = new Set<number>(); let converter: LauncherChild | undefined; let app: LauncherChild | undefined;
  const stop = async (child: LauncherChild | undefined) => { if (child && owned.has(child.pid)) { owned.delete(child.pid); await options.terminateTree(child.pid, child.startedAt); } };
  try {
    converter = await options.startConverter();
    owned.add(converter.pid);
    const converterExit = converter.wait();
    let failures = 0; let requestedRestarts = 0;
    for (;;) {
      app = await options.startApp(options.device); owned.add(app.pid);
      const outcome = await Promise.race([
        app.wait().then((code) => ({ kind: "app" as const, code })),
        converterExit.then((code) => ({ kind: "converter" as const, code })),
        ...(options.shutdown ? [options.shutdown.then(() => ({ kind: "shutdown" as const, code: 0 }))] : []),
      ]);
      if (outcome.kind === "converter") { owned.delete(converter.pid); converter = undefined; return { exitCode: 1, device: options.device }; }
      if (outcome.kind === "shutdown") return { exitCode: 0, device: options.device };
      const code = outcome.code; owned.delete(app.pid); app = undefined;
      if (code === 0) return { exitCode: 0, device: options.device };
      if (!(await options.isConverterHealthy())) return { exitCode: 1, device: options.device };
      if (code === APP_RESTART_EXIT_CODE) {
        if (requestedRestarts++ >= (options.maxRequestedRestarts ?? 5)) return { exitCode: 1, device: options.device };
      } else if (failures++ >= options.maxUnexpectedRestarts) return { exitCode: 1, device: options.device };
    }
  } finally { await stop(app); await stop(converter); }
}
