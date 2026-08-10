import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  GradingBatchConflictError,
  GradingBatchService,
  type BatchSessionSummary,
} from "../src/services/grading-batch-service.js";

const roots: string[] = [];

function sessions(count = 30): BatchSessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    assignmentId: "assignment-1",
    rubricVersion: 1,
    conversionStatus: "ready",
    gradingStatus: "not_started",
    studentName: `学生${index + 1}`,
    studentNumber: `2026${String(index + 1).padStart(4, "0")}`,
    submissionTitle: `合成报告${index + 1}`,
  }));
}

async function setup(now = "2026-08-05T08:00:00.000Z") {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-state-"));
  roots.push(root);
  let current = now;
  const known = new Map(sessions().map((session) => [session.id, session]));
  const database = new Database(path.join(root, "grading.sqlite"));
  database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY, grading_status TEXT NOT NULL DEFAULT 'not_started', deletion_pending INTEGER NOT NULL DEFAULT 0)");
  const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
  for (const id of known.keys()) insert.run(id);
  database.close();
  const service = new GradingBatchService(root, {
    getSession: async (id) => known.get(id)!,
    execute: async () => ({ status: "failed", errorCode: "EXPECTED_TEST_FAILURE" }),
    readResult: async () => undefined,
  }, {
    now: () => current,
    workerId: "worker-a",
    leaseMs: 1_000,
  });
  return {
    service,
    root,
    known,
    setNow(value: string) { current = value; },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingBatchService state machine", () => {
  it("allows duplicate assignment titles but rejects duplicate student numbers", async () => {
    const first = await setup();
    first.known.get("session-2")!.submissionTitle = first.known.get("session-1")!.submissionTitle!;
    await expect(first.service.createBatch({
      title: "允许同名作业",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 2,
      sessionIds: ["session-1", "session-2"],
    })).resolves.toMatchObject({ totalJobs: 2 });
    first.service.close();

    const second = await setup();
    second.known.get("session-2")!.studentNumber = second.known.get("session-1")!.studentNumber;
    await expect(second.service.createBatch({
      title: "拒绝重复学号",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 2,
      sessionIds: ["session-1", "session-2"],
    })).rejects.toBeInstanceOf(GradingBatchConflictError);
    second.service.close();
  });

  it("accepts a ten-report batch", async () => {
    const { service } = await setup();
    await expect(service.createBatch({
      title: "十份报告",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 4,
      sessionIds: sessions(10).map(({ id }) => id),
    })).resolves.toMatchObject({ totalJobs: 10 });
    service.close();
  });

  it("creates a 30-report batch and rejects duplicate membership", async () => {
    const { service } = await setup();
    const created = await service.createBatch({
      title: "一班报告",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 4,
      sessionIds: sessions().map(({ id }) => id),
    });
    expect(created).toMatchObject({ status: "draft", totalJobs: 30, concurrency: 4 });
    expect((await service.getBatch(created.id)).jobs).toHaveLength(30);
    await expect(service.createBatch({
      title: "重复任务",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 4,
      sessionIds: [...sessions().slice(0, 29).map(({ id }) => id), "session-1"],
    })).rejects.toBeInstanceOf(GradingBatchConflictError);
    await expect(service.createBatch({
      title: "重复占用同一会话",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 2,
      sessionIds: sessions().map(({ id }) => id),
    })).rejects.toThrow(/another batch/i);
    service.close();
  });

  it("claims a job transactionally, renews only its lease owner, and requeues an expired lease", async () => {
    const { service, setNow } = await setup();
    const batch = await service.createBatch({
      title: "租约测试",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 4,
      sessionIds: sessions().map(({ id }) => id),
    });
    await service.startBatch(batch.id, { schedule: false });
    const first = await service.claimNext(batch.id, "worker-a");
    expect(first).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-a" });
    await expect(service.renewLease(first!.id, "worker-b")).resolves.toBe(false);
    await expect(service.renewLease(first!.id, "worker-a")).resolves.toBe(true);

    setNow("2026-08-05T08:00:02.001Z");
    expect(await service.requeueExpiredLeases()).toBe(1);
    expect((await service.getJob(first!.id)).status).toBe("pending");
    service.close();
  });

  it("allows only failed jobs below the three-attempt limit to retry", async () => {
    const { service } = await setup();
    const batch = await service.createBatch({
      title: "重试测试",
      assignmentId: "assignment-1",
      rubricVersion: 1,
      concurrency: 2,
      sessionIds: sessions().map(({ id }) => id),
    });
    await service.startBatch(batch.id, { schedule: false });
    const job = (await service.claimNext(batch.id, "worker-a"))!;
    await service.failJob(job.id, "SAFE_FAILURE");
    await expect(service.retryJob(job.id, { schedule: false })).resolves.toMatchObject({ status: "pending", attemptCount: 1 });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const claimed = (await service.claimNext(batch.id, "worker-a"))!;
      expect(claimed.attemptCount).toBe(attempt);
      await service.failJob(claimed.id, "SAFE_FAILURE");
      if (attempt < 3) await service.retryJob(claimed.id, { schedule: false });
    }
    await expect(service.retryJob(job.id)).rejects.toThrow(/retry limit/i);
    service.close();
  });

  it("completes a paused batch after its final claimed jobs settle", async () => {
    const { service } = await setup();
    const batch = await service.createBatch({ title: "暂停终态", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 4, sessionIds: sessions().map(({ id }) => id) });
    await service.startBatch(batch.id, { schedule: false });
    const claimed = [];
    for (let index = 0; index < 30; index += 1) claimed.push((await service.claimNext(batch.id, "worker-a"))!);
    await service.pauseBatch(batch.id);
    for (const job of claimed) await service.failJob(job.id, "EXPECTED_TEST_FAILURE");
    expect(await service.getBatch(batch.id)).toMatchObject({ status: "completed", counts: { pending: 0, running: 0, failed: 30 } });
    service.close();
  });

  it("rejects a stale worker settlement after a lease is reclaimed", async () => {
    const { service, setNow } = await setup();
    const batch = await service.createBatch({ title: "租约隔离", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 1, sessionIds: sessions().map(({ id }) => id) });
    await service.startBatch(batch.id, { schedule: false });
    const old = (await service.claimNext(batch.id, "worker-a"))!;
    setNow("2026-08-05T08:00:02.000Z");
    await service.requeueExpiredLeases();
    const current = (await service.claimNext(batch.id, "worker-b"))!;
    expect(current.attemptCount).toBe(2);
    await expect(service.failJob(old.id, "STALE_FAILURE", { leaseOwner: "worker-a", attemptCount: 1 })).rejects.toThrow(/lease/i);
    expect(await service.getJob(old.id)).toMatchObject({ status: "running", leaseOwner: "worker-b", attemptCount: 2 });
    service.close();
  });

  it("fails rather than strands a job whose third lease is lost", async () => {
    const { service, setNow } = await setup();
    const batch = await service.createBatch({ title: "耗尽租约", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 1, sessionIds: sessions().map(({ id }) => id) });
    await service.startBatch(batch.id, { schedule: false });
    let job = (await service.claimNext(batch.id, "worker-a"))!;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      setNow(`2026-08-05T08:00:0${attempt * 2}.000Z`);
      await service.requeueExpiredLeases();
      job = await service.getJob(job.id);
      if (attempt < 3) {
        expect(job.status).toBe("pending");
        job = (await service.claimNext(batch.id, "worker-a"))!;
      }
    }
    expect(job).toMatchObject({ status: "failed", attemptCount: 3, lastErrorCode: "LEASE_EXPIRED" });
    service.close();
  });

  it("rechecks session ownership inside the reservation transaction", async () => {
    const { service, root } = await setup();
    const database = new Database(path.join(root, "grading.sqlite"));
    database.prepare("UPDATE grading_sessions SET grading_status = 'queued' WHERE id = 'session-1'").run();
    database.close();
    await expect(service.createBatch({ title: "并发预留", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 2, sessionIds: sessions().map(({ id }) => id) }))
      .rejects.toThrow(/already being graded/i);
    service.close();
  });
});
