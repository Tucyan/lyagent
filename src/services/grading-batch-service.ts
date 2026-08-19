import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import PQueue from "p-queue";
import { GradingSummaryService, type BatchResultSnapshot } from "./grading-summary-service.js";

export type GradingBatchStatus = "draft" | "running" | "paused" | "completed";
export type GradingBatchJobStatus =
  | "pending"
  | "running"
  | "waiting_for_teacher"
  | "needs_review"
  | "completed"
  | "failed"
  | "cancelled";

export interface BatchSessionSummary {
  id: string;
  assignmentId: string;
  rubricVersion: number;
  conversionStatus: string;
  gradingStatus: string;
  studentName: string;
  studentNumber: string;
  submissionTitle?: string;
}

export interface GradingBatchJob {
  id: string;
  batchId: string;
  sessionId: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  status: GradingBatchJobStatus;
  attemptCount: number;
  maxAttempts: number;
  runId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastErrorCode?: string;
  question?: string;
  score?: { earned: number; possible: number };
  confidence?: { overall: number; minimum: number; lowCount: number };
  reviewStatus?: "needs_review" | "confirmed";
  reviewReasons?: string[];
  resultVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GradingBatch {
  id: string;
  title: string;
  assignmentId: string;
  rubricVersion: number;
  status: GradingBatchStatus;
  concurrency: number;
  totalJobs: number;
  counts: Record<GradingBatchJobStatus, number>;
  createdAt: string;
  updatedAt: string;
}

export interface GradingBatchDetail extends GradingBatch {
  jobs: GradingBatchJob[];
}

export interface BatchExecutionResult {
  status: "completed" | "waiting_for_teacher" | "failed" | "cancelled";
  runId?: string;
  errorCode?: string;
  question?: string;
}

export interface BatchResultSource {
  reviewStatus: "needs_review" | "confirmed";
  version: number;
  result: unknown;
  updatedAt: string;
}

export interface GradingBatchDependencies {
  getSession(id: string): Promise<BatchSessionSummary>;
  execute(sessionId: string, input: { kind: "grade" | "chat"; message: string }): Promise<BatchExecutionResult>;
  readResult(sessionId: string): Promise<BatchResultSource | undefined>;
}

export interface GradingLeaseFence {
  leaseOwner: string;
  attemptCount: number;
}

export class GradingBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingBatchError";
  }
}

export class GradingBatchConflictError extends GradingBatchError {
  constructor(message: string) {
    super(message);
    this.name = "GradingBatchConflictError";
  }
}

interface BatchRow {
  id: string;
  title: string;
  assignment_id: string;
  rubric_version: number;
  status: GradingBatchStatus;
  concurrency: number;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  batch_id: string;
  session_id: string;
  student_name: string;
  student_number: string;
  submission_title: string;
  status: GradingBatchJobStatus;
  attempt_count: number;
  max_attempts: number;
  run_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  question: string | null;
  next_kind: "grade" | "chat";
  next_message: string;
  created_at: string;
  updated_at: string;
}

const ALL_JOB_STATUSES: GradingBatchJobStatus[] = [
  "pending",
  "running",
  "waiting_for_teacher",
  "needs_review",
  "completed",
  "failed",
  "cancelled",
];

export class GradingBatchService {
  private readonly database: Database.Database;
  private readonly now: () => string;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly queues = new Map<string, PQueue>();
  private readonly scheduledJobs = new Set<string>();
  private readonly summaries: GradingSummaryService;

