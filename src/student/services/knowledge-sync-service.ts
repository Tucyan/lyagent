import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import { SafeFilesystem } from "../../core/safe-filesystem.js";
import { MaterialService, type Course } from "../../services/material-service.js";

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_COUNT = 2_000;
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_SYNC_EXTENSIONS = new Set([".json", ".md", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

const uuidSchema = z.string().uuid();
const courseMetaSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(100),
  createdAt: z.string().min(1),
});
const activePointerSchema = z.object({
  releaseId: uuidSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export class KnowledgeSyncError extends Error {
  constructor(
    public readonly code:
      | "INVALID_BUNDLE"
      | "HASH_MISMATCH"
      | "UNSAFE_ENTRY"
      | "INTEGRITY_FAILED",
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "KnowledgeSyncError";
  }
}

export interface SyncedReleaseResult {
  courseId: string;
  courseName: string;
  releaseId: string;
  manifestHash: string;
  deduplicated: boolean;
}

export class KnowledgeSyncService {
  private static readonly courseTails = new Map<string, Promise<void>>();
  private readonly filesystem: SafeFilesystem;
  private readonly materials: MaterialService;

  constructor(workspaceRoot: string) {
    this.filesystem = new SafeFilesystem(workspaceRoot);
    this.materials = new MaterialService(workspaceRoot);
  }

  async importReleaseBundle(input: {
    courseId: string;
    bundleBytes: Uint8Array;
    expectedSha256?: string;
  }): Promise<SyncedReleaseResult> {
    if (!uuidSchema.safeParse(input.courseId).success) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "课程 ID 格式无效", 400);
    }
    if (input.bundleBytes.byteLength === 0 || input.bundleBytes.byteLength > MAX_BUNDLE_BYTES) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包大小超出允许范围", 413);
    }
    const actualBundleHash = createHash("sha256").update(input.bundleBytes).digest("hex");
    if (input.expectedSha256 && input.expectedSha256.trim().toLowerCase() !== actualBundleHash) {
      throw new KnowledgeSyncError("HASH_MISMATCH", "资料包 SHA-256 校验不匹配", 422);
    }

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(input.bundleBytes);
    } catch {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "无法解压资料包，请确认格式为有效 ZIP", 400);
    }

    const fileEntries = Object.entries(entries).filter(([entryPath]) => !entryPath.endsWith("/"));
    if (fileEntries.length === 0 || fileEntries.length > MAX_ENTRY_COUNT) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包文件数量异常", 422);
    }

    let totalBytes = 0;
    const files = new Map<string, Uint8Array>();
    for (const [rawPath, bytes] of fileEntries) {
      const normalized = validateEntryPath(rawPath);
      if (bytes.byteLength > MAX_SINGLE_FILE_BYTES) {
        throw new KnowledgeSyncError("INVALID_BUNDLE", `文件 ${normalized} 超过单文件大小上限`, 413);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包解压后总大小超限", 413);
      }
      files.set(normalized, bytes);
    }

    const courseBytes = files.get("course.json");
    const activeBytes = files.get("active.json");
    if (!courseBytes || !activeBytes) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包缺少 course.json 或 active.json", 422);
    }

    const courseMeta = parseJson(courseBytes, courseMetaSchema, "course.json");
    if (courseMeta.id !== input.courseId) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包课程 ID 与目标课程不一致", 422);
    }
    const activePointer = parseJson(activeBytes, activePointerSchema, "active.json");
    const releasePrefix = `releases/${activePointer.releaseId}/`;

    for (const entryPath of files.keys()) {
      if (entryPath !== "course.json" && entryPath !== "active.json" && !entryPath.startsWith(releasePrefix)) {
        throw new KnowledgeSyncError("UNSAFE_ENTRY", `资料包包含非预期路径: ${entryPath}`, 422);
      }
    }

    if (!["release.json", "manifest.json", "tree.json"].every((file) => files.has(`${releasePrefix}index/${file}`))) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包缺少 release 索引文件", 422);
    }

    const coursePath = path.join(this.filesystem.root, courseMeta.id);
    const key = process.platform === "win32" ? coursePath.toLowerCase() : coursePath;
    const previous = KnowledgeSyncService.courseTails.get(key) ?? Promise.resolve();
    const operation = previous.then(() => this.installRelease(courseMeta, activePointer, releasePrefix, files));
    const tail = operation.then(() => undefined, () => undefined);
    KnowledgeSyncService.courseTails.set(key, tail);
    try {
      return await operation;
    } finally {
      if (KnowledgeSyncService.courseTails.get(key) === tail) KnowledgeSyncService.courseTails.delete(key);
    }
  }

  private async installRelease(
    course: Course,
    pointer: z.infer<typeof activePointerSchema>,
    releasePrefix: string,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<SyncedReleaseResult> {
    const { releaseId, manifestHash } = pointer;
    const courseDirectory = `knowledge/${course.id}`;
    const targetReleaseDir = `${courseDirectory}/releases/${releaseId}`;
    const stagingId = randomUUID();
    const stagingRelative = `inbox/sync-staging/${course.id}/${stagingId}`;
    const stagedReleaseDir = `${stagingRelative}/releases/${releaseId}`;
    try {
      for (const [entryPath, bytes] of files) {
        if (!entryPath.startsWith(releasePrefix)) continue;
        const innerPath = entryPath.slice(releasePrefix.length);
        await this.filesystem.writeBytes(`${stagedReleaseDir}/${innerPath}`, bytes);
      }
      await this.materials.validateReleaseForSync(course.id, releaseId, manifestHash, stagingId);

      const deduplicated = await this.filesystem.directoryExists(targetReleaseDir);
      if (deduplicated) await this.materials.validateReleaseForSync(course.id, releaseId, manifestHash);

      const courseText = `${JSON.stringify(course, null, 2)}\n`;
      const activeText = `${JSON.stringify(pointer, null, 2)}\n`;
      if (await this.filesystem.directoryExists(courseDirectory)) {
        if (!deduplicated) await this.filesystem.moveDirectory(stagedReleaseDir, targetReleaseDir);
        await this.activateInstalledRelease(courseDirectory, courseText, activeText);
      } else {
        await this.filesystem.writeText(`${stagingRelative}/course.json`, courseText);
        await this.filesystem.writeText(`${stagingRelative}/active.json`, activeText);
        await this.filesystem.moveDirectory(stagingRelative, courseDirectory);
      }

      return {
        courseId: course.id,
        courseName: course.name,
        releaseId,
        manifestHash,
        deduplicated,
      };
    } catch {
      throw new KnowledgeSyncError("INTEGRITY_FAILED", "资料同步校验或安装失败", 422);
    } finally {
      await this.filesystem.removeDirectory(stagingRelative).catch(() => undefined);
    }
  }

  private async activateInstalledRelease(courseDirectory: string, courseText: string, activeText: string): Promise<void> {
    const courseFile = `${courseDirectory}/course.json`;
    const activeFile = `${courseDirectory}/active.json`;
    const previousCourse = await this.filesystem.readBytes(courseFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!previousCourse) {
      // An older sync may have installed the release before registering the course.
      await this.filesystem.writeText(activeFile, activeText);
      await this.filesystem.writeText(courseFile, courseText);
      return;
    }

    const metadataChanged = !previousCourse.equals(Buffer.from(courseText));
    if (metadataChanged) await this.filesystem.writeText(courseFile, courseText);
    try {
      await this.filesystem.writeText(activeFile, activeText);
    } catch (error) {
      if (metadataChanged) await this.filesystem.writeBytes(courseFile, previousCourse);
      throw error;
    }
  }

  async listSyncedCourses(): Promise<Array<{ id: string; name: string; activeReleaseId?: string; releasedAt?: string }>> {
    const courses = await this.materials.listCourses();
    const out: Array<{ id: string; name: string; activeReleaseId?: string; releasedAt?: string }> = [];
    for (const course of courses) {
      try {
        const snapshot = await this.materials.getActiveReleaseSnapshot(course.id);
        out.push({
          id: course.id,
          name: course.name,
          ...(snapshot ? { activeReleaseId: snapshot.release.id, releasedAt: snapshot.release.createdAt } : {}),
        });
      } catch {
        out.push({ id: course.id, name: course.name });
      }
    }
    return out;
  }
}

function validateEntryPath(rawPath: string): string {
  const normalized = rawPath.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.includes("\0") || normalized.includes(":")) {
    throw new KnowledgeSyncError("UNSAFE_ENTRY", `非法路径: ${rawPath}`, 422);
  }
  const segments = normalized.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) {
    throw new KnowledgeSyncError("UNSAFE_ENTRY", `非法路径段: ${rawPath}`, 422);
  }
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ALLOWED_SYNC_EXTENSIONS.has(ext)) {
    throw new KnowledgeSyncError("UNSAFE_ENTRY", `不支持的文件扩展名: ${rawPath}`, 422);
  }
  return normalized;
}

function parseJson<T>(bytes: Uint8Array, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch {
    throw new KnowledgeSyncError("INVALID_BUNDLE", `${label} 格式无效`, 422);
  }
}
