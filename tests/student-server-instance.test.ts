import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { loadStudentServerConfig } from "../src/student/config.js";
import { createStudentServer } from "../src/student/server.js";

const fixturePath = fileURLToPath(new URL("./student-server-instance-fixture.ts", import.meta.url));

function startServer(workspace: string, reserve = false) {
  const child = fork(fixturePath, [workspace, ...(reserve ? ["reserve"] : [])], { execArgv: ["--import", "tsx"] });
  const result = {
    child,
    started: once(child, "message").then(([message]) => message as { status: string; address?: string; ledgerId?: string }),
    exited: once(child, "exit"),
  };
  children.push(result);
  return result;
}

const children: { child: ReturnType<typeof fork>; exited: Promise<unknown> }[] = [];
const tempFolders: string[] = [];

async function makeWorkspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lyagent-student-instance-"));
  tempFolders.push(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  return workspace;
}

afterEach(async () => {
  for (const { child, exited } of children.splice(0)) {
    child.kill("SIGKILL");
    await exited;
  }
  for (const directory of tempFolders.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("protects a live reservation from duplicate startup and refunds it after a crash", async () => {
  const workspace = await makeWorkspace();
  const alias = path.join(path.dirname(workspace), "alias");
  await symlink(workspace, alias, "junction");

  const primary = startServer(workspace, true);
  const ready = await primary.started;
  expect(ready).toMatchObject({ status: "ready", address: expect.any(String), ledgerId: expect.any(String) });

  const db = new Database(path.join(workspace, "state", "student-portal.sqlite"), { readonly: true });
  try {
    const reservation = db.prepare("SELECT status, refund_reason FROM qa_usage_ledger WHERE id = ?");
    expect(reservation.get(ready.ledgerId)).toEqual({ status: "reserved", refund_reason: null });

    const duplicate = startServer(alias);
    expect(await duplicate.started).toEqual({ status: "failed", message: "该 Workspace 的学生端服务已在运行" });
    expect(await duplicate.exited).toEqual([1, null]);
    expect(reservation.get(ready.ledgerId)).toEqual({ status: "reserved", refund_reason: null });
    expect((await fetch(`${ready.address}/api/health`)).ok).toBe(true);

    primary.child.kill("SIGKILL");
    await primary.exited;
    const restart = startServer(alias);
    expect(await restart.started).toMatchObject({ status: "ready" });
    expect(reservation.get(ready.ledgerId)).toEqual({ status: "refunded", refund_reason: "server_restart" });
  } finally {
    db.close();
  }
}, 15_000);

it("releases the Workspace on Fastify shutdown while its process stays alive", async () => {
  const workspace = await makeWorkspace();
  const primary = startServer(workspace);
  expect(await primary.started).toMatchObject({ status: "ready" });

  const closed = once(primary.child, "message").then(([message]) => message);
  primary.child.send("close");
  expect(await closed).toEqual({ status: "closed" });
  expect(primary.child.exitCode).toBeNull();
  expect(await startServer(workspace).started).toMatchObject({ status: "ready" });
}, 15_000);

it("releases the Workspace when business database initialization fails", async () => {
  const workspace = await makeWorkspace();
  const config = loadStudentServerConfig({ STUDENT_WORKSPACE_ROOT: workspace });
  const failure = Error("injected database initialization failure");

  await expect(createStudentServer({ config, now: () => { throw failure; } })).rejects.toBe(failure);
  expect(await startServer(workspace).started).toMatchObject({ status: "ready" });
}, 15_000);