  constructor(
    private readonly root: string,
    private readonly dependencies: GradingBatchDependencies,
    options: {
      now?: () => string;
      workerId?: string;
      leaseMs?: number;
    } = {},
  ) {
    this.database = new Database(path.join(path.resolve(root), "grading.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.now = options.now ?? (() => new Date().toISOString());
    this.workerId = options.workerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 30_000;
    this.summaries = new GradingSummaryService(root);
    this.migrate();
  }

  async createBatch(input: {
    title: string;
    assignmentId: string;
    rubricVersion: number;
    concurrency: number;
    sessionIds: string[];
    sourceUploadId?: string;
  }): Promise<GradingBatch> {
    if (input.sourceUploadId) {
      const source = this.database.prepare(
        "SELECT committed_batch_id FROM grading_batch_uploads WHERE id = ?",
      ).get(input.sourceUploadId) as { committed_batch_id: string | null } | undefined;
      if (!source) throw new GradingBatchConflictError("The batch upload draft was not found");
      if (source.committed_batch_id) return this.getBatchSummary(source.committed_batch_id);
    }
    const title = input.title.trim();
    if (!title || title.length > 120) throw new GradingBatchError("Batch title must contain between 1 and 120 characters");
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 8)
      throw new GradingBatchError("Batch concurrency must be an integer from 1 to 8");
    if (input.sessionIds.length < 1 || input.sessionIds.length > 120)
      throw new GradingBatchError("A grading batch must contain between 1 and 120 reports");
    if (new Set(input.sessionIds).size !== input.sessionIds.length)
      throw new GradingBatchConflictError("A grading session can appear only once in a batch");
    const members = await Promise.all(input.sessionIds.map((id) => this.dependencies.getSession(id)));
    for (const member of members) {
      if (member.assignmentId !== input.assignmentId || member.rubricVersion !== input.rubricVersion)
        throw new GradingBatchConflictError("Every report must use the batch frozen rubric");
      if (member.conversionStatus !== "ready")
        throw new GradingBatchConflictError("Every report must finish conversion before batching");
      if (!member.submissionTitle)
        throw new GradingBatchConflictError("Every report must have a resolved assignment title");
      if (!['not_started', 'failed', 'cancelled'].includes(member.gradingStatus))
        throw new GradingBatchConflictError("A report is already being graded or has a result");
    }
    const placeholders = input.sessionIds.map(() => "?").join(", ");
    const reserved = this.database.prepare(
      `SELECT session_id FROM grading_batch_jobs WHERE session_id IN (${placeholders}) LIMIT 1`,
    ).get(...input.sessionIds) as { session_id: string } | undefined;
    if (reserved) throw new GradingBatchConflictError("A grading session already belongs to another batch");
    const id = randomUUID();
    const now = this.now();
    const insert = this.database.transaction(() => {
      const sessionColumns = new Set((this.database.prepare("PRAGMA table_info(grading_sessions)").all() as Array<{ name: string }>).map(({ name }) => name));
      const hasRuns = Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get());
      for (const member of members) {
        if (sessionColumns.has("grading_status")) {
          const current = this.database.prepare("SELECT grading_status, deletion_pending FROM grading_sessions WHERE id = ?").get(member.id) as { grading_status: string; deletion_pending?: number } | undefined;
          if (!current || current.deletion_pending === 1 || !["not_started", "failed", "cancelled"].includes(current.grading_status))
            throw new GradingBatchConflictError("A report is already being graded or has a result");
        }
        if (hasRuns && this.database.prepare("SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1").get(member.id))
          throw new GradingBatchConflictError("A report already has an active grading run");
      }
      this.database.prepare(
        "INSERT INTO grading_batches (id, title, assignment_id, rubric_version, status, concurrency, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      ).run(id, title, input.assignmentId, input.rubricVersion, input.concurrency, now, now);
      const statement = this.database.prepare(
        `INSERT INTO grading_batch_jobs
         (id, batch_id, session_id, student_name, student_number, submission_title, status, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?)`,
      );
      for (const member of members)
        statement.run(randomUUID(), id, member.id, member.studentName, member.studentNumber, member.submissionTitle, now, now);
      if (input.sourceUploadId) {
        const committed = this.database.prepare(
          `UPDATE grading_batch_uploads SET status = 'committed', committed_batch_id = ?, updated_at = ?
           WHERE id = ? AND status = 'draft' AND committed_batch_id IS NULL`,
        ).run(id, now, input.sourceUploadId);
        if (committed.changes !== 1)
          throw new GradingBatchConflictError("The batch upload draft was already committed");
        this.database.prepare(
          "UPDATE grading_batch_upload_items SET status = 'committed', updated_at = ? WHERE upload_id = ?",
        ).run(now, input.sourceUploadId);
      }
    });
    try { insert.immediate(); }
    catch (error: unknown) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT"))
        throw new GradingBatchConflictError("A grading session already belongs to another batch");
      throw error;
    }
    return this.getBatchSummary(id);
  }

