import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import {
  referencedMarkdownAssetPaths,
  SubmissionAssetError,
  validateSubmissionAssets,
} from "./grading-session-service.js";
import { StudentIdentityError, type StudentIdentity } from "./student-identity-service.js";

export type GradingBatchUploadItemStatus =
  | "pending"
  | "identity_required"
  | "converting"
  | "naming"
  | "ready"
  | "failed"
  | "committed";

export interface GradingBatchUploadItem {
  id: string;
  uploadId: string;
  filename: string;
  status: GradingBatchUploadItemStatus;
  studentName?: string;
  studentNumber?: string;
  sessionId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GradingBatchUpload {
  id: string;
  title: string;
  assignmentId: string;
  rubricVersion: number;
  concurrency: number;
  status: "draft" | "committed";
  committedBatchId?: string;
  items: GradingBatchUploadItem[];
  createdAt: string;
  updatedAt: string;
}

export interface BatchUploadSessionSummary {
  id: string;
  conversionStatus: string;
  submissionTitleStatus: string;
  conversionError?: { code: string; message: string };
  submissionTitleError?: { code: string; message: string };
}

export interface GradingBatchUploadDependencies {
  resolveIdentity(input: { studentName: string; studentNumber: string; filename: string }): Promise<StudentIdentity>;
  createSession(input: {
    assignmentId: string;
    rubricVersion: number;
    studentName: string;
    studentNumber: string;
    originalPath: string;
    originalFilename: string;
    autoStartAfterConversion: false;
    revisionAssets: Array<{ path: string; bytes: Uint8Array }>;
  }): Promise<BatchUploadSessionSummary>;
  getSession(id: string): Promise<BatchUploadSessionSummary>;
  deleteSession(id: string): Promise<void>;
  processConversion(id: string): Promise<unknown>;
  retryConversion(id: string): Promise<unknown>;
  resolveTitle(id: string): Promise<unknown>;
  createBatch(input: {
    title: string;
    assignmentId: string;
    rubricVersion: number;
    concurrency: number;
    sessionIds: string[];
    sourceUploadId: string;
  }): Promise<{ id: string }>;
  getBatch(id: string): Promise<{ id: string }>;
}

interface UploadRow {
  id: string;
  title: string;
  assignment_id: string;
  rubric_version: number;
  concurrency: number;
  status: "draft" | "committed";
  committed_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  upload_id: string;
  filename: string;
  report_path: string | null;
  asset_manifest_json: string;
  status: GradingBatchUploadItemStatus;
  student_name: string | null;
  student_number: string | null;
  session_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class GradingBatchUploadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GradingBatchUploadError";
  }
}

const reportExtensions = new Set([".md", ".pdf", ".docx", ".pptx", ".png", ".jpg", ".jpeg"]);

export class GradingBatchUploadService {
  private readonly database: Database.Database;
  private readonly filesystem: SafeFilesystem;
  private readonly active = new Map<string, Promise<GradingBatchUploadItem>>();

  constructor(
    private readonly root: string,
    private readonly dependencies: GradingBatchUploadDependencies,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.database = new Database(path.join(path.resolve(root), "grading.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.filesystem = new SafeFilesystem(root, {
      allowedExtensions: new Set([".md", ".pdf", ".docx", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".json"]),
    });
    this.migrate();
  }

