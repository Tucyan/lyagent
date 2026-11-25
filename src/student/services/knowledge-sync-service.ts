import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import { SafeFilesystem } from "../../core/safe-filesystem.js";
import { MaterialService, type Course, type KnowledgeRelease } from "../../services/material-service.js";

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
  private readonly filesystem: SafeFilesystem;
  private readonly materials: MaterialService;

  constructor(private readonly workspaceRoot: string) {
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

    const courseMeta = parseJson(courseBytes, courseMetaSchema, "course.json") as Course;
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

    const releaseJsonBytes = files.get(`${releasePrefix}index/release.json`);
    const manifestBytes = files.get(`${releasePrefix}index/manifest.json`);
    const treeBytes = files.get(`${releasePrefix}index/tree.json`);
    if (!releaseJsonBytes || !manifestBytes || !treeBytes) {
      throw new KnowledgeSyncError("INVALID_BUNDLE", "资料包缺少 release 索引文件", 422);
    }

    const releaseMeta = JSON.parse(Buffer.from(releaseJsonBytes).toString("utf8")) as KnowledgeRelease;
    if (
      releaseMeta.id !== activePointer.releaseId ||
      releaseMeta.courseId !== input.courseId ||
      releaseMeta.manifestHash !== activePointer.manifestHash
    ) {
      throw new KnowledgeSyncError("INTEGRITY_FAILED", "release 元数据与 active 指针不一致", 422);
    }

    // Verify per-file hashes if manifest carries entries
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as {
      manifestHash?: string;
      entries?: Array<{ path: string; contentHash: string }>;
    };
    if (Array.isArray(manifest.entries)) {
      for (const item of manifest.entries) {
        const docBytes = files.get(`${releasePrefix}${item.path}`);
        if (!docBytes) {
          throw new KnowledgeSyncError("INTEGRITY_FAILED", `缺少索引文件 ${item.path}`, 422);
        }
        const docHash = createHash("sha256").update(docBytes).digest("hex");
        if (docHash !== item.contentHash) {
          throw new KnowledgeSyncError("INTEGRITY_FAILED", `文件 ${item.path} 内容哈希校验失败`, 422);
        }
      }
    }

    // Check if identical release already exists
    const targetReleaseDir = `knowledge/${input.courseId}/releases/${activePointer.releaseId}`;
    const existingRelease = await this.materials
      .listReleases(input.courseId)
      .then((list) => list.find((r) => r.id === activePointer.releaseId))
      .catch(() => undefined);

    if (existingRelease && existingRelease.manifestHash === activePointer.manifestHash) {
      await this.filesystem.writeText(`knowledge/${input.courseId}/course.json`, `${JSON.stringify(courseMeta, null, 2)}\n`);
      await this.filesystem.writeText(
        `knowledge/${input.courseId}/active.json`,
        `${JSON.stringify({ releaseId: activePointer.releaseId, manifestHash: activePointer.manifestHash }, null, 2)}\n`,
      );
      return {
        courseId: input.courseId,
        courseName: courseMeta.name,
        releaseId: activePointer.releaseId,
        manifestHash: activePointer.manifestHash,
        deduplicated: true,
      };
    }

    // Write into isolated sync-staging before moving into releases/
    const stagingRelative = `inbox/sync-staging/${input.courseId}/${randomUUID()}`;
    try {
      for (const [entryPath, bytes] of files) {
        if (!entryPath.startsWith(releasePrefix)) continue;
        const innerPath = entryPath.slice(releasePrefix.length);
        await this.filesystem.writeBytes(`${stagingRelative}/${innerPath}`, bytes);
      }

      if (!existingRelease) {
        await this.filesystem.moveDirectory(stagingRelative, targetReleaseDir);
      } else {
        await this.filesystem.removeDirectory(stagingRelative).catch(() => undefined);
      }

      await this.filesystem.writeText(`knowledge/${input.courseId}/course.json`, `${JSON.stringify(courseMeta, null, 2)}\n`);
      await this.filesystem.writeText(
        `knowledge/${input.courseId}/active.json`,
        `${JSON.stringify({ releaseId: activePointer.releaseId, manifestHash: activePointer.manifestHash }, null, 2)}\n`,
      );

      // Final end-to-end verification using MaterialService
      const snapshot = await this.materials.getActiveReleaseSnapshot(input.courseId);
      if (!snapshot || snapshot.release.id !== activePointer.releaseId) {
        throw new KnowledgeSyncError("INTEGRITY_FAILED", "同步后激活版本校验失败", 422);
      }

      return {
        courseId: input.courseId,
        courseName: courseMeta.name,
        releaseId: activePointer.releaseId,
        manifestHash: activePointer.manifestHash,
        deduplicated: false,
      };
    } catch (error) {
      await this.filesystem.removeDirectory(stagingRelative).catch(() => undefined);
      if (error instanceof KnowledgeSyncError) throw error;
      throw new KnowledgeSyncError("INTEGRITY_FAILED", error instanceof Error ? error.message : "资料同步校验失败", 422);
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
