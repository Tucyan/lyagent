export type BatchJobCounts = {
  pending: number;
  running: number;
  waiting_for_teacher: number;
  needs_review: number;
  completed: number;
  failed: number;
  cancelled: number;
};

export class UploadDraftRequestTracker {
  private draftId: string | undefined;

  set(draftId: string | undefined): void {
    this.draftId = draftId;
  }

  matches(draftId: string): boolean {
    return this.draftId === draftId;
  }
}

export function applyUploadDraftResponse<T extends { id: string }>(
  tracker: UploadDraftRequestTracker,
  requestId: string,
  response: T,
  apply: (response: T) => void,
): boolean {
  if (!tracker.matches(requestId) || response.id !== requestId) return false;
  apply(response);
  return true;
}

export function completeCommittedUploadDraftRestore(
  draft: { id: string; status: string; committedBatchId?: string },
  tracker: UploadDraftRequestTracker,
  actions: {
    invalidateRequests: () => void;
    removeStoredDraft: () => void;
    clearDraft: () => void;
    selectBatch: (id: string | undefined) => void;
  },
): boolean {
  if (draft.status !== "committed") return false;
  actions.removeStoredDraft();
  tracker.set(undefined);
  actions.invalidateRequests();
  actions.clearDraft();
  actions.selectBatch(draft.committedBatchId);
  return true;
}

export type BatchReviewJob = {
  status: string;
  attemptCount: number;
  maxAttempts: number;
  resultVersion?: number;
  reviewStatus?: "needs_review" | "confirmed";
  requiresReview?: boolean;
  reviewReasons?: string[];
  score?: { earned: number; possible: number };
  confidence?: { overall: number };
};

export function batchJobStatusLabel(job: Pick<BatchReviewJob, "status" | "reviewStatus">): string {
  return job.reviewStatus === "confirmed" ? "成绩已确认" : batchStatusLabel(job.status);
}

export function formatBatchScore(job: Pick<BatchReviewJob, "score">): string {
  return job.score ? `${job.score.earned}/${job.score.possible}` : "—";
}

export function formatBatchConfidence(job: Pick<BatchReviewJob, "confidence">): string {
  return job.confidence ? `${Math.round(job.confidence.overall * 100)}%` : "—";
}

export function canRetryBatchJob(job: Pick<BatchReviewJob, "status" | "attemptCount" | "maxAttempts">): boolean {
  return ["failed", "needs_review"].includes(job.status) && job.attemptCount < job.maxAttempts;
}

export function canConfirmBatchJob(job: Pick<BatchReviewJob, "resultVersion" | "reviewStatus">): boolean {
  return job.reviewStatus === "needs_review" && Number.isInteger(job.resultVersion);
}

export function canConfirmFromBatchList(job: Pick<BatchReviewJob, "resultVersion" | "reviewStatus" | "requiresReview" | "reviewReasons">): boolean {
  return job.requiresReview === false && job.reviewReasons?.length === 0 && job.reviewStatus !== "confirmed" && Number.isInteger(job.resultVersion);
}

export function batchReviewHref(batchId: string, sessionId?: string): string {
  const params = new URLSearchParams({ batch: batchId });
  if (sessionId) params.set("session", sessionId);
  return `/grading/batches/review?${params.toString()}`;
}

export function batchProgress(batch: { totalJobs: number; counts: BatchJobCounts }) {
  const settled = batch.counts.waiting_for_teacher + batch.counts.needs_review + batch.counts.completed + batch.counts.failed + batch.counts.cancelled;
  return { settled, percent: batch.totalJobs ? Math.round(settled / batch.totalJobs * 100) : 0 };
}

export function batchActions(batch: { status: string; totalJobs: number; counts: BatchJobCounts }) {
  return {
    canStart: batch.status === "draft" && batch.totalJobs >= 1,
    canPause: batch.status === "running",
    canResume: batch.status === "paused" && batch.counts.pending > 0,
    canExport: batch.counts.needs_review + batch.counts.completed > 0,
  };
}

export function shouldPollBatch(batch: { status: string; counts: Pick<BatchJobCounts, "running"> }): boolean {
  return batch.status === "running" || (batch.status === "paused" && batch.counts.running > 0);
}

export function shouldPollBatchUpload(upload: { status: string; items: Array<{ status: string }> }): boolean {
  return upload.status === "draft" && upload.items.some(({ status }) => ["pending", "converting", "naming"].includes(status));
}

export function canCommitBatchUpload(upload: { status: string; items: Array<{ status: string }> }): boolean {
  return upload.status === "draft" && upload.items.length > 0 && upload.items.every(({ status }) => status === "ready");
}

export function batchUploadItemStatusLabel(status: string): string {
  return ({
    pending: "等待处理",
    identity_required: "待补填身份",
    converting: "正在转换",
    naming: "正在识别名称",
    ready: "已就绪",
    failed: "失败",
    committed: "已创建批次",
  } as Record<string, string>)[status] ?? status;
}

export function batchStatusLabel(status: string): string {
  return ({
    draft: "待启动",
    running: "批改中",
    paused: "已暂停",
    completed: "本轮已结束",
    pending: "等待中",
    waiting_for_teacher: "等待教师",
    needs_review: "待复核",
    failed: "失败",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? status;
}

export interface BatchUploadSessionState {
  id: string;
  conversionStatus: string;
  submissionTitleStatus: string;
}

export async function waitForBatchSessionsReady(
  sessionIds: string[],
  readSession: (id: string) => Promise<BatchUploadSessionState>,
  options: { delay?: () => Promise<void>; maxPolls?: number } = {},
): Promise<BatchUploadSessionState[]> {
  const delay = options.delay ?? (() => new Promise((resolve) => setTimeout(resolve, 800)));
  const maxPolls = options.maxPolls ?? 750;
  const terminalFailures = new Set(["conversion_failed", "result_rejected"]);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const states = await Promise.all(sessionIds.map(readSession));
    const failed = states.find((state) => terminalFailures.has(state.conversionStatus) || state.submissionTitleStatus === "failed");
    if (failed) throw new Error(`${failed.id} 转换失败，请在单份批改页检查并重试`);
    if (states.every((state) => state.conversionStatus === "ready" && ["provided", "resolved"].includes(state.submissionTitleStatus))) return states;
    await delay();
  }
  throw new Error("等待作业转换超时；已上传的会话仍保留，可在单份批改页检查状态");
}
