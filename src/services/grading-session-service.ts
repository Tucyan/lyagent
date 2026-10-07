import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { Unzip } from "fflate";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import type { LockedSubmission } from "../schemas/grading.js";
import type { RubricService } from "./rubric-service.js";

export type ConversionStatus =
  | "queued"
  | "running"
  | "waiting_for_converter"
  | "ready"
  | "conversion_failed"
  | "result_rejected";
export type ConversionFailureStatus = Extract<
  ConversionStatus,
  "waiting_for_converter" | "conversion_failed" | "result_rejected"
>;
export type ConversionErrorCode =
  | "CONVERTER_UNAVAILABLE"
  | "CONVERSION_TIMEOUT"
  | "CONVERTER_TASK_LOST"
  | "CONVERSION_FAILED"
  | "RESULT_REJECTED"
  | "ORIGINAL_UNAVAILABLE"
  | "INTERNAL_CONVERSION_ERROR"
  | "LEGACY_CONVERSION_FAILURE";

export interface ConversionErrorDetails {
  code: ConversionErrorCode;
  message: string;
  retryable: boolean;
  lastFailedAt: string;
  nextRetryAt?: string;
}
export type GradingStatus =
  | "not_started"
  | "queued"
  | "running"
  | "waiting_for_teacher"
  | "draft_ready"
  | "needs_review"
  | "confirmed"
  | "failed"
  | "cancelled";
export type SubmissionTitleStatus =
  "provided" | "pending" | "resolving" | "resolved" | "failed";
export type SubmissionTitleErrorCode =
  | "SUBMISSION_TITLE_MODEL_FAILED"
  | "SUBMISSION_TITLE_TOOL_MISSING"
  | "LEGACY_SUBMISSION_TITLE_FAILURE";
export interface SubmissionTitleErrorDetails {
  code: SubmissionTitleErrorCode;
  message: string;
  lastFailedAt: string;
}

export interface GradingSession {
  id: string;
  courseId: string;
  assignmentId: string;
  rubricVersion: number;
  rubricHash: string;
  batchId: string;
  studentKey: string;
  studentName: string;
  studentNumber: string;
  title: string;
  submissionTitle?: string;
  submissionTitleStatus: SubmissionTitleStatus;
  submissionTitleError?: SubmissionTitleErrorDetails;
  autoStartAfterConversion: boolean;
  conversionStatus: ConversionStatus;
  conversionAttemptCount: number;
  conversionError?: ConversionErrorDetails;
  gradingStatus: GradingStatus;
  activeRunId?: string;
  submissionVersion?: number;
  submissionHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  course_id: string;
  assignment_id: string;
  rubric_version: number;
  rubric_hash: string;
  batch_id: string;
  student_key: string;
  student_name: string;
  student_number: string;
  title: string;
  submission_title: string | null;
  submission_title_status: SubmissionTitleStatus;
  submission_title_error_code: SubmissionTitleErrorCode | null;
  submission_title_error_message: string | null;
  submission_title_last_failed_at: string | null;
  auto_start: number;
  conversion_status: ConversionStatus;
  conversion_attempt_count: number;
  conversion_error_code: ConversionErrorCode | null;
  conversion_error_message: string | null;
  conversion_retryable: number;
  conversion_last_failed_at: string | null;
  conversion_next_retry_at: string | null;
  grading_status: GradingStatus;
  active_run_id: string | null;
  submission_version: number | null;
  submission_hash: string | null;
  created_at: string;
  updated_at: string;
}

export class GradingSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingSessionError";
  }
}

export type SubmissionAssetErrorCode =
  | "SUBMISSION_ASSET_MANIFEST_INVALID"
  | "SUBMISSION_ASSET_PATH_INVALID"
  | "SUBMISSION_ASSET_DUPLICATE_PATH"
  | "SUBMISSION_ASSET_TYPE_UNSUPPORTED"
  | "SUBMISSION_ASSET_CONTENT_MISMATCH"
  | "SUBMISSION_ASSET_COUNT_EXCEEDED"
  | "SUBMISSION_ASSET_TOO_LARGE"
  | "SUBMISSION_ASSET_TOTAL_TOO_LARGE"
  | "SUBMISSION_ASSET_MISSING";

export class SubmissionAssetError extends GradingSessionError {
  constructor(
    readonly code: SubmissionAssetErrorCode,
    message: string,
    readonly assetPath = "assets",
  ) {
    super(message);
    this.name = "SubmissionAssetError";
  }
}

export class GradingSessionNotFoundError extends GradingSessionError {
  constructor() {
    super("Grading session was not found");
    this.name = "GradingSessionNotFoundError";
  }
}

export class UnsupportedSubmissionTypeError extends GradingSessionError {
  public readonly code = "UNSUPPORTED_SUBMISSION_TYPE";
  constructor(extension: string) {
    super(
      `Unsupported submission type ${extension || "(none)"}; convert legacy .doc files to .docx or .pdf`,
    );
    this.name = "UnsupportedSubmissionTypeError";
  }
}

export class GradingConflictError extends GradingSessionError {
  constructor(message = "Grading session version has changed") {
    super(message);
    this.name = "GradingConflictError";
  }
}

export interface GradingSessionServiceOptions {
  now?: () => string;
  maxUploadBytes?: number;
}

export interface ConversionJob {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed";
  externalTaskId?: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversionJobRow {
  id: string;
  session_id: string;
  status: ConversionJob["status"];
  external_task_id: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

const supportedExtensions = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".md",
]);
const submissionAssetExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);
const maxSubmissionAssets = 100;
const maxSubmissionAssetBytes = 10 * 1024 * 1024;
const maxSubmissionAssetTotalBytes = 50 * 1024 * 1024;

