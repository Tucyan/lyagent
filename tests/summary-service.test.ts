import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GradingSummaryService } from "../src/services/grading-summary-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingSummaryService", () => {
  it("writes hashed JSON and Markdown snapshots and deterministically rebuilds escaped CSV", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-summary-"));
    roots.push(root);
    const service = new GradingSummaryService(root);
    const first = await service.writeSnapshot({
      batchId: "batch-1",
      jobId: "job-1",
      sessionId: "session-1",
      studentName: "张,明",
      studentNumber: "=20260001",
      submissionTitle: "AI\"助手",
      reviewStatus: "needs_review",
      version: 1,
      attemptCount: 1,
      result: { score: { earned: 84, possible: 100 }, confidence: { overall: 0.82, minimum: 0.7, lowCount: 0 }, review: { requiresReview: true, reasons: ["low_confidence"] } },
      updatedAt: "2026-08-05T08:00:00.000Z",
    });
    await service.writeSnapshot({ ...first, jobId: "job-2", sessionId: "session-2", studentName: "李华", studentNumber: "20260002", submissionTitle: "数据分析", resultHash: undefined });

    expect((await service.readSnapshot("batch-1", "job-1", 1))?.resultHash).toMatch(/^[a-f0-9]{64}$/);
    const csv = await service.rebuildCsv("batch-1", [{ id: "job-2", attemptCount: 1 }, { id: "job-1", attemptCount: 1 }]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("'＝20260001".replace("＝", "="));
    expect(csv).toContain('"张,明"');
    expect(csv).toContain('"AI""助手"');
    expect(csv).toContain("0.82");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(await readFile(path.join(root, "batch-grading", "batch-1", "summary.csv"), "utf8")).toBe(csv);
    expect(await readFile(path.join(root, "batch-grading", "batch-1", "results", "job-1-attempt-1.md"), "utf8")).toContain("84/100");
  });
});
