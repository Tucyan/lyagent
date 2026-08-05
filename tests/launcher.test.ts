import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_RESTART_EXIT_CODE,
  PortReservation,
  chooseDoclingDevice,
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
    const reservation = await PortReservation.acquire([used, 0]);
    expect(reservation.port).not.toBe(used);
    expect(reservation.port).toBeGreaterThan(0);
    await expect(new Promise<void>((resolve, reject) => net.createServer().once("error", reject).listen({ port: reservation.port, host: "127.0.0.1" }, () => resolve()))).rejects.toMatchObject({ code: "EADDRINUSE" });
    await reservation.release();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it("accepts only current-owner, healthy, loopback descriptors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "launcher-descriptor-")); roots.push(root);
    const file = path.join(root, "runtime.json");
    const owner = "11111111-1111-4111-8111-111111111111";
    const valid = descriptorFor({ workspaceHash: "a".repeat(64), ownerToken: owner, pid: 123, appPort: 3002, converterPort: 8000, device: "auto", startedAt: new Date().toISOString() });
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

describe("Docling device selection and supervision", () => {
  it("defaults to automatic device selection and accepts only the CPU override", () => {
    expect(chooseDoclingDevice({})).toBe("auto");
    expect(chooseDoclingDevice({ COURSE_AGENT_DOCLING_DEVICE: "cpu" })).toBe("cpu");
    expect(chooseDoclingDevice({ COURSE_AGENT_DOCLING_DEVICE: "cuda" })).toBe("auto");
  });

  it("keeps healthy Docling running across an app-requested restart", async () => {
    const starts: string[] = []; const killed: number[] = []; let appStarts = 0;
    const child = (pid: number, code: number | undefined): LauncherChild => ({ pid, wait: () => code === undefined ? new Promise(() => undefined) : Promise.resolve(code) });
    const result = await runSupervisor({
      device: "auto", maxUnexpectedRestarts: 2,
      startConverter: async () => { starts.push("docling"); return child(10, undefined); },
      startApp: async () => { appStarts += 1; starts.push("app"); return child(100 + appStarts, appStarts === 1 ? APP_RESTART_EXIT_CODE : 0); },
      isConverterHealthy: async () => true,
      terminateTree: async (pid) => { killed.push(pid); },
    });
    expect(result.device).toBe("auto");
    expect(starts).toEqual(["docling", "app", "app"]);
    expect(killed).toEqual([10]);
  });

  it("caps abnormal app restart loops and only terminates recorded children", async () => {
    let appStarts = 0; const killed: number[] = [];
    const result = await runSupervisor({ device: "cpu", maxUnexpectedRestarts: 2,
      startConverter: async () => ({ pid: 20, wait: () => new Promise(() => undefined) }),
      startApp: async () => ({ pid: 30 + ++appStarts, wait: async () => 1 }), isConverterHealthy: async () => true,
      terminateTree: async (pid) => { killed.push(pid); },
    });
    expect(result.exitCode).not.toBe(0); expect(appStarts).toBe(3); expect(killed).toEqual([20]);
  });

  it("caps repeated requested restart exits", async () => {
    let appStarts = 0;
    const result = await runSupervisor({ device: "auto", maxUnexpectedRestarts: 2, maxRequestedRestarts: 2,
      startConverter: async () => ({ pid: 20, wait: () => new Promise(() => undefined) }),
      startApp: async () => ({ pid: 30 + ++appStarts, wait: async () => APP_RESTART_EXIT_CODE }), isConverterHealthy: async () => true, terminateTree: async () => undefined,
    });
    expect(result.exitCode).toBe(1); expect(appStarts).toBe(3);
  });

  it("stops the app when the owned Docling child exits", async () => {
    let releaseConverter!: (code: number) => void; const killed: number[] = [];
    const resultPromise = runSupervisor({ device: "auto", maxUnexpectedRestarts: 2,
      startConverter: async () => ({ pid: 20, wait: () => new Promise<number>((resolve) => { releaseConverter = resolve; }) }),
      startApp: async () => ({ pid: 30, wait: () => new Promise(() => undefined) }), isConverterHealthy: async () => false, terminateTree: async (pid) => { killed.push(pid); },
    });
    await vi.waitFor(() => expect(releaseConverter).toBeTypeOf("function")); releaseConverter(1);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 1 }); expect(killed).toEqual([30]);
  });

  it("stops both owned process trees when the supervisor shuts down", async () => {
    let stop!: () => void; const shutdown = new Promise<void>((resolve) => { stop = resolve; }); const killed: number[] = [];
    const resultPromise = runSupervisor({ device: "cpu", maxUnexpectedRestarts: 2,
      startConverter: async () => ({ pid: 20, startedAt: 100, wait: () => new Promise(() => undefined) }),
      startApp: async () => ({ pid: 30, startedAt: 200, wait: () => new Promise(() => undefined) }), isConverterHealthy: async () => true, terminateTree: async (pid, startedAt) => { killed.push(pid + (startedAt ?? 0)); }, shutdown,
    });
    await vi.waitFor(() => expect(killed).toEqual([]));
    stop();
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 }); expect(killed.sort((a, b) => a - b)).toEqual([120, 230]);
  });
});
