import { describe, expect, it } from "vitest";
import { clampBatchReviewReportPercent, parseBatchReviewLocation, selectBatchReviewSession } from "../web/src/pages/grading-batch-review-page-model.js";

describe("batch review page model", () => {
  const jobs = [
    { sessionId: "first", status: "completed", reviewStatus: "confirmed" },
    { sessionId: "review", status: "needs_review", reviewStatus: "needs_review" },
  ] as const;

  it("parses stable batch and session query state", () => {
    expect(parseBatchReviewLocation("?batch=batch%201&session=review")).toEqual({ batchId: "batch 1", sessionId: "review" });
    expect(parseBatchReviewLocation("?session=orphan")).toEqual({ batchId: undefined, sessionId: "orphan" });
  });

  it("keeps a valid selection and otherwise prioritizes work needing review", () => {
    expect(selectBatchReviewSession([...jobs], "first")?.sessionId).toBe("first");
    expect(selectBatchReviewSession([...jobs], "missing")?.sessionId).toBe("review");
  });

  it("keeps the draggable report pane usable", () => {
    expect(clampBatchReviewReportPercent(10)).toBe(25);
    expect(clampBatchReviewReportPercent(62)).toBe(62);
    expect(clampBatchReviewReportPercent(90)).toBe(75);
  });
});