  async listBatches(filter: { assignmentId?: string; rubricVersion?: number } = {}): Promise<GradingBatch[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.assignmentId) { clauses.push("assignment_id = ?"); values.push(filter.assignmentId); }
    if (filter.rubricVersion) { clauses.push("rubric_version = ?"); values.push(filter.rubricVersion); }
    const rows = this.database.prepare(
      `SELECT * FROM grading_batches${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`,
    ).all(...values) as BatchRow[];
    return Promise.all(rows.map((row) => this.batchFromRow(row)));
  }

  async getBatch(batchId: string): Promise<GradingBatchDetail> {
    const jobs = await Promise.all(this.listJobs(batchId).map(async (job) => {
      const source = await this.dependencies.readResult(job.sessionId);
      if (!source) return job;
      const result = source.result as {
        score?: { earned?: unknown; possible?: unknown };
        confidence?: { overall?: unknown; minimum?: unknown; lowCount?: unknown };
        review?: { reasons?: unknown };
      };
      if (typeof result.score?.earned !== "number" || typeof result.score.possible !== "number"
        || typeof result.confidence?.overall !== "number" || typeof result.confidence.minimum !== "number"
        || typeof result.confidence.lowCount !== "number") return job;
      return {
        ...job,
        score: { earned: result.score.earned, possible: result.score.possible },
        confidence: {
          overall: result.confidence.overall,
          minimum: result.confidence.minimum,
          lowCount: result.confidence.lowCount,
        },
        reviewStatus: source.reviewStatus,
        reviewReasons: Array.isArray(result.review?.reasons) ? result.review.reasons.filter((reason): reason is string => typeof reason === "string") : [],
        resultVersion: source.version,
      };
    }));
    return { ...(await this.getBatchSummary(batchId)), jobs };
  }

  async getJob(jobId: string): Promise<GradingBatchJob> {
    const row = this.database.prepare("SELECT * FROM grading_batch_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw new GradingBatchError("Grading batch job was not found");
    return jobFromRow(row);
  }

  async startBatch(batchId: string, options: { schedule?: boolean } = {}): Promise<GradingBatch> {
    const batch = await this.getBatchSummary(batchId);
    if (batch.status !== "draft") throw new GradingBatchConflictError("Only a draft batch can start");
    this.updateBatchStatus(batchId, "draft", "running");
    if (options.schedule !== false) this.schedule(batchId);
    return this.getBatchSummary(batchId);
  }

  async pauseBatch(batchId: string): Promise<GradingBatch> {
    const batch = await this.getBatchSummary(batchId);
    if (batch.status !== "running") throw new GradingBatchConflictError("Only a running batch can pause");
    this.updateBatchStatus(batchId, "running", "paused");
    this.queues.get(batchId)?.pause();
    return this.getBatchSummary(batchId);
  }

  async resumeBatch(batchId: string): Promise<GradingBatch> {
    const batch = await this.getBatchSummary(batchId);
    if (!['paused', 'completed'].includes(batch.status)) throw new GradingBatchConflictError("Only a paused batch can resume");
    if (batch.counts.pending === 0) throw new GradingBatchConflictError("The batch has no pending jobs");
    this.updateBatchStatus(batchId, batch.status, "running");
    const queue = this.queueFor(await this.getBatchSummary(batchId));
    queue.start();
    this.schedule(batchId);
    return this.getBatchSummary(batchId);
  }

  async claimNext(batchId: string, leaseOwner = this.workerId): Promise<GradingBatchJob | undefined> {
    const now = this.now();
    const expires = new Date(Date.parse(now) + this.leaseMs).toISOString();
    const claim = this.database.transaction(() => {
      const batch = this.database.prepare("SELECT status FROM grading_batches WHERE id = ?").get(batchId) as { status: GradingBatchStatus } | undefined;
      if (!batch || batch.status !== "running") return undefined;
      const row = this.database.prepare(
        "SELECT id FROM grading_batch_jobs WHERE batch_id = ? AND status = 'pending' AND attempt_count < max_attempts ORDER BY created_at, rowid LIMIT 1",
      ).get(batchId) as { id: string } | undefined;
      if (!row) return undefined;
      const updated = this.database.prepare(
        `UPDATE grading_batch_jobs SET status = 'running', attempt_count = attempt_count + 1,
         lease_owner = ?, lease_expires_at = ?, last_error_code = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(leaseOwner, expires, now, row.id);
      return updated.changes === 1 ? row.id : undefined;
    });
    const jobId = claim();
    return jobId ? this.getJob(jobId) : undefined;
  }

  async renewLease(jobId: string, leaseOwner = this.workerId): Promise<boolean> {
    const now = this.now();
    const expires = new Date(Date.parse(now) + this.leaseMs).toISOString();
    return this.database.prepare(
      "UPDATE grading_batch_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?",
    ).run(expires, now, jobId, leaseOwner).changes === 1;
  }

  async requeueExpiredLeases(): Promise<number> {
    const now = this.now();
    return this.database.prepare(
      `UPDATE grading_batch_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
       lease_owner = NULL, lease_expires_at = NULL, run_id = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = ?
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    ).run(now, now).changes;
  }

  async failJob(jobId: string, errorCode: string, fence?: GradingLeaseFence): Promise<GradingBatchJob> {
    const job = await this.getJob(jobId);
    if (job.status !== "running") throw new GradingBatchConflictError("Only a running job can fail");
    const expected = fence ?? { leaseOwner: job.leaseOwner ?? "", attemptCount: job.attemptCount };
    const updated = this.database.prepare(
      `UPDATE grading_batch_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
       last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempt_count = ?`,
    ).run(errorCode, this.now(), jobId, expected.leaseOwner, expected.attemptCount);
    if (updated.changes !== 1) throw new GradingBatchConflictError("The grading job lease is no longer owned by this execution");
    if (await this.finishBatchIfSettled(job.batchId)) await this.rebuildSummary(job.batchId);
    return this.getJob(jobId);
  }

  async retryJob(jobId: string, options: { schedule?: boolean } = {}): Promise<GradingBatchJob> {
    const job = await this.getJob(jobId);
    if (!["failed", "needs_review"].includes(job.status)) throw new GradingBatchConflictError("Only a failed or needs-review job can retry");
    if (job.attemptCount >= job.maxAttempts) throw new GradingBatchConflictError("The grading job retry limit has been reached");
    this.database.prepare(
      `UPDATE grading_batch_jobs SET status = 'pending', run_id = NULL, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = ?`,
    ).run(this.now(), jobId, job.status);
    const batch = await this.getBatchSummary(job.batchId);
    if (batch.status === "completed") this.updateBatchStatus(job.batchId, "completed", "running");
    if (options.schedule !== false && (await this.getBatchSummary(job.batchId)).status === "running") this.schedule(job.batchId);
    return this.getJob(jobId);
  }

  async answerQuestion(jobId: string, answer: string): Promise<GradingBatchJob> {
    const message = answer.trim();
    if (!message || message.length > 8_000) throw new GradingBatchError("A teacher answer must contain between 1 and 8000 characters");
    const job = await this.getJob(jobId);
    if (job.status !== "waiting_for_teacher") throw new GradingBatchConflictError("Only a waiting job can receive a teacher answer");
    if (job.attemptCount >= job.maxAttempts) throw new GradingBatchConflictError("The grading job retry limit has been reached");
    this.database.prepare(
      `UPDATE grading_batch_jobs SET status = 'pending', question = NULL, next_kind = 'grade', next_message = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_for_teacher'`,
    ).run(`请根据教师对批改问题“${job.question ?? "未记录问题"}”的回答继续完成批改并提交完整草稿。教师回答：${message}`, this.now(), jobId);
    const batch = await this.getBatchSummary(job.batchId);
    if (batch.status === "completed") this.updateBatchStatus(job.batchId, "completed", "running");
    this.schedule(job.batchId);
    return this.getJob(jobId);
  }

  async waitForIdle(batchId: string): Promise<GradingBatch> {
    const batch = await this.getBatchSummary(batchId);
    await this.queueFor(batch).onIdle();
    return this.getBatchSummary(batchId);
  }

  async readSnapshot(batchId: string, jobId: string): Promise<BatchResultSnapshot | undefined> {
    const job = await this.getJob(jobId);
    const snapshot = await this.summaries.readSnapshot(batchId, jobId, job.attemptCount);
    return snapshot?.attemptCount === job.attemptCount ? snapshot : undefined;
  }

  async rebuildSummary(batchId: string): Promise<string> {
    const jobs = this.listJobs(batchId);
    return this.summaries.rebuildCsv(batchId, jobs.map(({ id, attemptCount }) => ({ id, attemptCount })));
  }

  async refreshResultsAndRebuildSummary(batchId: string): Promise<string> {
    for (const job of this.listJobs(batchId)) {
      if (!["needs_review", "completed"].includes(job.status)) continue;
      const source = await this.dependencies.readResult(job.sessionId);
      if (!source) continue;
      const existing = await this.summaries.readSnapshot(batchId, job.id, job.attemptCount);
      if (!existing || existing.attemptCount !== job.attemptCount || existing.version !== source.version || existing.reviewStatus !== source.reviewStatus || existing.updatedAt !== source.updatedAt) {
        await this.writeJobSnapshot(job, source);
      } else await this.summaries.ensureSnapshotArtifacts(batchId, job.id, job.attemptCount);
      const nextStatus = source.reviewStatus === "confirmed" ? "completed" : "needs_review";
      if (job.status !== nextStatus) this.database.prepare(
        "UPDATE grading_batch_jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('needs_review', 'completed')",
      ).run(nextStatus, this.now(), job.id);
    }
    return this.rebuildSummary(batchId);
  }

  assertDirectRunAllowed(sessionId: string): void {
    const reserved = this.database.prepare(
      "SELECT 1 FROM grading_batch_jobs WHERE session_id = ? LIMIT 1",
    ).get(sessionId);
    if (reserved) throw new GradingBatchConflictError("This grading session is reserved by a batch");
  }

  async recover(): Promise<{ reconciledResults: number; requeuedLeases: number }> {
    let reconciledResults = 0;
    const candidates = this.database.prepare(
      "SELECT * FROM grading_batch_jobs WHERE status IN ('pending', 'running') ORDER BY created_at, rowid",
    ).all() as JobRow[];
    for (const row of candidates) {
      const job = jobFromRow(row);
      let existing = await this.summaries.ensureSnapshotArtifacts(job.batchId, job.id, job.attemptCount);
      if (existing && existing.attemptCount !== job.attemptCount) existing = undefined;
      const source = existing ? undefined : await this.dependencies.readResult(job.sessionId);
      if (!existing && !source) continue;
      if (source) await this.writeJobSnapshot(job, source);
      this.database.prepare(
        `UPDATE grading_batch_jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')`,
      ).run((existing?.reviewStatus ?? source!.reviewStatus) === "confirmed" ? "completed" : "needs_review", this.now(), job.id);
      reconciledResults += 1;
      if (await this.finishBatchIfSettled(job.batchId)) await this.rebuildSummary(job.batchId);
    }
    const requeuedLeases = await this.requeueOrphanedLeases();
    for (const batch of await this.listBatches()) {
      await this.refreshResultsAndRebuildSummary(batch.id);
      if (await this.finishBatchIfSettled(batch.id)) await this.rebuildSummary(batch.id);
      if ((await this.getBatchSummary(batch.id)).status === "running") this.schedule(batch.id);
    }
    return { reconciledResults, requeuedLeases };
  }

  private async requeueOrphanedLeases(): Promise<number> {
    const now = this.now();
    return this.database.prepare(
      `UPDATE grading_batch_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
       lease_owner = NULL, lease_expires_at = NULL, run_id = NULL, last_error_code = 'LEASE_ORPHANED', updated_at = ?
       WHERE status = 'running' AND (lease_owner IS NULL OR lease_owner <> ?)`,
    ).run(now, this.workerId).changes;
  }

  close(): void {
    for (const queue of this.queues.values()) {
      queue.pause();
      queue.clear();
    }
    if (this.database.open) this.database.close();
  }

  private schedule(batchId: string): void {
    const row = this.database.prepare("SELECT * FROM grading_batches WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!row) return;
    const queue = this.queues.get(batchId) ?? new PQueue({ concurrency: row.concurrency });
    if (!this.queues.has(batchId)) this.queues.set(batchId, queue);
    if (row.status === "paused") queue.pause();
    for (const job of this.listJobs(batchId)) {
      if (job.status !== "pending" || this.scheduledJobs.has(job.id)) continue;
      this.scheduledJobs.add(job.id);
      void queue.add(async () => this.executeScheduledJob(batchId, job.id))
        .catch(() => undefined)
        .finally(() => this.scheduledJobs.delete(job.id));
    }
  }

  private queueFor(batch: GradingBatch): PQueue {
    const existing = this.queues.get(batch.id);
    if (existing) return existing;
    const queue = new PQueue({ concurrency: batch.concurrency });
    if (batch.status === "paused") queue.pause();
    this.queues.set(batch.id, queue);
    return queue;
  }

  private async executeScheduledJob(batchId: string, jobId: string): Promise<void> {
    const claimed = await this.claimJob(batchId, jobId, this.workerId);
    if (!claimed) return;
    const execution = this.database.prepare("SELECT next_kind, next_message FROM grading_batch_jobs WHERE id = ?").get(jobId) as Pick<JobRow, "next_kind" | "next_message">;
    const fence = { leaseOwner: this.workerId, attemptCount: claimed.attemptCount };
    const interval = setInterval(() => {
      void this.renewLease(jobId, this.workerId).catch(() => undefined);
    }, Math.max(100, Math.floor(this.leaseMs / 2)));
    interval.unref?.();
    try {
      const result = await this.dependencies.execute(claimed.sessionId, {
        kind: execution.next_kind,
        message: execution.next_message,
      });
      if (result.status === "waiting_for_teacher") {
        await this.settleJob(jobId, "waiting_for_teacher", {
          ...(result.runId ? { runId: result.runId } : {}),
          ...(result.question ? { question: result.question } : {}),
        }, fence);
      } else if (result.status === "completed") {
        const source = await this.dependencies.readResult(claimed.sessionId);
        if (!source) await this.failJob(jobId, "GRADING_RESULT_MISSING", fence);
        else {
          await this.writeJobSnapshot(claimed, source, fence);
          await this.settleJob(jobId, source.reviewStatus === "confirmed" ? "completed" : "needs_review", {
            ...(result.runId ? { runId: result.runId } : {}),
          }, fence);
        }
      } else if (result.status === "cancelled") {
        await this.settleJob(jobId, "cancelled", {
          ...(result.runId ? { runId: result.runId } : {}),
        }, fence);
      } else await this.failJob(jobId, result.errorCode ?? "GRADING_MODEL_REQUEST_FAILED", fence);
    } catch {
      const current = await this.getJob(jobId);
      if (current.status === "running") await this.failJob(jobId, "GRADING_MODEL_REQUEST_FAILED", fence).catch(() => undefined);
    } finally {
      clearInterval(interval);
    }
  }

  private async claimJob(batchId: string, jobId: string, leaseOwner: string): Promise<GradingBatchJob | undefined> {
    const now = this.now();
    const expires = new Date(Date.parse(now) + this.leaseMs).toISOString();
    const result = this.database.prepare(
      `UPDATE grading_batch_jobs SET status = 'running', attempt_count = attempt_count + 1,
       lease_owner = ?, lease_expires_at = ?, last_error_code = NULL, updated_at = ?
       WHERE id = ? AND batch_id = ? AND status = 'pending' AND attempt_count < max_attempts
       AND EXISTS (SELECT 1 FROM grading_batches WHERE id = ? AND status = 'running')`,
    ).run(leaseOwner, expires, now, jobId, batchId, batchId);
    return result.changes === 1 ? this.getJob(jobId) : undefined;
  }

  private async settleJob(
    jobId: string,
    status: "waiting_for_teacher" | "needs_review" | "completed" | "cancelled",
    details: { runId?: string; question?: string },
    fence: GradingLeaseFence,
  ): Promise<GradingBatchJob> {
    const job = await this.getJob(jobId);
    if (job.status !== "running") throw new GradingBatchConflictError("Only a running job can settle");
    const result = this.database.prepare(
      `UPDATE grading_batch_jobs SET status = ?, run_id = ?, question = ?, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempt_count = ?`,
    ).run(status, details.runId ?? null, details.question ?? null, this.now(), jobId, fence.leaseOwner, fence.attemptCount);
    if (result.changes !== 1) throw new GradingBatchConflictError("The grading job lease is no longer owned by this execution");
    if (await this.finishBatchIfSettled(job.batchId)) await this.rebuildSummary(job.batchId);
    return this.getJob(jobId);
  }

  private async writeJobSnapshot(job: GradingBatchJob, source: BatchResultSource, fence?: GradingLeaseFence): Promise<BatchResultSnapshot> {
    if (fence) {
      const owned = this.database.prepare(
        "SELECT 1 FROM grading_batch_jobs WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempt_count = ?",
      ).get(job.id, fence.leaseOwner, fence.attemptCount);
      if (!owned) throw new GradingBatchConflictError("The grading job lease is no longer owned by this execution");
    }
    return this.summaries.writeSnapshot({
      batchId: job.batchId,
      jobId: job.id,
      sessionId: job.sessionId,
      studentName: job.studentName,
      studentNumber: job.studentNumber,
      submissionTitle: job.submissionTitle,
      reviewStatus: source.reviewStatus,
      version: source.version,
      attemptCount: fence?.attemptCount ?? job.attemptCount,
      result: source.result,
      updatedAt: source.updatedAt,
    });
  }

  private listJobs(batchId: string): GradingBatchJob[] {
    return (this.database.prepare(
      "SELECT * FROM grading_batch_jobs WHERE batch_id = ? ORDER BY created_at, rowid",
    ).all(batchId) as JobRow[]).map(jobFromRow);
  }

  private async getBatchSummary(batchId: string): Promise<GradingBatch> {
    const row = this.database.prepare("SELECT * FROM grading_batches WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!row) throw new GradingBatchError("Grading batch was not found");
    return this.batchFromRow(row);
  }

  private async batchFromRow(row: BatchRow): Promise<GradingBatch> {
    const counts = Object.fromEntries(ALL_JOB_STATUSES.map((status) => [status, 0])) as Record<GradingBatchJobStatus, number>;
    for (const item of this.database.prepare(
      "SELECT status, COUNT(*) AS count FROM grading_batch_jobs WHERE batch_id = ? GROUP BY status",
    ).all(row.id) as Array<{ status: GradingBatchJobStatus; count: number }>) counts[item.status] = item.count;
    return {
      id: row.id,
      title: row.title,
      assignmentId: row.assignment_id,
      rubricVersion: row.rubric_version,
      status: row.status,
      concurrency: row.concurrency,
      totalJobs: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private updateBatchStatus(batchId: string, expected: GradingBatchStatus, status: GradingBatchStatus): void {
    const result = this.database.prepare(
      "UPDATE grading_batches SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(status, this.now(), batchId, expected);
    if (result.changes !== 1) throw new GradingBatchConflictError("The grading batch changed concurrently");
  }

  private async finishBatchIfSettled(batchId: string): Promise<boolean> {
    const active = this.database.prepare(
      "SELECT COUNT(*) AS count FROM grading_batch_jobs WHERE batch_id = ? AND status IN ('pending', 'running')",
    ).get(batchId) as { count: number };
    if (active.count !== 0) return false;
    return this.database.prepare("UPDATE grading_batches SET status = 'completed', updated_at = ? WHERE id = ? AND status IN ('running', 'paused')").run(this.now(), batchId).changes === 1;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS grading_batches (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        rubric_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 8),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grading_batch_jobs (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES grading_batches(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES grading_sessions(id) ON DELETE RESTRICT,
        student_name TEXT NOT NULL,
        student_number TEXT NOT NULL,
        submission_title TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        question TEXT,
        next_kind TEXT NOT NULL DEFAULT 'grade',
        next_message TEXT NOT NULL DEFAULT '请开始批改当前作业。',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (batch_id, session_id),
        UNIQUE (batch_id, student_number)
      );
      CREATE INDEX IF NOT EXISTS grading_batch_jobs_claim_idx
        ON grading_batch_jobs(batch_id, status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS grading_batch_jobs_session_unique_idx
        ON grading_batch_jobs(session_id);
    `);
    const columns = new Set((this.database.prepare("PRAGMA table_info(grading_batch_jobs)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("next_kind")) this.database.exec("ALTER TABLE grading_batch_jobs ADD COLUMN next_kind TEXT NOT NULL DEFAULT 'grade'");
    if (!columns.has("next_message")) this.database.exec("ALTER TABLE grading_batch_jobs ADD COLUMN next_message TEXT NOT NULL DEFAULT '请开始批改当前作业。'");
    this.database.pragma("user_version = 5");
  }
}

function jobFromRow(row: JobRow): GradingBatchJob {
  return {
    id: row.id,
    batchId: row.batch_id,
    sessionId: row.session_id,
    studentName: row.student_name,
    studentNumber: row.student_number,
    submissionTitle: row.submission_title,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.question ? { question: row.question } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