  async createUpload(input: {
    title: string;
    assignmentId: string;
    rubricVersion: number;
    concurrency: number;
    items: Array<{ filename: string }>;
  }): Promise<GradingBatchUpload> {
    const title = input.title.trim();
    if (!title || title.length > 120)
      throw new GradingBatchUploadError("BATCH_UPLOAD_INVALID", "批次名称必须为 1–120 个字符");
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 8)
      throw new GradingBatchUploadError("BATCH_UPLOAD_INVALID", "并发数必须为 1–8");
    if (input.items.length < 1 || input.items.length > 120)
      throw new GradingBatchUploadError("BATCH_UPLOAD_INVALID", "批次必须包含 1–120 份报告");
    const filenames = input.items.map(({ filename }) => validateFilename(filename));
    const id = randomUUID();
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO grading_batch_uploads
         (id, title, assignment_id, rubric_version, concurrency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
      ).run(id, title, input.assignmentId, input.rubricVersion, input.concurrency, now, now);
      const insert = this.database.prepare(
        `INSERT INTO grading_batch_upload_items
         (id, upload_id, filename, asset_manifest_json, status, created_at, updated_at)
         VALUES (?, ?, ?, '[]', 'pending', ?, ?)`,
      );
      for (const filename of filenames) insert.run(randomUUID(), id, filename, now, now);
    }).immediate();
    return this.getUpload(id);
  }

  async getUpload(id: string): Promise<GradingBatchUpload> {
    const row = this.database.prepare("SELECT * FROM grading_batch_uploads WHERE id = ?").get(id) as UploadRow | undefined;
    if (!row) throw new GradingBatchUploadError("BATCH_UPLOAD_NOT_FOUND", "批次上传草稿不存在");
    const items = this.database.prepare(
      "SELECT * FROM grading_batch_upload_items WHERE upload_id = ? ORDER BY created_at, rowid",
    ).all(id) as ItemRow[];
    return {
      id: row.id,
      title: row.title,
      assignmentId: row.assignment_id,
      rubricVersion: row.rubric_version,
      concurrency: row.concurrency,
      status: row.status,
      ...(row.committed_batch_id ? { committedBatchId: row.committed_batch_id } : {}),
      items: items.map(itemFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async storeItemFile(
    uploadId: string,
    itemId: string,
    input: {
      filename: string;
      bytes: Uint8Array;
      assets: Array<{ path: string; bytes: Uint8Array }>;
    },
  ): Promise<GradingBatchUploadItem> {
    const upload = await this.getUpload(uploadId);
    if (upload.status !== "draft") throw new GradingBatchUploadError("BATCH_UPLOAD_COMMITTED", "已提交的上传草稿不能修改");
    const item = this.getItem(uploadId, itemId);
    const filename = validateFilename(input.filename);
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > 10 * 1024 * 1024)
      throw new GradingBatchUploadError("BATCH_UPLOAD_FILE_INVALID", "报告文件为空或超过 10 MiB");
    const extension = path.extname(filename).toLowerCase();
    if (item.sessionId) await this.dependencies.deleteSession(item.sessionId);
    await this.removeItemDirectory(uploadId, itemId);
    const base = this.itemBase(uploadId, itemId);
    const reportPath = `${base}/report${extension}`;
    await this.filesystem.writeBytes(reportPath, input.bytes);
    const now = this.now();
    this.database.prepare(
      `UPDATE grading_batch_upload_items SET filename = ?, report_path = ?, asset_manifest_json = ?,
       session_id = NULL, status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ? AND upload_id = ?`,
    ).run(filename, reportPath, "[]", now, itemId, uploadId);
    try {
      validateSubmissionAssets(input.assets);
      const markdown = extension === ".md" ? Buffer.from(input.bytes).toString("utf8") : undefined;
      const selectedAssets = markdown === undefined
        ? []
        : selectReferencedAssets(markdown, input.assets);
      if (extension !== ".md" && input.assets.length)
        throw new SubmissionAssetError("SUBMISSION_ASSET_MANIFEST_INVALID", "只有 Markdown 报告可以包含附件", "assetManifest");
      for (const asset of selectedAssets)
        await this.filesystem.writeBytes(`${base}/${asset.path}`, asset.bytes);
      this.database.prepare(
        "UPDATE grading_batch_upload_items SET asset_manifest_json = ?, updated_at = ? WHERE id = ? AND upload_id = ?",
      ).run(JSON.stringify(selectedAssets.map(({ path: assetPath }) => assetPath)), this.now(), itemId, uploadId);
    } catch (error: unknown) {
      const safe = safeItemError(error);
      return this.recordFailure(this.getItemRow(uploadId, itemId), "failed", safe.code, safe.message);
    }
    return itemFromRow(this.getItemRow(uploadId, itemId));
  }

  async patchIdentity(
    uploadId: string,
    itemId: string,
    identity: StudentIdentity,
  ): Promise<GradingBatchUploadItem> {
    await this.getUpload(uploadId);
    const studentName = identity.studentName.trim();
    const studentNumber = identity.studentNumber.trim();
    if (!studentName || !studentNumber)
      throw new GradingBatchUploadError("BATCH_UPLOAD_IDENTITY_INVALID", "姓名与学号必须同时填写");
    this.database.prepare(
      `UPDATE grading_batch_upload_items SET student_name = ?, student_number = ?, status = 'pending',
       error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND upload_id = ?`,
    ).run(studentName, studentNumber, this.now(), itemId, uploadId);
    return itemFromRow(this.getItemRow(uploadId, itemId));
  }

  async processItem(uploadId: string, itemId: string): Promise<GradingBatchUploadItem> {
    const key = `${uploadId}:${itemId}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const running = this.processItemUnlocked(uploadId, itemId).finally(() => this.active.delete(key));
    this.active.set(key, running);
    return running;
  }

  startProcessing(uploadId: string, itemId: string): void {
    void this.processItem(uploadId, itemId).catch(() => undefined);
  }

  async retryItem(uploadId: string, itemId: string): Promise<GradingBatchUploadItem> {
    const item = this.getItem(uploadId, itemId);
    this.database.prepare(
      "UPDATE grading_batch_upload_items SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND upload_id = ?",
    ).run(this.now(), itemId, uploadId);
    if (!item.sessionId) {
      // Identity and pre-session failures resume from the persisted report.
    } else {
      const session = await this.dependencies.getSession(item.sessionId);
      if (session.conversionStatus !== "ready") await this.dependencies.retryConversion(item.sessionId);
      else if (session.submissionTitleStatus === "failed") {
        try { await this.dependencies.resolveTitle(item.sessionId); }
        catch (error: unknown) {
          const safe = safeItemError(error);
          return this.recordFailure(this.getItemRow(uploadId, itemId), "failed", safe.code, safe.message);
        }
      }
    }
    return this.processItem(uploadId, itemId);
  }

  async removeItem(uploadId: string, itemId: string): Promise<{ preservedSessionId?: string }> {
    await this.getUpload(uploadId);
    const item = this.getItem(uploadId, itemId);
    this.database.prepare("DELETE FROM grading_batch_upload_items WHERE id = ? AND upload_id = ?").run(itemId, uploadId);
    await this.removeItemDirectory(uploadId, itemId);
    return item.sessionId ? { preservedSessionId: item.sessionId } : {};
  }

  async commitUpload(uploadId: string): Promise<{ id: string }> {
    const upload = await this.getUpload(uploadId);
    if (upload.committedBatchId) return this.dependencies.getBatch(upload.committedBatchId);
    if (!upload.items.length || upload.items.some((item) => item.status !== "ready" || !item.sessionId))
      throw new GradingBatchUploadError("BATCH_UPLOAD_NOT_READY", "所有保留项就绪后才能创建正式批次");
    const batch = await this.dependencies.createBatch({
      title: upload.title,
      assignmentId: upload.assignmentId,
      rubricVersion: upload.rubricVersion,
      concurrency: upload.concurrency,
      sessionIds: upload.items.map((item) => item.sessionId!),
      sourceUploadId: upload.id,
    });
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(
        "UPDATE grading_batch_uploads SET status = 'committed', committed_batch_id = ?, updated_at = ? WHERE id = ?",
      ).run(batch.id, now, uploadId);
      this.database.prepare(
        "UPDATE grading_batch_upload_items SET status = 'committed', updated_at = ? WHERE upload_id = ?",
      ).run(now, uploadId);
    }).immediate();
    return batch;
  }

  async cancelUpload(uploadId: string): Promise<{ preservedSessionIds: string[] }> {
    const upload = await this.getUpload(uploadId);
    if (upload.status === "committed")
      throw new GradingBatchUploadError("BATCH_UPLOAD_COMMITTED", "正式批次已创建，不能取消上传草稿");
    const preservedSessionIds = upload.items.flatMap((item) => item.sessionId ? [item.sessionId] : []);
    this.database.prepare("DELETE FROM grading_batch_uploads WHERE id = ?").run(uploadId);
    try { await this.filesystem.removeDirectory(`batch-uploads/${uploadId}`); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { preservedSessionIds };
  }

  async recover(): Promise<void> {
    const items = this.database.prepare(
      `SELECT i.* FROM grading_batch_upload_items i
       JOIN grading_batch_uploads u ON u.id = i.upload_id
       WHERE u.status = 'draft' AND i.report_path IS NOT NULL AND i.status IN ('pending', 'converting', 'naming')`,
    ).all() as ItemRow[];
    for (const item of items) this.startProcessing(item.upload_id, item.id);
  }

  close(): void { this.database.close(); }

  private async processItemUnlocked(uploadId: string, itemId: string): Promise<GradingBatchUploadItem> {
    const upload = await this.getUpload(uploadId);
    let row = this.getItemRow(uploadId, itemId);
    if (!row.report_path)
      return this.recordFailure(row, "failed", "BATCH_UPLOAD_FILE_REQUIRED", "请上传或替换报告文件");
    let studentName = row.student_name ?? "";
    let studentNumber = row.student_number ?? "";
    if (!studentName || !studentNumber) {
      try {
        const identity = await this.dependencies.resolveIdentity({ studentName, studentNumber, filename: row.filename });
        studentName = identity.studentName;
        studentNumber = identity.studentNumber;
        this.database.prepare(
          "UPDATE grading_batch_upload_items SET student_name = ?, student_number = ?, updated_at = ? WHERE id = ?",
        ).run(studentName, studentNumber, this.now(), itemId);
      } catch (error: unknown) {
        if (error instanceof StudentIdentityError)
          return this.recordFailure(row, "identity_required", error.code, error.message);
        return this.recordFailure(row, "identity_required", "STUDENT_IDENTITY_REQUEST_FAILED", "学生身份识别失败，请补填姓名和学号");
      }
    }
    try {
      if (!row.session_id) {
        const manifest = JSON.parse(row.asset_manifest_json) as string[];
        const revisionAssets = await Promise.all(manifest.map(async (assetPath) => ({
          path: assetPath,
          bytes: new Uint8Array(await this.filesystem.readBytes(`${this.itemBase(uploadId, itemId)}/${assetPath}`)),
        })));
        const created = await this.dependencies.createSession({
          assignmentId: upload.assignmentId,
          rubricVersion: upload.rubricVersion,
          studentName,
          studentNumber,
          originalPath: path.join(this.root, ...row.report_path.split("/")),
          originalFilename: row.filename,
          autoStartAfterConversion: false,
          revisionAssets,
        });
        this.database.prepare(
          "UPDATE grading_batch_upload_items SET session_id = ?, updated_at = ? WHERE id = ?",
        ).run(created.id, this.now(), itemId);
        row = this.getItemRow(uploadId, itemId);
      }
      let session = await this.dependencies.getSession(row.session_id!);
      if (session.conversionStatus !== "ready") {
        if (["conversion_failed", "result_rejected"].includes(session.conversionStatus))
          return this.recordFailure(row, "failed", session.conversionError?.code ?? "BATCH_UPLOAD_CONVERSION_FAILED", session.conversionError?.message ?? "报告转换失败，请重试或替换文件");
        this.updateStatus(row, "converting");
        await this.dependencies.processConversion(session.id);
        session = await this.dependencies.getSession(session.id);
        if (session.conversionStatus !== "ready") return itemFromRow(this.getItemRow(uploadId, itemId));
      }
      if (!["provided", "resolved"].includes(session.submissionTitleStatus)) {
        if (session.submissionTitleStatus === "failed")
          return this.recordFailure(row, "failed", session.submissionTitleError?.code ?? "SUBMISSION_TITLE_MODEL_FAILED", session.submissionTitleError?.message ?? "作业名称识别失败，请重试");
        this.updateStatus(row, "naming");
        await this.dependencies.resolveTitle(session.id);
        session = await this.dependencies.getSession(session.id);
        if (!["provided", "resolved"].includes(session.submissionTitleStatus))
          return itemFromRow(this.getItemRow(uploadId, itemId));
      }
      this.updateStatus(row, "ready");
      return itemFromRow(this.getItemRow(uploadId, itemId));
    } catch (error: unknown) {
      const safe = safeItemError(error);
      return this.recordFailure(row, "failed", safe.code, safe.message);
    }
  }

  private getItem(uploadId: string, itemId: string): GradingBatchUploadItem {
    return itemFromRow(this.getItemRow(uploadId, itemId));
  }

  private getItemRow(uploadId: string, itemId: string): ItemRow {
    const row = this.database.prepare(
      "SELECT * FROM grading_batch_upload_items WHERE id = ? AND upload_id = ?",
    ).get(itemId, uploadId) as ItemRow | undefined;
    if (!row) throw new GradingBatchUploadError("BATCH_UPLOAD_ITEM_NOT_FOUND", "批次上传项不存在");
    return row;
  }

  private updateStatus(row: ItemRow, status: GradingBatchUploadItemStatus): void {
    this.database.prepare(
      "UPDATE grading_batch_upload_items SET status = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
    ).run(status, this.now(), row.id);
  }

  private recordFailure(
    row: ItemRow,
    status: "identity_required" | "failed",
    code: string,
    message: string,
  ): GradingBatchUploadItem {
    this.database.prepare(
      "UPDATE grading_batch_upload_items SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
    ).run(status, code, message, this.now(), row.id);
    return itemFromRow(this.getItemRow(row.upload_id, row.id));
  }

  private itemBase(uploadId: string, itemId: string): string {
    return `batch-uploads/${uploadId}/${itemId}`;
  }

  private async removeItemDirectory(uploadId: string, itemId: string): Promise<void> {
    try { await this.filesystem.removeDirectory(this.itemBase(uploadId, itemId)); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS grading_batch_uploads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        rubric_version INTEGER NOT NULL,
        concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 8),
        status TEXT NOT NULL,
        committed_batch_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grading_batch_upload_items (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL REFERENCES grading_batch_uploads(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        report_path TEXT,
        asset_manifest_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        student_name TEXT,
        student_number TEXT,
        session_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS grading_batch_upload_items_status_idx
        ON grading_batch_upload_items(upload_id, status, created_at);
    `);
  }
}

