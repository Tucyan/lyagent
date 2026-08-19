export type BatchReviewSelectableJob = {
  sessionId: string;
  status: string;
  reviewStatus?: "needs_review" | "confirmed";
};

export function parseBatchReviewLocation(search: string): { batchId: string | undefined; sessionId: string | undefined } {
  const params = new URLSearchParams(search);
  return {
    batchId: params.get("batch") || undefined,
    sessionId: params.get("session") || undefined,
  };
}

export function selectBatchReviewSession<T extends BatchReviewSelectableJob>(jobs: T[], requestedSessionId?: string): T | undefined {
  return jobs.find(({ sessionId }) => sessionId === requestedSessionId)
    ?? jobs.find(({ reviewStatus, status }) => reviewStatus === "needs_review" || status === "needs_review")
    ?? jobs[0];
}

export function clampBatchReviewReportPercent(value: number): number {
  return Math.min(75, Math.max(25, value));
}
