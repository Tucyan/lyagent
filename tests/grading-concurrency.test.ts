import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingBatchService, type BatchSessionSummary } from "../src/services/grading-batch-service.js";

const roots: string[] = [];

async function fixture(execute: ConstructorParameters<typeof GradingBatchService>[1]["execute"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-concurrency-"));
  roots.push(root);
  const members: BatchSessionSummary[] = Array.from({ length: 30 }, (_, index) => ({
    id: `session-${index + 1}`,
    assignmentId: "assignment-1",
    rubricVersion: 1,
    conversionStatus: "ready",
    gradingStatus: "not_started",
    studentName: `学生${index + 1}`,
    studentNumber: `2026${String(index + 1).padStart(4, "0")}`,
    submissionTitle: `并发报告${index + 1}`,
  }));
  const database = new Database(path.join(root, "grading.sqlite"));
  database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY)");
  const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
  for (const member of members) insert.run(member.id);
  database.close();
  const service = new GradingBatchService(root, {
    getSession: async (id) => members.find((member) => member.id === id)!,
    execute,
    readResult: async () => ({
      reviewStatus: "needs_review",
      version: 1,
      result: { score: { earned: 80, possible: 100 }, review: { requiresReview: false, reasons: [] } },
      updatedAt: "2026-08-05T08:00:00.000Z",
    }),
  });
  const batch = await service.createBatch({
    title: "并发验收",
    assignmentId: "assignment-1",
    rubricVersion: 1,
    concurrency: 4,
    sessionIds: members.map(({ id }) => id),
  });
  return { service, batch };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingBatchService scheduling", () => {
  it("runs at configured concurrency and pause lets running jobs finish without new claims", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const releases: Array<() => void> = [];
    const { service, batch } = await fixture(async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { status: "completed" };
    });

    await service.startBatch(batch.id);
    await vi.waitFor(() => expect(active).toBe(4));
    await service.pauseBatch(batch.id);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(async () => expect((await service.getBatch(batch.id)).counts.running).toBe(0));
    expect(calls).toBe(4);
    expect((await service.getBatch(batch.id)).counts.pending).toBe(26);

    const drain = setInterval(() => releases.splice(0).forEach((release) => release()), 1);
    await service.resumeBatch(batch.id);
    await service.waitForIdle(batch.id);
    clearInterval(drain);
    expect(maximum).toBe(4);
    expect(calls).toBe(30);
    expect(await service.getBatch(batch.id)).toMatchObject({
      status: "completed",
      counts: { needs_review: 30, pending: 0, running: 0 },
    });
    service.close();
  });

  it("releases slots for a teacher question and an isolated failure", async () => {
    const called: string[] = [];
    let asked = false;
    const { service, batch } = await fixture(async (sessionId, input) => {
      called.push(`${sessionId}:${input.kind}`);
      if (sessionId === "session-1" && !asked) {
        asked = true;
        return { status: "waiting_for_teacher", question: "附件是否为必交？" };
      }
      if (sessionId === "session-2") return { status: "failed", errorCode: "MODEL_UNAVAILABLE" };
      return { status: "completed" };
    });
    await service.startBatch(batch.id);
    await service.waitForIdle(batch.id);
    expect(called).toHaveLength(30);
    expect(await service.getBatch(batch.id)).toMatchObject({
      status: "completed",
      counts: { waiting_for_teacher: 1, failed: 1, needs_review: 28 },
    });
    const waiting = (await service.getBatch(batch.id)).jobs.find((job) => job.status === "waiting_for_teacher")!;
    await service.answerQuestion(waiting.id, "附件不是必交项");
    await service.waitForIdle(batch.id);
    expect(called).toContain("session-1:grade");
    expect(await service.getJob(waiting.id)).toMatchObject({ status: "needs_review", attemptCount: 2 });
    service.close();
  });
});
