import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_RESTART_EXIT_CODE,
  PortReservation,
  chooseBackend,
  descriptorFor,
  readHealthyDescriptor,
  runSupervisor,
  type LauncherChild,
} from "../src/launcher/supervisor.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("launcher ports and runtime descriptor", () => {
  it("reserves the first actually bindable loopback port until released", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const used = (occupied.address() as net.AddressInfo).port;
    const reservation = await PortReservation.acquire([used, used + 1]);
    expect(reservation.port).toBe(used + 1);
    await expect(new Promise<void>((resolve, reject) => net.createServer().once("error", reject).listen({ port: reservation.port, host: "127.0.0.1" }, () => resolve()))).rejects.toMatchObject({ code: "EADDRINUSE" });
    await reservation.release();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it("accepts only current-owner, healthy, loopback descriptors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "launcher-descriptor-")); roots.push(root);
    const file = path.join(root, "runtime.json");
    const owner = "11111111-1111-4111-8111-111111111111";
    const valid = descriptorFor({ workspaceHash: "a".repeat(64), ownerToken: owner, pid: 123, appPort: 3002, mineruPort: 8000, backend: "pipeline", startedAt: new Date().toISOString() });
    await writeFile(file, JSON.stringify(valid));
    await expect(readHealthyDescriptor(file, { workspaceHash: "a".repeat(64), ownerToken: owner, isProcessAlive: () => true, health: async () => true })).resolves.toEqual(valid);
    await writeFile(file, JSON.stringify({ ...valid, appUrl: "http://evil.example:3002" }));
    await expect(readHealthyDescriptor(file, { workspaceHash: "a".repeat(64), ownerToken: owner, isProcessAlive: () => true, health: async () => true })).resolves.toBeUndefined();
    await writeFile(file, JSON.stringify({ ...valid, pid: 999 }));
    await expect(readHealthyDescriptor(file, { workspaceHash: "a".repeat(64), ownerToken: owner, isProcessAlive: () => false, health: async () => true })).resolves.toBeUndefined();
    await writeFile(file, JSON.stringify({ ...valid, startedAt: "2020-01-01T00:00:00.000Z" }));
    await expect(readHealthyDescriptor(file, { workspaceHash: "a".repeat(64), ownerToken: owner, isProcessAlive: () => true, health: async () => true })).resolves.toBeUndefined();
    await writeFile(file, JSON.stringify({ ...valid, supervisorPid: 456 }));
    await expect(readHealthyDescriptor(file, { workspaceHash: "a".repeat(64), ownerToken: owner, isProcessAlive: (pid) => pid === valid.pid, health: async () => true })).resolves.toBeUndefined();
  });
});

describe("backend selection and supervision", () => {
  it("uses hybrid only after bundled-python torch/lmdeploy and VRAM probe, with force CPU override", async () => {
    await expect(chooseBackend({ forceCpu: false, probe: async () => ({ torch: true, lmdeploy: true, cuda: true, vramBytes: 8 * 1024 ** 3 }) })).resolves.toBe("hybrid-engine");
    await expect(chooseBackend({ forceCpu: false, probe: async () => ({ torch: true, lmdeploy: false, cuda: true, vramBytes: 16 * 1024 ** 3 }) })).resolves.toBe("pipeline");
    await expect(chooseBackend({ forceCpu: true, probe: async () => ({ torch: true, lmdeploy: true, cuda: true, vramBytes: 16 * 1024 ** 3 }) })).resolves.toBe("pipeline");
  });

  it("falls back once after hybrid smoke failure and keeps healthy MinerU across app restart 42", async () => {
    const starts: string[] = []; const killed: number[] = []; let appStarts = 0;
    const child = (pid: number, code: number): LauncherChild => ({ pid, wait: async () => code });
    const result = await runSupervisor({
      initialBackend: "hybrid-engine", maxUnexpectedRestarts: 2,
      startMineru: async (backend) => { starts.push(`mineru:${backend}`); return child(10 + starts.length, 0); },
      smoke: async (backend) => backend === "pipeline",
      startApp: async () => { appStarts += 1; starts.push("app"); return child(100 + appStarts, appStarts === 1 ? APP_RESTART_EXIT_CODE : 0); },
      isMineruHealthy: async () => true,
      terminateTree: async (pid) => { killed.push(pid); },
    });
    expect(result.backend).toBe("pipeline");
    expect(starts).toEqual(["mineru:hybrid-engine", "mineru:pipeline", "app", "app"]);
    expect(killed).toEqual([11, 12]);
  });

  it("caps abnormal app restart loops and only terminates recorded children", async () => {
    let appStarts = 0; const killed: number[] = [];
    const result = await runSupervisor({ initialBackend: "pipeline", maxUnexpectedRestarts: 2,
      startMineru: async () => ({ pid: 20, wait: async () => 0 }), smoke: async () => true,
      startApp: async () => ({ pid: 30 + ++appStarts, wait: async () => 1 }), isMineruHealthy: async () => true,
      terminateTree: async (pid) => { killed.push(pid); },
    });
    expect(result.exitCode).not.toBe(0); expect(appStarts).toBe(3); expect(killed).toEqual([20]);
  });

  it("caps repeated requested restart exits", async () => {
    let appStarts = 0;
    const result = await runSupervisor({ initialBackend: "pipeline", maxUnexpectedRestarts: 2, maxRequestedRestarts: 2,
      startMineru: async () => ({ pid: 20, wait: () => new Promise(() => undefined) }), smoke: async () => true,
      startApp: async () => ({ pid: 30 + ++appStarts, wait: async () => APP_RESTART_EXIT_CODE }), isMineruHealthy: async () => true, terminateTree: async () => undefined,
    });
    expect(result.exitCode).toBe(1); expect(appStarts).toBe(3);
  });

  it("stops the app when the owned MinerU child exits", async () => {
    let releaseMineru!: (code: number) => void; const killed: number[] = [];
    const resultPromise = runSupervisor({ initialBackend: "pipeline", maxUnexpectedRestarts: 2,
      startMineru: async () => ({ pid: 20, wait: () => new Promise<number>((resolve) => { releaseMineru = resolve; }) }), smoke: async () => true,
      startApp: async () => ({ pid: 30, wait: () => new Promise(() => undefined) }), isMineruHealthy: async () => false, terminateTree: async (pid) => { killed.push(pid); },
    });
    await vi.waitFor(() => expect(releaseMineru).toBeTypeOf("function")); releaseMineru(1);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 1 }); expect(killed).toEqual([30]);
  });

  it("cancels MinerU smoke immediately on supervisor shutdown without starting the app", async () => {
    let stop!: () => void; const shutdown = new Promise<void>((resolve) => { stop = resolve; }); const killed: number[] = []; const startApp = vi.fn();
    const resultPromise = runSupervisor({ initialBackend: "pipeline", maxUnexpectedRestarts: 2,
      startMineru: async () => ({ pid: 20, wait: () => new Promise(() => undefined) }), smoke: () => new Promise(() => undefined),
      startApp, isMineruHealthy: async () => true, terminateTree: async (pid) => { killed.push(pid); }, shutdown,
    });
    stop();
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 }); expect(startApp).not.toHaveBeenCalled(); expect(killed).toEqual([20]);
  });
});
