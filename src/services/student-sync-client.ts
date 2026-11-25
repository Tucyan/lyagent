import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { MaterialService } from "./material-service.js";
import { isSafeModelBaseUrl } from "../config/model-base-url.js";

export interface PushCourseReleaseResult {
  courseId: string;
  courseName: string;
  releaseId: string;
  manifestHash: string;
  deduplicated: boolean;
}

export class StudentSyncClientError extends Error {
  constructor(
    public readonly code: "SYNC_NOT_CONFIGURED" | "NO_ACTIVE_RELEASE" | "UNSAFE_SERVER_URL" | "SYNC_FAILED",
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "StudentSyncClientError";
  }
}

export async function packageActiveCourseRelease(workspaceRoot: string, courseId: string): Promise<{
  bundleBytes: Uint8Array;
  sha256: string;
  releaseId: string;
  manifestHash: string;
  courseName: string;
}> {
  const materials = new MaterialService(workspaceRoot);
  const filesystem = new SafeFilesystem(workspaceRoot);
  const course = (await materials.listCourses()).find((item) => item.id === courseId);
  if (!course) {
    throw new StudentSyncClientError("NO_ACTIVE_RELEASE", "课程不存在", 404);
  }
  const snapshot = await materials.getActiveReleaseSnapshot(courseId);
  if (!snapshot) {
    throw new StudentSyncClientError("NO_ACTIVE_RELEASE", "该课程尚无已发布的正式资料版本", 409);
  }

  const releaseId = snapshot.release.id;
  const releasePrefix = `knowledge/${courseId}/releases/${releaseId}`;
  const relativeFiles = await listRelativeFiles(filesystem, releasePrefix);

  const zipInput: Record<string, Uint8Array> = {
    "course.json": Buffer.from(`${JSON.stringify(course, null, 2)}\n`, "utf8"),
    "active.json": Buffer.from(
      `${JSON.stringify({ releaseId, manifestHash: snapshot.release.manifestHash }, null, 2)}\n`,
      "utf8",
    ),
  };

  for (const rel of relativeFiles) {
    const bytes = await filesystem.readBytes(`${releasePrefix}/${rel}`);
    zipInput[`releases/${releaseId}/${rel}`] = bytes;
  }

  const bundleBytes = zipSync(zipInput, { level: 6 });
  const sha256 = createHash("sha256").update(bundleBytes).digest("hex");
  return {
    bundleBytes,
    sha256,
    releaseId,
    manifestHash: snapshot.release.manifestHash,
    courseName: course.name,
  };
}

export async function pushActiveCourseRelease(input: {
  workspaceRoot: string;
  courseId: string;
  serverUrl: string;
  syncToken: string;
  fetchImpl?: typeof fetch;
}): Promise<PushCourseReleaseResult> {
  const normalizedUrl = input.serverUrl.trim().replace(/\/+$/u, "");
  if (!isSafeModelBaseUrl(normalizedUrl)) {
    throw new StudentSyncClientError("UNSAFE_SERVER_URL", "学生端服务器地址必须使用 HTTPS（本机测试允许环回 HTTP）", 400);
  }
  const packaged = await packageActiveCourseRelease(input.workspaceRoot, input.courseId);
  const fetchFn = input.fetchImpl ?? fetch;
  const targetUrl = `${normalizedUrl}/api/sync/courses/${encodeURIComponent(input.courseId)}/releases`;

  let response: Response;
  try {
    response = await fetchFn(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.syncToken}`,
        "Content-Type": "application/zip",
        "X-Bundle-Sha256": packaged.sha256,
      },
      body: Buffer.from(packaged.bundleBytes),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new StudentSyncClientError("SYNC_FAILED", `连接学生端服务器失败: ${error instanceof Error ? error.message : "网络错误"}`, 502);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new StudentSyncClientError("SYNC_FAILED", body.message || `学生端服务器返回错误 (${response.status})`, response.status);
  }

  return (await response.json()) as PushCourseReleaseResult;
}

async function listRelativeFiles(filesystem: SafeFilesystem, basePrefix: string, subDir = ""): Promise<string[]> {
  const current = subDir ? `${basePrefix}/${subDir}` : basePrefix;
  const files = await filesystem.listFiles(current);
  const dirs = await filesystem.listDirectories(current);
  const results = files.map((file) => (subDir ? `${subDir}/${file}` : file));
  for (const dir of dirs) {
    const nested = await listRelativeFiles(filesystem, basePrefix, subDir ? `${subDir}/${dir}` : dir);
    results.push(...nested);
  }
  return results;
}