export class GradingSessionService {
  private readonly database: Database.Database;
  private readonly filesystem: SafeFilesystem;
  private readonly now: () => string;
  private readonly maxUploadBytes: number;
  private readonly sessionMutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly rubrics: RubricService,
    options: GradingSessionServiceOptions = {},
  ) {
    this.filesystem = new SafeFilesystem(root, {
      allowedExtensions: new Set([
        ...supportedExtensions,
        ...submissionAssetExtensions,
        ".json",
        ".txt",
        ".jsonl",
      ]),
    });
    this.database = new Database(
      path.join(path.resolve(root), "grading.sqlite"),
    );
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxUploadBytes = options.maxUploadBytes ?? 10 * 1024 * 1024;
    this.migrate();
  }

  async createSession(input: {
    assignmentId: string;
    rubricVersion: number;
    studentName: string;
    studentNumber: string;
    submissionTitle?: string;
    originalPath: string;
    originalFilename: string;
    autoStartAfterConversion: boolean;
    revisionAssets?: Array<{ path: string; bytes: Uint8Array }>;
  }): Promise<GradingSession> {
    const studentName = input.studentName.trim();
    const studentNumber = input.studentNumber.trim();
    if (!studentName || !studentNumber)
      throw new GradingSessionError(
        "Both student name and number are required",
      );
    if (studentName.length > 120 || studentNumber.length > 80)
      throw new GradingSessionError("Student identity is too long");
    const submissionTitle = input.submissionTitle?.trim() || undefined;
    if (submissionTitle && submissionTitle.length > 200)
      throw new GradingSessionError("Submission title is too long");
    const filename = path.basename(input.originalFilename.trim());
    if (
      !filename ||
      filename !== input.originalFilename.trim() ||
      filename.length > 240
    )
      throw new GradingSessionError("Original filename is invalid");
    const extension = path.extname(filename).toLowerCase();
    if (!supportedExtensions.has(extension))
      throw new UnsupportedSubmissionTypeError(extension);
    if (extension !== ".md" && (input.revisionAssets?.length ?? 0) > 0)
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_MANIFEST_INVALID",
        "只有 Markdown 报告可以上传图片附件",
        "assetManifest",
      );
    const sourceStat = await stat(input.originalPath);
    if (
      !sourceStat.isFile() ||
      sourceStat.size === 0 ||
      sourceStat.size > this.maxUploadBytes
    )
      throw new GradingSessionError(
        "Submission file is empty or exceeds the upload limit",
      );
    const assignment = await this.rubrics.getAssignment(input.assignmentId);
    if (!assignment.courseId)
      throw new GradingSessionError(
        "Rubric assignment is not bound to a course",
      );
    const frozen = await this.rubrics.getVersion(
      input.assignmentId,
      input.rubricVersion,
    );
    const originalBytes = await readFile(input.originalPath);
    validateFileSignature(extension, originalBytes);
    const markdown = extension === ".md" ? originalBytes.toString("utf8") : undefined;
    const revisionAssets = extension === ".md" ? input.revisionAssets ?? [] : [];
    if (markdown !== undefined) {
      validateSubmissionAssets(revisionAssets);
      validateMarkdown(
        markdown,
        revisionAssets.map(({ path: assetPath }) => assetPath),
      );
    }
    const originalHash = sha256(originalBytes);
    const id = randomUUID();
    const batchId = randomUUID();
    const studentKey = randomUUID();
    const base = this.submissionBase(input.assignmentId, batchId, studentKey);
    const storedOriginal = `original/submission${extension}`;
    await this.filesystem.copyInto(
      input.originalPath,
      `${base}/${storedOriginal}`,
    );
    const now = this.now();
    let conversionStatus: ConversionStatus = "queued";
    let gradingStatus: GradingStatus = "not_started";
    let submissionVersion: number | undefined;
    let submissionHash: string | undefined;
    let storedAssets: string[] = [];
    if (extension === ".md") {
      storedAssets = revisionAssets.map(({ path: assetPath }) => assetPath);
      submissionVersion = 1;
      await this.filesystem.writeText(
        `${base}/converted/submission-v1.md`,
        markdown!,
      );
      const assetHashes: string[] = [];
      for (const asset of revisionAssets) {
        await this.filesystem.writeBytes(
          `${base}/converted/${asset.path}`,
          asset.bytes,
        );
        assetHashes.push(`${asset.path}:${sha256(Buffer.from(asset.bytes))}`);
      }
      submissionHash = hashSubmission(originalHash, markdown!, assetHashes);
      conversionStatus = "ready";
      if (input.autoStartAfterConversion) gradingStatus = "queued";
    }
    const title = `${studentName} · ${studentNumber}`;
    const session: GradingSession = {
      id,
      courseId: assignment.courseId,
      assignmentId: input.assignmentId,
      rubricVersion: frozen.version,
      rubricHash: frozen.hash,
      batchId,
      studentKey,
      studentName,
      studentNumber,
      title,
      ...(submissionTitle ? { submissionTitle } : {}),
      submissionTitleStatus: submissionTitle ? "provided" : "pending",
      autoStartAfterConversion: input.autoStartAfterConversion,
      conversionStatus,
      conversionAttemptCount: 0,
      gradingStatus,
      ...(submissionVersion === undefined ? {} : { submissionVersion }),
      ...(submissionHash === undefined ? {} : { submissionHash }),
      createdAt: now,
      updatedAt: now,
    };
    await this.filesystem.writeText(
      `${base}/metadata.json`,
      JSON.stringify(
        {
          sessionId: id,
          assignmentId: input.assignmentId,
          batchId,
          studentKey,
          originalFilename: filename,
          storedOriginal,
          originalHash,
          size: sourceStat.size,
          assets: storedAssets,
          createdAt: now,
        },
        null,
        2,
      ),
    );
    this.insertSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<GradingSession> {
    const row = this.database
      .prepare(
        "SELECT * FROM grading_sessions WHERE id = ? AND deletion_pending = 0",
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new GradingSessionNotFoundError();
    return fromRow(row);
  }

  async listSessions(
    filter: {
      assignmentId?: string;
      rubricVersion?: number;
      studentNumber?: string;
    } = {},
  ): Promise<GradingSession[]> {
    const clauses: string[] = ["deletion_pending = 0"];
    const values: Array<string | number> = [];
    if (filter.assignmentId) {
      clauses.push("assignment_id = ?");
      values.push(filter.assignmentId);
    }
    if (filter.rubricVersion !== undefined) {
      clauses.push("rubric_version = ?");
      values.push(filter.rubricVersion);
    }
    if (filter.studentNumber) {
      clauses.push("student_number = ?");
      values.push(filter.studentNumber);
    }
    const where = ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .prepare(
        `SELECT * FROM grading_sessions${where} ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...values) as SessionRow[];
    return rows.map(fromRow);
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<GradingSession> {
    await this.getSession(sessionId);
    const normalized = title.trim();
    if (!normalized || normalized.length > 80)
      throw new GradingSessionError(
        "Session title must contain 1 to 80 characters",
      );
    this.database
      .prepare(
        "UPDATE grading_sessions SET title = ?, updated_at = ? WHERE id = ?",
      )
      .run(normalized, this.now(), sessionId);
    return this.getSession(sessionId);
  }

  async getOriginalFilename(sessionId: string): Promise<string> {
    return (await this.readOriginal(sessionId)).filename;
  }

  async resolveSubmissionTitle(
    sessionId: string,
    title: string,
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    const normalized = title.trim();
    if (!normalized || normalized.length > 200)
      throw new GradingSessionError(
        "Submission title must contain 1 to 200 characters",
      );
    if (
      session.submissionTitleStatus !== "pending" &&
      session.submissionTitleStatus !== "resolving" &&
      session.submissionTitleStatus !== "failed"
    )
      throw new GradingConflictError("Submission title has already been set");
    const result = this.database
      .prepare(
        `UPDATE grading_sessions SET submission_title = ?, submission_title_status = 'resolved',
         submission_title_error_code = NULL, submission_title_error_message = NULL,
         submission_title_last_failed_at = NULL, updated_at = ?
         WHERE id = ? AND deletion_pending = 0 AND submission_title_status IN ('pending', 'resolving', 'failed')`,
      )
      .run(normalized, this.now(), sessionId);
    if (result.changes !== 1)
      throw new GradingConflictError("Submission title changed concurrently");
    return this.getSession(sessionId);
  }

  async beginSubmissionTitleResolution(
    sessionId: string,
  ): Promise<GradingSession> {
    const result = this.database
      .prepare(
        `UPDATE grading_sessions SET submission_title_status = 'resolving',
         submission_title_error_code = NULL, submission_title_error_message = NULL,
         submission_title_last_failed_at = NULL, updated_at = ?
         WHERE id = ? AND deletion_pending = 0 AND submission_title_status IN ('pending', 'failed')`,
      )
      .run(this.now(), sessionId);
    if (result.changes !== 1)
      throw new GradingConflictError(
        "Submission title resolution cannot start in the current state",
      );
    return this.getSession(sessionId);
  }

  async markSubmissionTitleFailed(
    sessionId: string,
    failure: {
      code: SubmissionTitleErrorCode;
      message: string;
    } = {
      code: "LEGACY_SUBMISSION_TITLE_FAILURE",
      message: "作业名称识别失败，请重试",
    },
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (
      session.submissionTitleStatus === "provided" ||
      session.submissionTitleStatus === "resolved"
    )
      return session;
    this.database
      .prepare(
        `UPDATE grading_sessions SET submission_title_status = 'failed',
         submission_title_error_code = ?, submission_title_error_message = ?,
         submission_title_last_failed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(failure.code, failure.message, this.now(), this.now(), sessionId);
    return this.getSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.withSessionMutation(sessionId, () =>
      this.deleteSessionUnlocked(sessionId),
    );
  }

  private async deleteSessionUnlocked(sessionId: string): Promise<void> {
    let session: GradingSession;
    try { session = this.getSessionIncludingDeletion(sessionId); }
    catch (error: unknown) {
      // Replacement cleanup is journaled separately from this service's file
      // deletion. If the prior attempt fully removed the row but the caller
      // crashed before clearing its journal, retrying deletion is complete.
      if (error instanceof GradingSessionNotFoundError) return;
      throw error;
    }
    const claimDeletion = this.database.transaction(() => {
      const hasBatchJobs = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grading_batch_jobs'").get();
      if (hasBatchJobs && this.database.prepare("SELECT 1 FROM grading_batch_jobs WHERE session_id = ? LIMIT 1").get(sessionId))
        throw new GradingConflictError("A grading session reserved by a batch cannot be deleted");
      return this.database.prepare(
        `UPDATE grading_sessions SET deletion_pending = 1, updated_at = ?
         WHERE id = ?
           AND (
             deletion_pending = 1
             OR (
               active_run_id IS NULL
               AND grading_status NOT IN ('running', 'queued')
               AND conversion_status NOT IN ('queued', 'running', 'waiting_for_converter')
               AND (
                 submission_title_status NOT IN ('pending', 'resolving')
                 OR (submission_title_status = 'pending' AND conversion_status IN ('conversion_failed', 'result_rejected'))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM agent_runs
                 WHERE session_id = grading_sessions.id
                   AND status IN ('queued', 'running')
               )
             )
           )`,
      ).run(this.now(), sessionId);
    });
    const claimed = claimDeletion.immediate();
    if (claimed.changes !== 1)
      throw new GradingConflictError(
        "An active grading session cannot be deleted",
      );
    const submissionDirectory = `assignments/${session.assignmentId}/submissions/${session.batchId}`;
    const resultDirectory = `assignments/${session.assignmentId}/results/${session.batchId}`;
    for (const directory of [submissionDirectory, resultDirectory]) {
      try {
        await this.filesystem.removeDirectory(directory);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const deleted = this.database
      .prepare(
        "DELETE FROM grading_sessions WHERE id = ? AND deletion_pending = 1",
      )
      .run(sessionId);
    if (deleted.changes !== 1)
      throw new GradingConflictError("The grading session could not be deleted safely");
  }

  async listPendingConversions(): Promise<GradingSession[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM grading_sessions WHERE conversion_status IN ('queued', 'running', 'waiting_for_converter') ORDER BY created_at, rowid",
      )
      .all() as SessionRow[];
    return rows.map(fromRow);
  }

  async readOriginal(
    sessionId: string,
  ): Promise<{ filename: string; bytes: Uint8Array }> {
    const session = await this.getSession(sessionId);
    const base = this.submissionBase(
      session.assignmentId,
      session.batchId,
      session.studentKey,
    );
    const metadata = JSON.parse(
      await this.filesystem.readText(`${base}/metadata.json`),
    ) as { originalFilename: string; storedOriginal: string };
    return {
      filename: metadata.originalFilename,
      bytes: new Uint8Array(
        await this.filesystem.readBytes(`${base}/${metadata.storedOriginal}`),
      ),
    };
  }

  async getConversionJob(
    sessionId: string,
  ): Promise<ConversionJob | undefined> {
    await this.getSession(sessionId);
    const row = this.database
      .prepare(
        "SELECT * FROM grading_jobs WHERE session_id = ? AND kind = 'conversion'",
      )
      .get(sessionId) as ConversionJobRow | undefined;
    return row ? conversionJobFromRow(row) : undefined;
  }

  async recordConversionTask(
    sessionId: string,
    externalTaskId: string,
  ): Promise<ConversionJob> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus === "ready")
      throw new GradingConflictError(
        "Submission conversion is already complete",
      );
    const now = this.now();
    const existing = await this.getConversionJob(sessionId);
    if (existing) {
      this.database
        .prepare(
          "UPDATE grading_jobs SET status = 'running', external_task_id = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
        )
        .run(externalTaskId, now, existing.id);
    } else {
      this.database
        .prepare(
          "INSERT INTO grading_jobs (id, session_id, kind, status, external_task_id, attempt_count, created_at, updated_at) VALUES (?, ?, 'conversion', 'running', ?, 1, ?, ?)",
        )
        .run(randomUUID(), sessionId, externalTaskId, now, now);
    }
    this.database
      .prepare(
        "UPDATE grading_sessions SET conversion_status = 'running', updated_at = ? WHERE id = ?",
      )
      .run(now, sessionId);
    return (await this.getConversionJob(sessionId))!;
  }

  async beginConversionAttempt(sessionId: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus === "ready")
      throw new GradingConflictError(
        "Submission conversion is already complete",
      );
    const now = this.now();
    this.database
      .prepare(
        `UPDATE grading_sessions SET
      conversion_status = 'running', conversion_attempt_count = conversion_attempt_count + 1,
      conversion_error_code = NULL, conversion_error_message = NULL, conversion_retryable = 0,
      conversion_last_failed_at = NULL, conversion_next_retry_at = NULL, updated_at = ?
      WHERE id = ?`,
      )
      .run(now, sessionId);
    return this.getSession(sessionId);
  }

  async markConversionJob(
    sessionId: string,
    status: ConversionJob["status"],
  ): Promise<ConversionJob> {
    const existing = await this.getConversionJob(sessionId);
    if (!existing)
      throw new GradingSessionError("Conversion job was not found");
    this.database
      .prepare(
        "UPDATE grading_jobs SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, this.now(), existing.id);
    return (await this.getConversionJob(sessionId))!;
  }

  async completeConversion(
    sessionId: string,
    imported: {
      markdown: string;
      assets: Array<{ path: string; bytes: Uint8Array }>;
    },
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus === "ready") return session;
    validateSubmissionAssets(imported.assets);
    const allowedAssets = imported.assets.map(
      ({ path: assetPath }) => assetPath,
    );
    validateMarkdown(imported.markdown, allowedAssets);
    const base = this.submissionBase(
      session.assignmentId,
      session.batchId,
      session.studentKey,
    );
    const metadataPath = `${base}/metadata.json`;
    const metadata = JSON.parse(
      await this.filesystem.readText(metadataPath),
    ) as { originalHash: string; [key: string]: unknown };
    const assetHashes: string[] = [];
    for (const asset of imported.assets) {
      await this.filesystem.writeBytes(
        `${base}/converted/${asset.path}`,
        asset.bytes,
      );
      assetHashes.push(`${asset.path}:${sha256(Buffer.from(asset.bytes))}`);
    }
    const submissionVersion = 1;
    await this.filesystem.writeText(
      `${base}/converted/submission-v1.md`,
      imported.markdown,
    );
    const submissionHash = hashSubmission(
      metadata.originalHash,
      imported.markdown,
      assetHashes,
    );
    await this.filesystem.writeText(
      metadataPath,
      JSON.stringify(
        {
          ...metadata,
          assets: imported.assets.map(({ path: assetPath }) => assetPath),
          submissionVersion,
          submissionHash,
        },
        null,
        2,
      ),
    );
    const gradingStatus: GradingStatus = session.autoStartAfterConversion
      ? "queued"
      : "not_started";
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE grading_sessions SET
        conversion_status = 'ready', grading_status = ?, submission_version = ?, submission_hash = ?,
        conversion_error_code = NULL, conversion_error_message = NULL, conversion_retryable = 0,
        conversion_last_failed_at = NULL, conversion_next_retry_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(gradingStatus, submissionVersion, submissionHash, now, sessionId);
      this.database
        .prepare(
          "UPDATE grading_jobs SET status = 'completed', updated_at = ? WHERE session_id = ? AND kind = 'conversion'",
        )
        .run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async recordConversionFailure(
    sessionId: string,
    failure: {
      status: ConversionFailureStatus;
      code: ConversionErrorCode;
      message: string;
      retryable: boolean;
      nextRetryAt?: string;
    },
  ): Promise<GradingSession> {
    await this.getSession(sessionId);
    const message = failure.message.trim();
    if (!message || message.length > 300)
      throw new GradingSessionError(
        "Conversion error message must contain 1 to 300 characters",
      );
    if ((failure.status === "waiting_for_converter" && !failure.retryable)
      || (failure.status === "result_rejected" && failure.retryable))
      throw new GradingSessionError(
        "Only converter availability failures can be retried",
      );
    if (failure.nextRetryAt && failure.status !== "waiting_for_converter")
      throw new GradingSessionError(
        "Only retryable conversion failures can have a next retry time",
      );
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE grading_sessions SET
        conversion_status = ?, conversion_error_code = ?, conversion_error_message = ?, conversion_retryable = ?,
        conversion_last_failed_at = ?, conversion_next_retry_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          failure.status,
          failure.code,
          message,
          failure.retryable ? 1 : 0,
          now,
          failure.nextRetryAt ?? null,
          now,
          sessionId,
        );
      this.database
        .prepare(
          "UPDATE grading_jobs SET status = 'failed', updated_at = ? WHERE session_id = ? AND kind = 'conversion'",
        )
        .run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async retryConversion(sessionId: string): Promise<GradingSession> {
    return this.withSessionMutation(sessionId, () => this.retryConversionUnlocked(sessionId));
  }

  private async retryConversionUnlocked(sessionId: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (
      !["waiting_for_converter", "conversion_failed"].includes(session.conversionStatus) ||
      !session.conversionError?.retryable
    )
      throw new GradingConflictError(
        "This conversion failure cannot be retried",
      );
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE grading_sessions SET
        conversion_status = 'queued', conversion_attempt_count = 0, conversion_error_code = NULL,
        conversion_error_message = NULL, conversion_retryable = 0, conversion_last_failed_at = NULL,
        conversion_next_retry_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, sessionId);
      this.database
        .prepare(
          "UPDATE grading_jobs SET status = 'queued', external_task_id = NULL, attempt_count = 0, updated_at = ? WHERE session_id = ? AND kind = 'conversion'",
        )
        .run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async readSubmission(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session.submissionVersion)
      throw new GradingSessionError("Submission conversion is not ready");
    return this.filesystem.readText(
      `${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/submission-v${session.submissionVersion}.md`,
    );
  }

  async readSubmissionAsset(
    sessionId: string,
    assetPath: string,
  ): Promise<Uint8Array> {
    const session = await this.getSession(sessionId);
    validateSubmissionAssetPath(assetPath);
    return new Uint8Array(
      await this.filesystem.readBytes(
        `${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/${assetPath}`,
      ),
    );
  }

  async getLockedSubmission(sessionId: string): Promise<LockedSubmission> {
    const session = await this.getSession(sessionId);
    if (
      !session.submissionVersion ||
      !session.submissionHash ||
      session.conversionStatus !== "ready"
    )
      throw new GradingSessionError("Submission conversion is not ready");
    const markdown = await this.readSubmission(sessionId);
    const base = this.submissionBase(
      session.assignmentId,
      session.batchId,
      session.studentKey,
    );
    const metadata = JSON.parse(
      await this.filesystem.readText(`${base}/metadata.json`),
    ) as { assets?: string[] };
    return {
      path: `submission-v${session.submissionVersion}.md`,
      lineCount: markdown.split(/\r?\n/).length,
      hash: session.submissionHash,
      lines: markdown.split(/\r?\n/),
      assetPaths: metadata.assets ?? [],
    };
  }

  async setGradingStatus(
    sessionId: string,
    status: GradingStatus,
    activeRunId?: string,
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    const allowed: Record<GradingStatus, GradingStatus[]> = {
      not_started: ["not_started", "queued"],
      queued: [
        "queued",
        "running",
        "waiting_for_teacher",
        "draft_ready",
        "needs_review",
        "failed",
        "cancelled",
      ],
      running: [
        "running",
        "waiting_for_teacher",
        "draft_ready",
        "needs_review",
        "failed",
        "cancelled",
      ],
      waiting_for_teacher: [
        "waiting_for_teacher",
        "draft_ready",
        "needs_review",
        "failed",
        "cancelled",
      ],
      draft_ready: [
        "draft_ready",
        "needs_review",
        "waiting_for_teacher",
        "confirmed",
      ],
      needs_review: [
        "needs_review",
        "draft_ready",
        "waiting_for_teacher",
        "confirmed",
      ],
      confirmed: ["confirmed"],
      failed: ["failed", "queued"],
      cancelled: ["cancelled", "queued"],
    };
    if (!allowed[session.gradingStatus].includes(status))
      throw new GradingConflictError(
        `Invalid grading status transition from ${session.gradingStatus} to ${status}`,
      );
    const updated = this.database
      .prepare(
        "UPDATE grading_sessions SET grading_status = ?, active_run_id = ?, updated_at = ? WHERE id = ? AND grading_status = ?",
      )
      .run(
        status,
        activeRunId ?? null,
        this.now(),
        sessionId,
        session.gradingStatus,
      );
    if (updated.changes !== 1)
      throw new GradingConflictError("Grading status changed concurrently");
    return this.getSession(sessionId);
  }

  async setActiveRun(
    sessionId: string,
    activeRunId?: string,
  ): Promise<GradingSession> {
    await this.getSession(sessionId);
    this.database
      .prepare(
        "UPDATE grading_sessions SET active_run_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(activeRunId ?? null, this.now(), sessionId);
    return this.getSession(sessionId);
  }

  async clearActiveRun(
    sessionId: string,
    runId: string,
  ): Promise<GradingSession> {
    await this.getSession(sessionId);
    this.database
      .prepare(
        "UPDATE grading_sessions SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?",
      )
      .run(this.now(), sessionId, runId);
    return this.getSession(sessionId);
  }

  async saveSubmission(
    sessionId: string,
    expectedVersion: number,
    markdown: string,
  ): Promise<GradingSession> {
    return this.withSessionMutation(sessionId, () =>
      this.saveSubmissionUnlocked(sessionId, expectedVersion, markdown),
    );
  }

  private async saveSubmissionUnlocked(
    sessionId: string,
    expectedVersion: number,
    markdown: string,
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.gradingStatus !== "not_started")
      throw new GradingConflictError(
        "The submission is locked after grading starts",
      );
    if (
      session.conversionStatus !== "ready" ||
      session.submissionVersion === undefined
    )
      throw new GradingSessionError("Submission conversion is not ready");
    if (session.submissionVersion !== expectedVersion)
      throw new GradingConflictError();
    const metadataForValidation = JSON.parse(
      await this.filesystem.readText(
        `${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/metadata.json`,
      ),
    ) as { assets?: string[] };
    validateMarkdown(markdown, metadataForValidation.assets ?? []);
    const nextVersion = expectedVersion + 1;
    const metadata = JSON.parse(
      await this.filesystem.readText(
        `${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/metadata.json`,
      ),
    ) as { originalHash: string; assets?: string[] };
    const assetHashes: string[] = [];
    for (const assetPath of metadata.assets ?? [])
      assetHashes.push(
        `${assetPath}:${sha256(Buffer.from(await this.readSubmissionAsset(sessionId, assetPath)))}`,
      );
    const submissionHash = hashSubmission(
      metadata.originalHash,
      markdown,
      assetHashes,
    );
    await this.filesystem.writeText(
      `${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/submission-v${nextVersion}.md`,
      markdown,
    );
    const updatedAt = this.now();
    const update = this.database.prepare(
      "UPDATE grading_sessions SET submission_version = ?, submission_hash = ?, updated_at = ? WHERE id = ? AND submission_version = ? AND grading_status = 'not_started'",
    );
    const result = update.run(
      nextVersion,
      submissionHash,
      updatedAt,
      sessionId,
      expectedVersion,
    );
    if (result.changes !== 1) throw new GradingConflictError();
    return this.getSession(sessionId);
  }

  async lockSubmissionForGrading(
    sessionId: string,
    options: { allowBatchReservation?: boolean; resumeWaitingForTeacher?: boolean } = {},
  ): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (
      session.conversionStatus !== "ready" ||
      session.submissionVersion === undefined
    )
      throw new GradingSessionError("Submission conversion is not ready");
    if (session.gradingStatus === "queued") return session;
    const allowedStatuses = [
      "not_started",
      "failed",
      "cancelled",
      ...(options.resumeWaitingForTeacher ? ["waiting_for_teacher"] : []),
      ...(options.allowBatchReservation ? ["draft_ready", "needs_review"] : []),
    ];
    if (!allowedStatuses.includes(session.gradingStatus))
      throw new GradingConflictError(
        "The submission cannot be queued in its current state",
      );
    const reserve = this.database.transaction(() => {
      if (!options.allowBatchReservation) {
        const hasBatchJobs = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grading_batch_jobs'").get();
        if (hasBatchJobs && this.database.prepare("SELECT 1 FROM grading_batch_jobs WHERE session_id = ? LIMIT 1").get(sessionId))
          throw new GradingConflictError("This grading session is reserved by a batch");
      }
      return this.database.prepare(
        "UPDATE grading_sessions SET grading_status = 'queued', active_run_id = NULL, updated_at = ? WHERE id = ? AND grading_status = ?",
      ).run(this.now(), sessionId, session.gradingStatus);
    });
    const result = reserve.immediate();
    if (result.changes !== 1) throw new GradingConflictError();
    return this.getSession(sessionId);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS grading_sessions (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        rubric_version INTEGER NOT NULL,
        rubric_hash TEXT NOT NULL,
        batch_id TEXT NOT NULL UNIQUE,
        student_key TEXT NOT NULL UNIQUE,
        student_name TEXT NOT NULL,
        student_number TEXT NOT NULL,
        title TEXT NOT NULL,
        submission_title TEXT,
        submission_title_status TEXT NOT NULL DEFAULT 'pending',
        submission_title_error_code TEXT,
        submission_title_error_message TEXT,
        submission_title_last_failed_at TEXT,
        auto_start INTEGER NOT NULL CHECK (auto_start IN (0, 1)),
        conversion_status TEXT NOT NULL,
        conversion_attempt_count INTEGER NOT NULL DEFAULT 0,
        conversion_error_code TEXT,
        conversion_error_message TEXT,
        conversion_retryable INTEGER NOT NULL DEFAULT 0,
        conversion_last_failed_at TEXT,
        conversion_next_retry_at TEXT,
        grading_status TEXT NOT NULL,
        active_run_id TEXT,
        deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1)),
        submission_version INTEGER,
        submission_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grading_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        external_task_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, kind)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        input_message TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_events (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
    `);
    const columns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(grading_sessions)")
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    if (!columns.has("submission_title"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN submission_title TEXT",
      );
    if (!columns.has("submission_title_status"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN submission_title_status TEXT NOT NULL DEFAULT 'pending'",
      );
    if (!columns.has("submission_title_error_code"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN submission_title_error_code TEXT",
      );
    if (!columns.has("submission_title_error_message"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN submission_title_error_message TEXT",
      );
    if (!columns.has("submission_title_last_failed_at"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN submission_title_last_failed_at TEXT",
      );
    if (!columns.has("conversion_attempt_count"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_attempt_count INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.has("conversion_error_code"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_error_code TEXT",
      );
    if (!columns.has("conversion_error_message"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_error_message TEXT",
      );
    if (!columns.has("conversion_retryable"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_retryable INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.has("conversion_last_failed_at"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_last_failed_at TEXT",
      );
    if (!columns.has("conversion_next_retry_at"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN conversion_next_retry_at TEXT",
      );
    if (!columns.has("deletion_pending"))
      this.database.exec(
        "ALTER TABLE grading_sessions ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1))",
      );
    this.database.exec(
      `UPDATE grading_sessions SET submission_title_status = 'failed',
       submission_title_error_code = COALESCE(submission_title_error_code, 'LEGACY_SUBMISSION_TITLE_FAILURE'),
       submission_title_error_message = COALESCE(submission_title_error_message, '作业名称识别被应用重启中断，请重试'),
       submission_title_last_failed_at = COALESCE(submission_title_last_failed_at, updated_at)
       WHERE submission_title_status = 'resolving'`,
    );
    this.database.exec(
      `UPDATE grading_sessions SET
       submission_title_error_code = COALESCE(submission_title_error_code, 'LEGACY_SUBMISSION_TITLE_FAILURE'),
       submission_title_error_message = COALESCE(submission_title_error_message, '作业名称识别失败，请重试'),
       submission_title_last_failed_at = COALESCE(submission_title_last_failed_at, updated_at)
       WHERE submission_title_status = 'failed'`,
    );
    this.database.exec(`UPDATE grading_sessions SET
      conversion_status = CASE
        WHEN EXISTS (SELECT 1 FROM grading_jobs WHERE grading_jobs.session_id = grading_sessions.id AND kind = 'conversion' AND external_task_id IS NOT NULL) THEN 'conversion_failed'
        ELSE 'waiting_for_converter'
      END,
      conversion_error_code = 'LEGACY_CONVERSION_FAILURE',
      conversion_error_message = '转换失败，旧记录未保存具体原因。',
      conversion_retryable = CASE
        WHEN EXISTS (SELECT 1 FROM grading_jobs WHERE grading_jobs.session_id = grading_sessions.id AND kind = 'conversion' AND external_task_id IS NOT NULL) THEN 0
        ELSE 1
      END,
      conversion_last_failed_at = updated_at
      WHERE conversion_status = 'failed'`);
    this.database.pragma("user_version = 5");
  }

  private insertSession(session: GradingSession): void {
    this.database
      .prepare(
        `INSERT INTO grading_sessions (
      id, course_id, assignment_id, rubric_version, rubric_hash, batch_id, student_key, student_name, student_number, title,
      submission_title, submission_title_status, submission_title_error_code, submission_title_error_message,
      submission_title_last_failed_at, auto_start, conversion_status, conversion_attempt_count,
      conversion_error_code, conversion_error_message, conversion_retryable, conversion_last_failed_at, conversion_next_retry_at,
      grading_status, active_run_id, deletion_pending, submission_version, submission_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.courseId,
        session.assignmentId,
        session.rubricVersion,
        session.rubricHash,
        session.batchId,
        session.studentKey,
        session.studentName,
        session.studentNumber,
        session.title,
        session.submissionTitle ?? null,
        session.submissionTitleStatus,
        null,
        null,
        null,
        session.autoStartAfterConversion ? 1 : 0,
        session.conversionStatus,
        session.conversionAttemptCount,
        null,
        null,
        0,
        null,
        null,
        session.gradingStatus,
        session.activeRunId ?? null,
        0,
        session.submissionVersion ?? null,
        session.submissionHash ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  private getSessionIncludingDeletion(sessionId: string): GradingSession {
    const row = this.database
      .prepare("SELECT * FROM grading_sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new GradingSessionNotFoundError();
    return fromRow(row);
  }

  private async withSessionMutation<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionMutationTails.get(sessionId) ??
      Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionMutationTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionMutationTails.get(sessionId) === tail)
        this.sessionMutationTails.delete(sessionId);
    }
  }

  private submissionBase(
    assignmentId: string,
    batchId: string,
    studentKey: string,
  ): string {
    return `assignments/${assignmentId}/submissions/${batchId}/${studentKey}`;
  }
}

