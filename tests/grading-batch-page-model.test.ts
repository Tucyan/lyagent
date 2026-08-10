import { describe, expect, it } from "vitest";
import { batchActions, batchProgress, batchStatusLabel, batchUploadItemStatusLabel, canCommitBatchUpload, shouldPollBatch, shouldPollBatchUpload, waitForBatchSessionsReady } from "../web/src/pages/grading-batch-page-model.js";

describe("batch grading page model", () => {
  it("derives progress and legal controls from persistent batch state", () => {
    const counts = { pending: 20, running: 4, waiting_for_teacher: 1, needs_review: 4, completed: 0, failed: 1, cancelled: 0 };
    expect(batchProgress({ totalJobs: 30, counts })).toEqual({ settled: 6, percent: 20 });
    expect(batchActions({ status: "running", totalJobs: 30, counts })).toEqual({ canStart: false, canPause: true, canResume: false, canExport: true });
    expect(batchActions({ status: "paused", totalJobs: 30, counts })).toMatchObject({ canPause: false, canResume: true });
    expect(batchStatusLabel("waiting_for_teacher")).toBe("等待教师");
    expect(shouldPollBatch({ status: "paused", counts: { ...counts, running: 4 } })).toBe(true);
    expect(shouldPollBatch({ status: "paused", counts: { ...counts, running: 0 } })).toBe(false);
  });

  it("allows a small batch with ten reports to start", () => {
    const counts = { pending: 10, running: 0, waiting_for_teacher: 0, needs_review: 0, completed: 0, failed: 0, cancelled: 0 };
    expect(batchActions({ status: "draft", totalJobs: 10, counts }).canStart).toBe(true);
  });

  it("polls active upload items and commits only when every retained item is ready", () => {
    expect(shouldPollBatchUpload({ status: "draft", items: [{ status: "converting" }, { status: "failed" }] })).toBe(true);
    expect(shouldPollBatchUpload({ status: "draft", items: [{ status: "ready" }, { status: "identity_required" }] })).toBe(false);
    expect(canCommitBatchUpload({ status: "draft", items: [{ status: "ready" }, { status: "ready" }] })).toBe(true);
    expect(canCommitBatchUpload({ status: "draft", items: [{ status: "ready" }, { status: "failed" }] })).toBe(false);
    expect(batchUploadItemStatusLabel("identity_required")).toBe("待补填身份");
  });

  it("waits for asynchronous conversions and reports terminal conversion failures", async () => {
    const states = new Map([
      ["session-1", ["queued", "converting", "ready"]],
      ["session-2", ["ready"]],
    ]);
    const ready = await waitForBatchSessionsReady(["session-1", "session-2"], async (id) => {
      const queue = states.get(id)!;
      return { id, conversionStatus: queue.shift() ?? "ready", submissionTitleStatus: "provided" };
    }, { delay: async () => undefined, maxPolls: 4 });
    expect(ready.map(({ id }) => id)).toEqual(["session-1", "session-2"]);

    await expect(waitForBatchSessionsReady(["bad"], async () => ({ id: "bad", conversionStatus: "conversion_failed", submissionTitleStatus: "provided" }), { delay: async () => undefined, maxPolls: 1 }))
      .rejects.toThrow("bad 转换失败");
  });
});
