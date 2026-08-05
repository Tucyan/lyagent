import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingBatchService, type BatchResultSource, type BatchSessionSummary } from "../src/services/grading-batch-service.js";
import { GradingSummaryService } from "../src/services/grading-summary-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingBatchService recovery", () => {
  it("reconciles the model-return, result-rename, and pre-DB-commit crash windows without another model call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-recovery-"));
    roots.push(root);
    const members: BatchSessionSummary[] = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index + 1}`,
      assignmentId: "assignment-1",
      rubricVersion: 1,
      conversionStatus: "ready",
      gradingStatus: "not_started",
      studentName: `学生${index + 1}`,
      studentNumber: `2026${String(index + 1).padStart(4, "0")}`,
      submissionTitle: `恢复报告${index + 1}`,
    }));
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY)");
    const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
    for (const member of members) insert.run(member.id);
    database.close();
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    let persisted: BatchResultSource | undefined;
    let targetSessionId: string | undefined;
    const dependencies = {
      getSession: async (id: string) => members.find((member) => member.id === id)!,
      execute,
      readResult: async (sessionId: string) => sessionId === targetSessionId ? persisted : undefined,
    };
    const first = new GradingBatchService(root, dependencies, { now: () => "2026-08-05T08:00:00.000Z", workerId: "old", leaseMs: 1_000 });
    const batch = await first.createBatch({ title: "恢复测试", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 4, sessionIds: members.map(({ id }) => id) });
    await first.startBatch(batch.id, { schedule: false });
    const claimed = (await first.claimNext(batch.id, "old"))!;
    const renamed = (await first.claimNext(batch.id, "old"))!;
    const pending = (await first.getBatch(batch.id)).jobs.find((job) => job.status === "pending")!;
    targetSessionId = claimed.sessionId;
    persisted = {
      reviewStatus: "needs_review",
      version: 1,
      result: { score: { earned: 90, possible: 100 }, confidence: { overall: 0.9 }, review: { requiresReview: false, reasons: [] } },
      updatedAt: "2026-08-05T08:00:00.500Z",
    };
    const summaries = new GradingSummaryService(root);
    for (const job of [renamed, pending]) await summaries.writeSnapshot({
      batchId: batch.id,
      jobId: job.id,
      sessionId: job.sessionId,
      studentName: job.studentName,
      studentNumber: job.studentNumber,
      submissionTitle: job.submissionTitle,
      reviewStatus: "needs_review",
      version: 1,
      attemptCount: job.attemptCount,
      result: persisted.result,
      updatedAt: persisted.updatedAt,
    });
    await rm(path.join(root, "batch-grading", batch.id, "results", `${renamed.id}-attempt-${renamed.attemptCount}.md`));
    await first.pauseBatch(batch.id);
    first.close();

    const recovered = new GradingBatchService(root, dependencies, { now: () => "2026-08-05T08:00:02.000Z", workerId: "new", leaseMs: 1_000 });
    const result = await recovered.recover();
    expect(result).toMatchObject({ reconciledResults: 3, requeuedLeases: 0 });
    expect(await recovered.getJob(claimed.id)).toMatchObject({ status: "needs_review", attemptCount: 1 });
    expect(await recovered.getJob(renamed.id)).toMatchObject({ status: "needs_review", attemptCount: 1 });
    expect(await recovered.getJob(pending.id)).toMatchObject({ status: "needs_review", attemptCount: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(await recovered.readSnapshot(batch.id, claimed.id)).toMatchObject({ sessionId: claimed.sessionId, reviewStatus: "needs_review" });
    expect(await readFile(path.join(root, "batch-grading", batch.id, "results", `${renamed.id}-attempt-${renamed.attemptCount}.md`), "utf8")).toContain(renamed.submissionTitle);
    recovered.close();
  });

  it("immediately requeues running jobs owned by a previous process even before their leases expire", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-live-lease-"));
    roots.push(root);
    const members: BatchSessionSummary[] = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index + 1}`,
      assignmentId: "assignment-1",
      rubricVersion: 1,
      conversionStatus: "ready",
      gradingStatus: "not_started",
      studentName: `学生${index + 1}`,
      studentNumber: `2026${String(index + 1).padStart(4, "0")}`,
      submissionTitle: `恢复报告${index + 1}`,
    }));
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY)");
    const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
    for (const member of members) insert.run(member.id);
    database.close();
    const dependencies = {
      getSession: async (id: string) => members.find((member) => member.id === id)!,
      execute: vi.fn(async () => ({ status: "completed" as const })),
      readResult: async () => undefined,
    };
    const first = new GradingBatchService(root, dependencies, { now: () => "2026-08-05T08:00:00.000Z", workerId: "old", leaseMs: 30_000 });
    const batch = await first.createBatch({ title: "有效租约恢复", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 4, sessionIds: members.map(({ id }) => id) });
    await first.startBatch(batch.id, { schedule: false });
    const claimed = (await first.claimNext(batch.id, "old"))!;
    await first.pauseBatch(batch.id);
    first.close();

    const recovered = new GradingBatchService(root, dependencies, { now: () => "2026-08-05T08:00:01.000Z", workerId: "new", leaseMs: 30_000 });
    const result = await recovered.recover();
    expect(result.requeuedLeases).toBe(1);
    expect(await recovered.getJob(claimed.id)).toMatchObject({ status: "pending", lastErrorCode: "LEASE_ORPHANED" });
    recovered.close();
  });

  it("refreshes a reviewed result snapshot and CSV after the teacher confirms in M4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-review-sync-"));
    roots.push(root);
    const members: BatchSessionSummary[] = Array.from({ length: 30 }, (_, index) => ({ id: `session-${index + 1}`, assignmentId: "assignment-1", rubricVersion: 1, conversionStatus: "ready", gradingStatus: "not_started", studentName: `学生${index + 1}`, studentNumber: `2026${String(index + 1).padStart(4, "0")}`, submissionTitle: `复核报告${index + 1}` }));
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY)");
    const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
    for (const member of members) insert.run(member.id);
    database.close();
    const sources = new Map<string, BatchResultSource>();
    const service = new GradingBatchService(root, {
      getSession: async (id) => members.find((member) => member.id === id)!,
      execute: async (sessionId) => {
        sources.set(sessionId, { reviewStatus: "needs_review", version: 1, result: { score: { earned: 80, possible: 100 }, confidence: { overall: 0.8 } }, updatedAt: "2026-08-05T08:00:00.000Z" });
        return { status: "completed" };
      },
      readResult: async (sessionId) => sources.get(sessionId),
    });
    const batch = await service.createBatch({ title: "复核同步", assignmentId: "assignment-1", rubricVersion: 1, concurrency: 4, sessionIds: members.map(({ id }) => id) });
    await service.startBatch(batch.id);
    await service.waitForIdle(batch.id);
    sources.set("session-1", { reviewStatus: "confirmed", version: 2, result: { score: { earned: 95, possible: 100 }, confidence: { overall: 0.95 } }, updatedAt: "2026-08-05T09:00:00.000Z" });
    const csv = await service.refreshResultsAndRebuildSummary(batch.id);
    expect(await service.getJob((await service.getBatch(batch.id)).jobs[0]!.id)).toMatchObject({ status: "completed" });
    expect(csv).toContain("95,100,0.95,已确认");
    service.close();
  });
});