function fromRow(row: SessionRow): GradingSession {
  return {
    id: row.id,
    courseId: row.course_id,
    assignmentId: row.assignment_id,
    rubricVersion: row.rubric_version,
    rubricHash: row.rubric_hash,
    batchId: row.batch_id,
    studentKey: row.student_key,
    studentName: row.student_name,
    studentNumber: row.student_number,
    title: row.title,
    ...(row.submission_title === null
      ? {}
      : { submissionTitle: row.submission_title }),
    submissionTitleStatus: row.submission_title_status,
    ...(row.submission_title_error_code === null ||
    row.submission_title_error_message === null ||
    row.submission_title_last_failed_at === null
      ? {}
      : {
          submissionTitleError: {
            code: row.submission_title_error_code,
            message: row.submission_title_error_message,
            lastFailedAt: row.submission_title_last_failed_at,
          },
        }),
    autoStartAfterConversion: row.auto_start === 1,
    conversionStatus: row.conversion_status,
    conversionAttemptCount: row.conversion_attempt_count,
    ...(row.conversion_error_code === null ||
    row.conversion_error_message === null ||
    row.conversion_last_failed_at === null
      ? {}
      : {
          conversionError: {
            code: row.conversion_error_code,
            message: row.conversion_error_message,
            retryable: row.conversion_retryable === 1,
            lastFailedAt: row.conversion_last_failed_at,
            ...(row.conversion_next_retry_at === null
              ? {}
              : { nextRetryAt: row.conversion_next_retry_at }),
          },
        }),
    gradingStatus: row.grading_status,
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
    ...(row.submission_version === null
      ? {}
      : { submissionVersion: row.submission_version }),
    ...(row.submission_hash === null
      ? {}
      : { submissionHash: row.submission_hash }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversionJobFromRow(row: ConversionJobRow): ConversionJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    ...(row.external_task_id === null
      ? {}
      : { externalTaskId: row.external_task_id }),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateMarkdown(
  markdown: string,
  allowedAssets: string[] = [],
): void {
  if (!markdown.trim() || Buffer.byteLength(markdown) > 10 * 1024 * 1024)
    throw new GradingSessionError("Converted Markdown is empty or too large");
  const htmlForValidation = decodeNumericHtmlEntities(markdown);
  if (
    /<\s*\/?\s*(?:svg|image|object|embed|iframe|video|audio|source|script|link|base|track|portal)\b/i
      .test(htmlForValidation)
  )
    throw new GradingSessionError(
      "Markdown contains resource-bearing raw HTML",
    );
  const unsafeLink = /!?(?:\[[^\]]*\])\((?<target>[^)]+)\)/g;
  for (const match of markdown.matchAll(unsafeLink)) {
    const target = match.groups?.target?.trim() ?? "";
    if (
      target.startsWith("/") ||
      target.startsWith("\\") ||
      /^[A-Za-z]:/.test(target) ||
      target.split(/[\\/]/).includes("..")
    ) {
      throw new GradingSessionError(
        "Markdown contains an unsafe cross-directory reference",
      );
    }
  }
  if (/!\[[^\]]*\]\[[^\]]*\]|<\s*img\b/i.test(markdown))
    throw new GradingSessionError(
      "Markdown images must use controlled inline asset references",
    );
  for (const match of markdown.matchAll(
    /!\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  )) {
    const target = match.groups?.target ?? "";
    if (!allowedAssets.includes(target))
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_MISSING",
        "Markdown 图片引用的附件不存在",
        target,
      );
  }
}