function validateFilename(filename: string): string {
  const normalized = filename.trim();
  if (!normalized || normalized !== path.basename(normalized) || normalized.length > 240)
    throw new GradingBatchUploadError("BATCH_UPLOAD_FILE_INVALID", "报告文件名无效");
  const extension = path.extname(normalized).toLowerCase();
  if (!reportExtensions.has(extension))
    throw new GradingBatchUploadError("UNSUPPORTED_SUBMISSION_TYPE", "报告文件类型不受支持");
  return normalized;
}

function selectReferencedAssets(
  markdown: string,
  assets: Array<{ path: string; bytes: Uint8Array }>,
): Array<{ path: string; bytes: Uint8Array }> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  return referencedMarkdownAssetPaths(markdown).map((assetPath) => {
    const asset = byPath.get(assetPath);
    if (!asset)
      throw new SubmissionAssetError(
        "SUBMISSION_ASSET_MISSING",
        `Markdown 图片引用缺少附件：${assetPath}`,
        assetPath,
      );
    return asset;
  });
}

function safeItemError(error: unknown): { code: string; message: string } {
  if (error instanceof SubmissionAssetError) return { code: error.code, message: error.message };
  if (error instanceof GradingBatchUploadError) return { code: error.code, message: error.message };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code))
    return { code, message: "上传项处理失败，请重试或替换文件" };
  return { code: "BATCH_UPLOAD_PROCESSING_FAILED", message: "上传项处理失败，请重试或替换文件" };
}

function itemFromRow(row: ItemRow): GradingBatchUploadItem {
  return {
    id: row.id,
    uploadId: row.upload_id,
    filename: row.filename,
    status: row.status,
    ...(row.student_name ? { studentName: row.student_name } : {}),
    ...(row.student_number ? { studentNumber: row.student_number } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
