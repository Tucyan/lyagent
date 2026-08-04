import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { Unzip } from "fflate";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import type { LockedSubmission } from "../schemas/grading.js";
import type { RubricService } from "./rubric-service.js";

export type ConversionStatus = "queued" | "running" | "ready" | "failed";
export type GradingStatus = "not_started" | "queued" | "running" | "waiting_for_teacher" | "draft_ready" | "needs_review" | "confirmed" | "failed" | "cancelled";

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
  autoStartAfterConversion: boolean;
  conversionStatus: ConversionStatus;
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
  auto_start: number;
  conversion_status: ConversionStatus;
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

export class GradingSessionNotFoundError extends GradingSessionError {
  constructor() {
    super("Grading session was not found");
    this.name = "GradingSessionNotFoundError";
  }
}

export class UnsupportedSubmissionTypeError extends GradingSessionError {
  public readonly code = "UNSUPPORTED_SUBMISSION_TYPE";
  constructor(extension: string) {
    super(`Unsupported submission type ${extension || "(none)"}; convert legacy .doc files to .docx or .pdf`);
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

const supportedExtensions = new Set([".pdf", ".docx", ".pptx", ".png", ".jpg", ".jpeg", ".md"]);

export class GradingSessionService {
  private readonly database: Database.Database;
  private readonly filesystem: SafeFilesystem;
  private readonly now: () => string;
  private readonly maxUploadBytes: number;

  constructor(private readonly root: string, private readonly rubrics: RubricService, options: GradingSessionServiceOptions = {}) {
    this.filesystem = new SafeFilesystem(root, { allowedExtensions: new Set([...supportedExtensions, ".json", ".txt", ".jsonl"]) });
    this.database = new Database(path.join(path.resolve(root), "grading.sqlite"));
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
    originalPath: string;
    originalFilename: string;
    autoStartAfterConversion: boolean;
    revisionAssets?: Array<{ path: string; bytes: Uint8Array }>;
  }): Promise<GradingSession> {
    const studentName = input.studentName.trim();
    const studentNumber = input.studentNumber.trim();
    if (!studentName || !studentNumber) throw new GradingSessionError("Both student name and number are required");
    if (studentName.length > 120 || studentNumber.length > 80) throw new GradingSessionError("Student identity is too long");
    const filename = path.basename(input.originalFilename.trim());
    if (!filename || filename !== input.originalFilename.trim() || filename.length > 240) throw new GradingSessionError("Original filename is invalid");
    const extension = path.extname(filename).toLowerCase();
    if (!supportedExtensions.has(extension)) throw new UnsupportedSubmissionTypeError(extension);
    const sourceStat = await stat(input.originalPath);
    if (!sourceStat.isFile() || sourceStat.size === 0 || sourceStat.size > this.maxUploadBytes) throw new GradingSessionError("Submission file is empty or exceeds the upload limit");
    const assignment = await this.rubrics.getAssignment(input.assignmentId);
    if (!assignment.courseId) throw new GradingSessionError("Rubric assignment is not bound to a course");
    const frozen = await this.rubrics.getVersion(input.assignmentId, input.rubricVersion);
    const originalBytes = await readFile(input.originalPath);
    validateFileSignature(extension, originalBytes);
    const originalHash = sha256(originalBytes);
    const id = randomUUID();
    const batchId = randomUUID();
    const studentKey = randomUUID();
    const base = this.submissionBase(input.assignmentId, batchId, studentKey);
    const storedOriginal = `original/submission${extension}`;
    await this.filesystem.copyInto(input.originalPath, `${base}/${storedOriginal}`);
    const now = this.now();
    let conversionStatus: ConversionStatus = "queued";
    let gradingStatus: GradingStatus = "not_started";
    let submissionVersion: number | undefined;
    let submissionHash: string | undefined;
    let storedAssets: string[] = [];
    if (extension === ".md") {
      const markdown = originalBytes.toString("utf8");
      const revisionAssets = input.revisionAssets ?? [];
      storedAssets = revisionAssets.map(({ path: assetPath }) => assetPath);
      for (const assetPath of storedAssets) if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(assetPath)) throw new GradingSessionError("Revision asset path is invalid");
      validateMarkdown(markdown, storedAssets);
      submissionVersion = 1;
      await this.filesystem.writeText(`${base}/converted/submission-v1.md`, markdown);
      const assetHashes: string[] = [];
      for (const asset of revisionAssets) {
        await this.filesystem.writeBytes(`${base}/converted/${asset.path}`, asset.bytes);
        assetHashes.push(`${asset.path}:${sha256(Buffer.from(asset.bytes))}`);
      }
      submissionHash = hashSubmission(originalHash, markdown, assetHashes);
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
      autoStartAfterConversion: input.autoStartAfterConversion,
      conversionStatus,
      gradingStatus,
      ...(submissionVersion === undefined ? {} : { submissionVersion }),
      ...(submissionHash === undefined ? {} : { submissionHash }),
      createdAt: now,
      updatedAt: now,
    };
    await this.filesystem.writeText(`${base}/metadata.json`, JSON.stringify({
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
    }, null, 2));
    this.insertSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<GradingSession> {
    const row = this.database.prepare("SELECT * FROM grading_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) throw new GradingSessionNotFoundError();
    return fromRow(row);
  }

  async listSessions(): Promise<GradingSession[]> {
    const rows = this.database.prepare("SELECT * FROM grading_sessions ORDER BY created_at DESC, rowid DESC").all() as SessionRow[];
    return rows.map(fromRow);
  }

  async listPendingConversions(): Promise<GradingSession[]> {
    const rows = this.database.prepare("SELECT * FROM grading_sessions WHERE conversion_status IN ('queued', 'running') ORDER BY created_at, rowid").all() as SessionRow[];
    return rows.map(fromRow);
  }

  async readOriginal(sessionId: string): Promise<{ filename: string; bytes: Uint8Array }> {
    const session = await this.getSession(sessionId);
    const base = this.submissionBase(session.assignmentId, session.batchId, session.studentKey);
    const metadata = JSON.parse(await this.filesystem.readText(`${base}/metadata.json`)) as { originalFilename: string; storedOriginal: string };
    return { filename: metadata.originalFilename, bytes: new Uint8Array(await this.filesystem.readBytes(`${base}/${metadata.storedOriginal}`)) };
  }

  async getConversionJob(sessionId: string): Promise<ConversionJob | undefined> {
    await this.getSession(sessionId);
    const row = this.database.prepare("SELECT * FROM grading_jobs WHERE session_id = ? AND kind = 'conversion'").get(sessionId) as ConversionJobRow | undefined;
    return row ? conversionJobFromRow(row) : undefined;
  }

  async recordConversionTask(sessionId: string, externalTaskId: string): Promise<ConversionJob> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus === "ready") throw new GradingConflictError("Submission conversion is already complete");
    const now = this.now();
    const existing = await this.getConversionJob(sessionId);
    if (existing) {
      this.database.prepare("UPDATE grading_jobs SET status = 'running', external_task_id = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(externalTaskId, now, existing.id);
    } else {
      this.database.prepare("INSERT INTO grading_jobs (id, session_id, kind, status, external_task_id, attempt_count, created_at, updated_at) VALUES (?, ?, 'conversion', 'running', ?, 1, ?, ?)").run(randomUUID(), sessionId, externalTaskId, now, now);
    }
    this.database.prepare("UPDATE grading_sessions SET conversion_status = 'running', updated_at = ? WHERE id = ?").run(now, sessionId);
    return (await this.getConversionJob(sessionId))!;
  }

  async markConversionJob(sessionId: string, status: ConversionJob["status"]): Promise<ConversionJob> {
    const existing = await this.getConversionJob(sessionId);
    if (!existing) throw new GradingSessionError("Conversion job was not found");
    this.database.prepare("UPDATE grading_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), existing.id);
    return (await this.getConversionJob(sessionId))!;
  }

  async completeConversion(sessionId: string, imported: { markdown: string; assets: Array<{ path: string; bytes: Uint8Array }> }): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus === "ready") return session;
    const allowedAssets = imported.assets.map(({ path: assetPath }) => assetPath);
    for (const assetPath of allowedAssets) if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(assetPath)) throw new GradingSessionError("Converted asset path is invalid");
    validateMarkdown(imported.markdown, allowedAssets);
    const base = this.submissionBase(session.assignmentId, session.batchId, session.studentKey);
    const metadataPath = `${base}/metadata.json`;
    const metadata = JSON.parse(await this.filesystem.readText(metadataPath)) as { originalHash: string; [key: string]: unknown };
    const assetHashes: string[] = [];
    for (const asset of imported.assets) {
      await this.filesystem.writeBytes(`${base}/converted/${asset.path}`, asset.bytes);
      assetHashes.push(`${asset.path}:${sha256(Buffer.from(asset.bytes))}`);
    }
    const submissionVersion = 1;
    await this.filesystem.writeText(`${base}/converted/submission-v1.md`, imported.markdown);
    const submissionHash = hashSubmission(metadata.originalHash, imported.markdown, assetHashes);
    await this.filesystem.writeText(metadataPath, JSON.stringify({ ...metadata, assets: imported.assets.map(({ path: assetPath }) => assetPath), submissionVersion, submissionHash }, null, 2));
    const gradingStatus: GradingStatus = session.autoStartAfterConversion ? "queued" : "not_started";
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database.prepare("UPDATE grading_sessions SET conversion_status = 'ready', grading_status = ?, submission_version = ?, submission_hash = ?, updated_at = ? WHERE id = ?").run(gradingStatus, submissionVersion, submissionHash, now, sessionId);
      this.database.prepare("UPDATE grading_jobs SET status = 'completed', updated_at = ? WHERE session_id = ? AND kind = 'conversion'").run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async failConversion(sessionId: string): Promise<GradingSession> {
    await this.getSession(sessionId);
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database.prepare("UPDATE grading_sessions SET conversion_status = 'failed', updated_at = ? WHERE id = ?").run(now, sessionId);
      this.database.prepare("UPDATE grading_jobs SET status = 'failed', updated_at = ? WHERE session_id = ? AND kind = 'conversion'").run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async retryConversion(sessionId: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus !== "failed") throw new GradingConflictError("Only a failed conversion can be retried");
    const now = this.now();
    const transaction = this.database.transaction(() => {
      this.database.prepare("UPDATE grading_sessions SET conversion_status = 'queued', updated_at = ? WHERE id = ?").run(now, sessionId);
      this.database.prepare("UPDATE grading_jobs SET status = 'queued', external_task_id = NULL, attempt_count = 0, updated_at = ? WHERE session_id = ? AND kind = 'conversion'").run(now, sessionId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  async readSubmission(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session.submissionVersion) throw new GradingSessionError("Submission conversion is not ready");
    return this.filesystem.readText(`${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/submission-v${session.submissionVersion}.md`);
  }

  async readSubmissionAsset(sessionId: string, assetPath: string): Promise<Uint8Array> {
    const session = await this.getSession(sessionId);
    if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(assetPath)) throw new GradingSessionError("Submission asset path is invalid");
    return new Uint8Array(await this.filesystem.readBytes(`${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/${assetPath}`));
  }

  async getLockedSubmission(sessionId: string): Promise<LockedSubmission> {
    const session = await this.getSession(sessionId);
    if (!session.submissionVersion || !session.submissionHash || session.conversionStatus !== "ready") throw new GradingSessionError("Submission conversion is not ready");
    const markdown = await this.readSubmission(sessionId);
    const base = this.submissionBase(session.assignmentId, session.batchId, session.studentKey);
    const metadata = JSON.parse(await this.filesystem.readText(`${base}/metadata.json`)) as { assets?: string[] };
    return {
      path: `submission-v${session.submissionVersion}.md`,
      lineCount: markdown.split(/\r?\n/).length,
      hash: session.submissionHash,
      lines: markdown.split(/\r?\n/),
      assetPaths: metadata.assets ?? [],
    };
  }

  async setGradingStatus(sessionId: string, status: GradingStatus, activeRunId?: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    const allowed: Record<GradingStatus, GradingStatus[]> = {
      not_started: ["not_started", "queued"],
      queued: ["queued", "running", "waiting_for_teacher", "draft_ready", "needs_review", "failed", "cancelled"],
      running: ["running", "waiting_for_teacher", "draft_ready", "needs_review", "failed", "cancelled"],
      waiting_for_teacher: ["waiting_for_teacher", "draft_ready", "needs_review", "failed", "cancelled"],
      draft_ready: ["draft_ready", "needs_review", "waiting_for_teacher", "confirmed"],
      needs_review: ["needs_review", "draft_ready", "waiting_for_teacher", "confirmed"],
      confirmed: ["confirmed"],
      failed: ["failed", "queued"],
      cancelled: ["cancelled", "queued"],
    };
    if (!allowed[session.gradingStatus].includes(status)) throw new GradingConflictError(`Invalid grading status transition from ${session.gradingStatus} to ${status}`);
    const updated = this.database.prepare("UPDATE grading_sessions SET grading_status = ?, active_run_id = ?, updated_at = ? WHERE id = ? AND grading_status = ?").run(status, activeRunId ?? null, this.now(), sessionId, session.gradingStatus);
    if (updated.changes !== 1) throw new GradingConflictError("Grading status changed concurrently");
    return this.getSession(sessionId);
  }

  async setActiveRun(sessionId: string, activeRunId?: string): Promise<GradingSession> {
    await this.getSession(sessionId);
    this.database.prepare("UPDATE grading_sessions SET active_run_id = ?, updated_at = ? WHERE id = ?").run(activeRunId ?? null, this.now(), sessionId);
    return this.getSession(sessionId);
  }

  async clearActiveRun(sessionId: string, runId: string): Promise<GradingSession> {
    await this.getSession(sessionId);
    this.database.prepare("UPDATE grading_sessions SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?").run(this.now(), sessionId, runId);
    return this.getSession(sessionId);
  }

  async saveSubmission(sessionId: string, expectedVersion: number, markdown: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.gradingStatus !== "not_started") throw new GradingConflictError("The submission is locked after grading starts");
    if (session.conversionStatus !== "ready" || session.submissionVersion === undefined) throw new GradingSessionError("Submission conversion is not ready");
    if (session.submissionVersion !== expectedVersion) throw new GradingConflictError();
    const metadataForValidation = JSON.parse(await this.filesystem.readText(`${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/metadata.json`)) as { assets?: string[] };
    validateMarkdown(markdown, metadataForValidation.assets ?? []);
    const nextVersion = expectedVersion + 1;
    const metadata = JSON.parse(await this.filesystem.readText(`${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/metadata.json`)) as { originalHash: string; assets?: string[] };
    const assetHashes: string[] = [];
    for (const assetPath of metadata.assets ?? []) assetHashes.push(`${assetPath}:${sha256(Buffer.from(await this.readSubmissionAsset(sessionId, assetPath)))}`);
    const submissionHash = hashSubmission(metadata.originalHash, markdown, assetHashes);
    await this.filesystem.writeText(`${this.submissionBase(session.assignmentId, session.batchId, session.studentKey)}/converted/submission-v${nextVersion}.md`, markdown);
    const updatedAt = this.now();
    const update = this.database.prepare("UPDATE grading_sessions SET submission_version = ?, submission_hash = ?, updated_at = ? WHERE id = ? AND submission_version = ? AND grading_status = 'not_started'");
    const result = update.run(nextVersion, submissionHash, updatedAt, sessionId, expectedVersion);
    if (result.changes !== 1) throw new GradingConflictError();
    return this.getSession(sessionId);
  }

  async lockSubmissionForGrading(sessionId: string): Promise<GradingSession> {
    const session = await this.getSession(sessionId);
    if (session.conversionStatus !== "ready" || session.submissionVersion === undefined) throw new GradingSessionError("Submission conversion is not ready");
    if (session.gradingStatus === "queued") return session;
    if (!["not_started", "failed", "cancelled"].includes(session.gradingStatus)) throw new GradingConflictError("The submission cannot be queued in its current state");
    const result = this.database.prepare("UPDATE grading_sessions SET grading_status = 'queued', active_run_id = NULL, updated_at = ? WHERE id = ? AND grading_status = ?").run(this.now(), sessionId, session.gradingStatus);
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
        auto_start INTEGER NOT NULL CHECK (auto_start IN (0, 1)),
        conversion_status TEXT NOT NULL,
        grading_status TEXT NOT NULL,
        active_run_id TEXT,
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
  }

  private insertSession(session: GradingSession): void {
    this.database.prepare(`INSERT INTO grading_sessions (
      id, course_id, assignment_id, rubric_version, rubric_hash, batch_id, student_key, student_name, student_number, title,
      auto_start, conversion_status, grading_status, active_run_id, submission_version, submission_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.id, session.courseId, session.assignmentId, session.rubricVersion, session.rubricHash, session.batchId, session.studentKey,
      session.studentName, session.studentNumber, session.title, session.autoStartAfterConversion ? 1 : 0,
      session.conversionStatus, session.gradingStatus, session.activeRunId ?? null, session.submissionVersion ?? null,
      session.submissionHash ?? null, session.createdAt, session.updatedAt,
    );
  }

  private submissionBase(assignmentId: string, batchId: string, studentKey: string): string {
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
    autoStartAfterConversion: row.auto_start === 1,
    conversionStatus: row.conversion_status,
    gradingStatus: row.grading_status,
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
    ...(row.submission_version === null ? {} : { submissionVersion: row.submission_version }),
    ...(row.submission_hash === null ? {} : { submissionHash: row.submission_hash }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversionJobFromRow(row: ConversionJobRow): ConversionJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    ...(row.external_task_id === null ? {} : { externalTaskId: row.external_task_id }),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateMarkdown(markdown: string, allowedAssets: string[] = []): void {
  if (!markdown.trim() || Buffer.byteLength(markdown) > 10 * 1024 * 1024) throw new GradingSessionError("Converted Markdown is empty or too large");
  const unsafeLink = /!?(?:\[[^\]]*\])\((?<target>[^)]+)\)/g;
  for (const match of markdown.matchAll(unsafeLink)) {
    const target = match.groups?.target?.trim() ?? "";
    if (target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:/.test(target) || target.split(/[\\/]/).includes("..")) {
      throw new GradingSessionError("Markdown contains an unsafe cross-directory reference");
    }
  }
  if (/!\[[^\]]*\]\[[^\]]*\]|<\s*img\b/i.test(markdown)) throw new GradingSessionError("Markdown images must use controlled inline asset references");
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const target = match.groups?.target ?? "";
    if (!allowedAssets.includes(target)) throw new GradingSessionError("Markdown image must reference an imported submission asset");
  }
}

function validateFileSignature(extension: string, bytes: Buffer): void {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const zipNames = [".docx", ".pptx"].includes(extension) && starts(0x50, 0x4b) ? readZipEntryNames(bytes) : new Set<string>();
  const valid = extension === ".md"
    || (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    || (extension === ".docx" && zipNames.has("[Content_Types].xml") && zipNames.has("word/document.xml"))
    || (extension === ".pptx" && zipNames.has("[Content_Types].xml") && zipNames.has("ppt/presentation.xml"))
    || (extension === ".png" && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    || ([".jpg", ".jpeg"].includes(extension) && starts(0xff, 0xd8, 0xff));
  if (!valid) throw new GradingSessionError("Submission content does not match its filename extension");
}

function readZipEntryNames(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  try {
    const unzipper = new Unzip((file) => { names.add(file.name.replaceAll("\\", "/")); });
    unzipper.push(bytes, true);
  } catch {
    return new Set();
  }
  return names;
}

function hashSubmission(originalHash: string, markdown: string, assets: string[]): string {
  return sha256(Buffer.from(`${originalHash}\n${sha256(Buffer.from(markdown))}\n${assets.sort().join("\n")}`));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