export function validateSubmissionAssets(
  assets: Array<{ path: string; bytes: Uint8Array }>,
): void {
  if (assets.length > maxSubmissionAssets)
    throw new SubmissionAssetError(
      "SUBMISSION_ASSET_COUNT_EXCEEDED",
      `附件数量不能超过 ${maxSubmissionAssets} 个`,
    );
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const asset of assets) {
    validateSubmissionAssetPath(asset.path);
    if (seen.has(asset.path))
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_DUPLICATE_PATH",
        "附件清单包含重复路径",
        asset.path,
      );
    seen.add(asset.path);
    if (asset.bytes.byteLength > maxSubmissionAssetBytes)
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_TOO_LARGE",
        "单个附件不能超过 10 MiB",
        asset.path,
      );
    totalBytes += asset.bytes.byteLength;
    if (totalBytes > maxSubmissionAssetTotalBytes)
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_TOTAL_TOO_LARGE",
        "附件总量不能超过 50 MiB",
      );
    validateSubmissionAssetSignature(asset.path, asset.bytes);
  }
}

export function referencedMarkdownAssetPaths(markdown: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(
    /!\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  )) {
    const target = match.groups?.target ?? "";
    if (target.startsWith("assets/") && !paths.includes(target)) paths.push(target);
  }
  return paths;
}

