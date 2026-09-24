import { describe, expect, it } from "vitest";
import { applyUploadDraftResponse, batchActions, batchProgress, batchReviewHref, batchStatusLabel, batchUploadItemStatusLabel, canCommitBatchUpload, canConfirmBatchJob, canConfirmFromBatchList, canRetryBatchJob, completeCommittedUploadDraftRestore, formatBatchConfidence, formatBatchScore, shouldPollBatch, shouldPollBatchUpload, UploadDraftRequestTracker, waitForBatchSessionsReady } from "../web/src/pages/grading-batch-page-model.js";
import { LatestRequestGate } from "../web/src/lib/async-state.js";

describe("batch grading page model", () => {
  it("clears a committed restored upload draft and selects its formal batch", () => {
    const tracker = new UploadDraftRequestTracker();
    const gate = new LatestRequestGate();
    tracker.set("draft-committed");
    const priorRequest = gate.begin();
    let visibleDraft: { id: string; status: string } | undefined = { id: "draft-committed", status: "committed" };
    let storedDraftId: string | undefined = "draft-committed";
    let selectedBatchId: string | undefined;

    const consumed = completeCommittedUploadDraftRestore(
      { id: "draft-committed", status: "committed", committedBatchId: "batch-committed" },
      tracker,
      {
        invalidateRequests: () => gate.invalidate(),
        removeStoredDraft: () => { storedDraftId = undefined; },
        clearDraft: () => { visibleDraft = undefined; },
        selectBatch: (id) => { selectedBatchId = id; },
      },
    );

    expect(consumed).toBe(true);
    expect(visibleDraft).toBeUndefined();
    expect(storedDraftId).toBeUndefined();
    expect(selectedBatchId).toBe("batch-committed");
    expect(tracker.matches("draft-committed")).toBe(false);
    expect(priorRequest.isCurrent()).toBe(false);

    tracker.set("draft-next");
    expect(tracker.matches("draft-next")).toBe(true);
  });

  it("keeps an in-flight restore valid while rubric, list, and detail updates arrive", async () => {
    const tracker = new UploadDraftRequestTracker();
    const gate = new LatestRequestGate();
    const lease = gate.begin();
    const restoredDraftId = "draft-restored";
    tracker.set(restoredDraftId);
    let finishRestore!: (response: { id: string; status: string; items: Array<{ status: string }> }) => void;
    const restoreResponse = new Promise<{ id: string; status: string; items: Array<{ status: string }> }>((resolve) => { finishRestore = resolve; });
    let visibleDraft: { id: string; status: string; items: Array<{ status: string }> } | undefined;
    const restoreRequest = restoreResponse.then((response) => {
      if (lease.isCurrent()) applyUploadDraftResponse(tracker, restoredDraftId, response, (draft) => { visibleDraft = draft; });
    });

    // These successive view-state updates model unrelated page rerenders while fetch is pending.
    let view = { rubricKey: "assignment-1:2", batchIds: [] as string[], detailId: undefined as string | undefined };
    view = { ...view, rubricKey: "assignment-2:3" };
    view = { ...view, batchIds: ["batch-7"] };
    view = { ...view, detailId: "batch-7" };
    expect(view).toEqual({ rubricKey: "assignment-2:3", batchIds: ["batch-7"], detailId: "batch-7" });
    expect(tracker.matches(restoredDraftId)).toBe(true);

    const nextDraft = { id: restoredDraftId, status: "draft", items: [{ status: "ready" }] };
    finishRestore(nextDraft);
    await restoreRequest;
    expect(visibleDraft).toEqual(nextDraft);

    // A later create takes ownership, and a response for the previous draft is rejected.
    tracker.set("draft-new");
    expect(tracker.matches(restoredDraftId)).toBe(false);
    expect(applyUploadDraftResponse(tracker, restoredDraftId, nextDraft, (response) => { visibleDraft = response; })).toBe(false);
    tracker.set(undefined);
    expect(tracker.matches("draft-new")).toBe(false);
    tracker.set("draft-cancelled");
    tracker.set(undefined);
    expect(tracker.matches("draft-cancelled")).toBe(false);
  });

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

  it("formats review facts and exposes only legal review actions", () => {
    const needsReview = { status: "needs_review", attemptCount: 1, maxAttempts: 3, resultVersion: 2, reviewStatus: "needs_review" as const, requiresReview: true, reviewReasons: ["LOW_CONFIDENCE"] };
    expect(formatBatchScore({ score: { earned: 87, possible: 100 } })).toBe("87/100");
    expect(formatBatchScore({})).toBe("—");
    expect(formatBatchConfidence({ confidence: { overall: 0.823 } })).toBe("82%");
    expect(formatBatchConfidence({})).toBe("—");
    expect(canRetryBatchJob(needsReview)).toBe(true);
    expect(canRetryBatchJob({ ...needsReview, attemptCount: 3 })).toBe(false);
    expect(canConfirmBatchJob(needsReview)).toBe(true);
    expect(canConfirmFromBatchList(needsReview)).toBe(false);
    const { reviewStatus: _reviewStatus, ...withoutReviewStatus } = needsReview;
    expect(canConfirmFromBatchList(withoutReviewStatus)).toBe(false);
    const ordinaryDraft = { ...needsReview, requiresReview: false, reviewReasons: [] };
    expect(ordinaryDraft).toMatchObject({ status: "needs_review", reviewStatus: "needs_review", requiresReview: false, reviewReasons: [] });
    expect(canConfirmFromBatchList(ordinaryDraft)).toBe(true);
    expect(canConfirmFromBatchList({ ...ordinaryDraft, reviewReasons: ["LOW_CONFIDENCE"] })).toBe(false);
    const { reviewReasons: _reviewReasons, ...withoutReviewReasons } = ordinaryDraft;
    expect(canConfirmFromBatchList(withoutReviewReasons)).toBe(false);
    expect(canConfirmFromBatchList({ ...ordinaryDraft, reviewStatus: "confirmed" })).toBe(false);
    expect(canConfirmBatchJob({ ...needsReview, reviewStatus: "confirmed" })).toBe(false);
    expect(batchReviewHref("batch 1", "session/1")).toBe("/grading/batches/review?batch=batch+1&session=session%2F1");
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