function validateSubmissionAssetPath(assetPath: string): void {
  if (
    typeof assetPath !== "string" ||
    assetPath.length > 240 ||
    assetPath.includes("\\") ||
    path.posix.isAbsolute(assetPath) ||
    path.win32.isAbsolute(assetPath)
  )
    throw new SubmissionAssetError(
      "SUBMISSION_ASSET_PATH_INVALID",
      "附件路径必须是 assets/ 下的安全相对路径",
      String(assetPath),
    );
  const segments = assetPath.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== "assets" ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":"),
    )
  )
    throw new SubmissionAssetError(
      "SUBMISSION_ASSET_PATH_INVALID",
      "附件路径必须是 assets/ 下的安全相对路径",
      assetPath,
    );
  const extension = path.posix.extname(assetPath).toLowerCase();
  if (!submissionAssetExtensions.has(extension))
    throw new SubmissionAssetError(
      "SUBMISSION_ASSET_TYPE_UNSUPPORTED",
      "附件只支持 PNG、JPEG、GIF 或 WebP 图片",
      assetPath,
    );
}

function validateSubmissionAssetSignature(
  assetPath: string,
  bytes: Uint8Array,
): void {
  const extension = path.posix.extname(assetPath).toLowerCase();
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  const valid =
    (extension === ".png" &&
      starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    ([".jpg", ".jpeg"].includes(extension) && starts(0xff, 0xd8, 0xff)) ||
    (extension === ".gif" && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) ||
    (extension === ".webp" &&
      ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP");
  if (!valid)
    throw new SubmissionAssetError(
      "SUBMISSION_ASSET_CONTENT_MISMATCH",
      "附件内容与图片扩展名不匹配",
      assetPath,
    );
}

function decodeNumericHtmlEntities(value: string): string {
  return value.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));?/gi,
    (entity, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
        return entity;
      try { return String.fromCodePoint(codePoint); }
      catch { return entity; }
    },
  );
}

function validateFileSignature(extension: string, bytes: Buffer): void {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  const zipNames =
    [".docx", ".pptx"].includes(extension) && starts(0x50, 0x4b)
      ? readZipEntryNames(bytes)
      : new Set<string>();
  const valid =
    extension === ".md" ||
    (extension === ".pdf" &&
      bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (extension === ".docx" &&
      zipNames.has("[Content_Types].xml") &&
      zipNames.has("word/document.xml")) ||
    (extension === ".pptx" &&
      zipNames.has("[Content_Types].xml") &&
      zipNames.has("ppt/presentation.xml")) ||
    (extension === ".png" &&
      starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    ([".jpg", ".jpeg"].includes(extension) && starts(0xff, 0xd8, 0xff));
  if (!valid)
    throw new GradingSessionError(
      "Submission content does not match its filename extension",
    );
}

function readZipEntryNames(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  try {
    const unzipper = new Unzip((file) => {
      names.add(file.name.replaceAll("\\", "/"));
    });
    unzipper.push(bytes, true);
  } catch {
    return new Set();
  }
  return names;
}

function hashSubmission(
  originalHash: string,
  markdown: string,
  assets: string[],
): string {
  return sha256(
    Buffer.from(
      `${originalHash}\n${sha256(Buffer.from(markdown))}\n${assets.sort().join("\n")}`,
    ),
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
