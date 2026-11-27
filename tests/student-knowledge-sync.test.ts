import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeFilesystem } from "../src/core/safe-filesystem.js";
import { KnowledgeService } from "../src/services/knowledge-service.js";
import { MaterialService } from "../src/services/material-service.js";
import { packageActiveCourseRelease } from "../src/services/student-sync-client.js";
import { KnowledgeSyncError, KnowledgeSyncService } from "../src/student/services/knowledge-sync-service.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createPublishedTeacherCourse(teacherRoot: string) {
  const materials = new MaterialService(teacherRoot);
  const course = await materials.createCourse("计算机网络");
  const release = await publishTeacherRelease(materials, course.id, "分组交换把报文划分为分组。");
  return { course, release };
}

const documentPath = "01-概述/01-分组交换.md";

async function publishTeacherRelease(materials: MaterialService, courseId: string, content: string) {
  const imported = await materials.createImport(courseId, [
    { relativePath: "ch1.md", content: `# 概述\n${content}\n` },
  ]);
  const draft = await materials.renderPlan(courseId, imported.id, {
    documents: [{ path: documentPath, title: "分组交换", sectionIds: ["ch1.md#0"] }],
  });
  return materials.publish(courseId, imported.id, draft.version, draft.manifestHash);
}

async function createSyncFixture() {
  const teacherRoot = makeTempDir("lyagent-teacher-");
  const studentRoot = makeTempDir("lyagent-student-");
  const { course, release } = await createPublishedTeacherCourse(teacherRoot);
  const initial = await packageActiveCourseRelease(teacherRoot, course.id);
  const sync = new KnowledgeSyncService(studentRoot);
  await sync.importReleaseBundle({ courseId: course.id, bundleBytes: initial.bundleBytes });
  const next = await publishTeacherRelease(new MaterialService(teacherRoot), course.id, "合成测试中的新版资料。");
  const nextBundle = await packageActiveCourseRelease(teacherRoot, course.id);
  return { courseId: course.id, studentRoot, release, sync, next, nextBundle };
}

function readEntry<T>(files: Record<string, Uint8Array>, filename: string): T {
  return JSON.parse(Buffer.from(files[filename]!).toString("utf8")) as T;
}

describe("KnowledgeSyncService & student-sync-client", () => {
  it("packages active release from teacher workspace and imports idempotently into student workspace", async () => {
    const teacherRoot = makeTempDir("lyagent-teacher-");
    const studentRoot = makeTempDir("lyagent-student-");
    const { course, release } = await createPublishedTeacherCourse(teacherRoot);

    const packaged = await packageActiveCourseRelease(teacherRoot, course.id);
    expect(packaged.releaseId).toBe(release.id);

    const syncService = new KnowledgeSyncService(studentRoot);
    const first = await syncService.importReleaseBundle({
      courseId: course.id,
      bundleBytes: packaged.bundleBytes,
      expectedSha256: packaged.sha256,
    });
    expect(first.deduplicated).toBe(false);
    expect(first.releaseId).toBe(release.id);

    const knowledge = new KnowledgeService(studentRoot);
    const courseKnowledge = await knowledge.forCourse(course.id);
    expect(courseKnowledge.documents).toHaveLength(1);
    expect((await courseKnowledge.readLines("01-概述/01-分组交换.md", 1, 100)).content).toContain("分组交换把报文划分为分组");

    const second = await syncService.importReleaseBundle({
      courseId: course.id,
      bundleBytes: packaged.bundleBytes,
      expectedSha256: packaged.sha256,
    });
    expect(second.deduplicated).toBe(true);
  });

  it("rejects mismatched hashes, path traversal entries, and disallowed extensions", async () => {
    const teacherRoot = makeTempDir("lyagent-teacher-");
    const studentRoot = makeTempDir("lyagent-student-");
    const { course } = await createPublishedTeacherCourse(teacherRoot);
    const packaged = await packageActiveCourseRelease(teacherRoot, course.id);
    const syncService = new KnowledgeSyncService(studentRoot);

    await expect(
      syncService.importReleaseBundle({
        courseId: course.id,
        bundleBytes: packaged.bundleBytes,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });

    const maliciousZip = zipSync({
      "../escape.md": Buffer.from("bad", "utf8"),
    });
    await expect(
      syncService.importReleaseBundle({ courseId: course.id, bundleBytes: maliciousZip }),
    ).rejects.toBeInstanceOf(KnowledgeSyncError);

    const exeZip = zipSync({
      "payload.exe": Buffer.from("MZ", "utf8"),
    });
    await expect(
      syncService.importReleaseBundle({ courseId: course.id, bundleBytes: exeZip }),
    ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
  });

  it("rejects a changed tree before installing the candidate or updating the active pointer", async () => {
    const { courseId, studentRoot, release, sync, next, nextBundle } = await createSyncFixture();
    const files = unzipSync(nextBundle.bundleBytes);
    const treePath = `releases/${next.id}/index/tree.json`;
    const tree = readEntry<Array<{ title: string }>>(files, treePath);
    tree[0]!.title = "被修改的标题";
    files[treePath] = Buffer.from(JSON.stringify(tree));

    await expect(sync.importReleaseBundle({ courseId, bundleBytes: zipSync(files) }))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(existsSync(path.join(studentRoot, "knowledge", courseId, "releases", next.id))).toBe(false);
    const knowledge = await new KnowledgeService(studentRoot).forCourse(courseId);
    expect(knowledge.release.id).toBe(release.id);
    expect((await knowledge.readLines(documentPath, 1, 100)).content).toContain("分组交换把报文划分为分组");
  });

  it("rejects a changed legacy body even without a per-file manifest", async () => {
    const { courseId, studentRoot, release, sync, next, nextBundle } = await createSyncFixture();
    const files = unzipSync(nextBundle.bundleBytes);
    const base = `releases/${next.id}`;
    const { manifestHash } = readEntry<{ manifestHash: string }>(files, `${base}/index/draft.json`);
    const { treeHash: _treeHash, ...meta } = next;
    files[`${base}/index/release.json`] = Buffer.from(JSON.stringify({ ...meta, manifestHash }));
    files[`${base}/index/manifest.json`] = Buffer.from(JSON.stringify({ manifestHash, files: [documentPath] }));
    files["active.json"] = Buffer.from(JSON.stringify({ releaseId: next.id, manifestHash }));
    const validLegacyBundle = zipSync(files);
    files[`${base}/${documentPath}`] = Buffer.from("# 损坏的合成正文");

    await expect(sync.importReleaseBundle({ courseId, bundleBytes: zipSync(files) }))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(existsSync(path.join(studentRoot, "knowledge", courseId, "releases", next.id))).toBe(false);
    expect((await new MaterialService(studentRoot).getActiveRelease(courseId))?.id).toBe(release.id);
    await expect(sync.importReleaseBundle({ courseId, bundleBytes: validLegacyBundle })).resolves.toMatchObject({ releaseId: next.id });
  });

  it("rejects reuse of an installed release ID with a different manifest hash", async () => {
    const { courseId, studentRoot, release, sync, next, nextBundle } = await createSyncFixture();
    const files = Object.fromEntries(Object.entries(unzipSync(nextBundle.bundleBytes)).map(([filename, bytes]) => [
      filename.replace(`releases/${next.id}/`, `releases/${release.id}/`), bytes,
    ]));
    files["active.json"] = Buffer.from(JSON.stringify({ releaseId: release.id, manifestHash: next.manifestHash }));
    files[`releases/${release.id}/index/release.json`] = Buffer.from(JSON.stringify({ ...next, id: release.id }));

    await expect(sync.importReleaseBundle({ courseId, bundleBytes: zipSync(files) }))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await new MaterialService(studentRoot).getActiveRelease(courseId)).toEqual(release);
  });

  it("rejects a corrupt duplicate bundle even if its installed release is valid", async () => {
    const { courseId, studentRoot, sync, next, nextBundle } = await createSyncFixture();
    await sync.importReleaseBundle({ courseId, bundleBytes: nextBundle.bundleBytes });
    const files = unzipSync(nextBundle.bundleBytes);
    files[`releases/${next.id}/index/tree.json`] = Buffer.from("[]");

    await expect(sync.importReleaseBundle({ courseId, bundleBytes: zipSync(files) }))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await new MaterialService(studentRoot).getActiveRelease(courseId)).toEqual(next);
  });

  it("revalidates installed bodies before switching to a deduplicated release", async () => {
    const { courseId, studentRoot, release, sync, next, nextBundle } = await createSyncFixture();
    const materials = new MaterialService(studentRoot);
    await sync.importReleaseBundle({ courseId, bundleBytes: nextBundle.bundleBytes });
    await materials.activateRelease(courseId, release.id);
    await new SafeFilesystem(studentRoot).writeText(`knowledge/${courseId}/releases/${next.id}/${documentPath}`, "# 损坏正文");

    await expect(sync.importReleaseBundle({ courseId, bundleBytes: nextBundle.bundleBytes }))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await materials.getActiveRelease(courseId)).toEqual(release);
  });

  it("retries after the release move succeeds and the pointer write fails", async () => {
    const { courseId, studentRoot, release, sync, next, nextBundle } = await createSyncFixture();
    const filesystem = new SafeFilesystem(studentRoot);
    const courseFile = `knowledge/${courseId}/course.json`;
    const previousCourse = await filesystem.readText(courseFile);
    const files = unzipSync(nextBundle.bundleBytes);
    files["course.json"] = Buffer.from(JSON.stringify({ ...readEntry<object>(files, "course.json"), name: "合成的新课程名" }));
    const update = { courseId, bundleBytes: zipSync(files) };
    const writeText = SafeFilesystem.prototype.writeText;
    const failPointer = vi.spyOn(SafeFilesystem.prototype, "writeText").mockImplementation(function (this: SafeFilesystem, target, text) {
      if (target === `knowledge/${courseId}/active.json`) return Promise.reject(new Error("synthetic pointer failure"));
      return writeText.call(this, target, text);
    });

    await expect(sync.importReleaseBundle(update))
      .rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    failPointer.mockRestore();
    const materials = new MaterialService(studentRoot);
    expect(await materials.getActiveRelease(courseId)).toEqual(release);
    expect(await filesystem.readText(courseFile)).toBe(previousCourse);
    expect(existsSync(path.join(studentRoot, "knowledge", courseId, "releases", next.id))).toBe(true);
    await expect(new KnowledgeSyncService(studentRoot).importReleaseBundle(update))
      .resolves.toMatchObject({ deduplicated: true, releaseId: next.id });
    expect(await materials.getActiveRelease(courseId)).toEqual(next);
    expect(await sync.listSyncedCourses()).toMatchObject([{ id: courseId, name: "合成的新课程名", activeReleaseId: next.id }]);
  });

  it("keeps a first-time course out of the catalog when its installation fails", async () => {
    const teacherRoot = makeTempDir("lyagent-teacher-");
    const studentRoot = makeTempDir("lyagent-student-");
    const { course, release } = await createPublishedTeacherCourse(teacherRoot);
    const { bundleBytes } = await packageActiveCourseRelease(teacherRoot, course.id);
    const sync = new KnowledgeSyncService(studentRoot);
    const moveDirectory = SafeFilesystem.prototype.moveDirectory;
    const failInstall = vi.spyOn(SafeFilesystem.prototype, "moveDirectory").mockImplementation(function (this: SafeFilesystem, from, to) {
      if (to === `knowledge/${course.id}` || to.startsWith(`knowledge/${course.id}/`)) {
        return Promise.reject(new Error("synthetic install failure"));
      }
      return moveDirectory.call(this, from, to);
    });

    await expect(sync.importReleaseBundle({ courseId: course.id, bundleBytes })).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await sync.listSyncedCourses()).toEqual([]);
    expect(existsSync(path.join(studentRoot, "knowledge", course.id))).toBe(false);
    failInstall.mockRestore();
    await expect(sync.importReleaseBundle({ courseId: course.id, bundleBytes })).resolves.toMatchObject({
      releaseId: release.id,
      deduplicated: false,
    });
    expect(await sync.listSyncedCourses()).toMatchObject([{ id: course.id, activeReleaseId: release.id }]);
  });

  it("serializes concurrent imports for the same course across service instances", async () => {
    const { courseId, studentRoot, sync, next, nextBundle } = await createSyncFixture();
    const input = { courseId, bundleBytes: nextBundle.bundleBytes };
    const results = await Promise.all([sync.importReleaseBundle(input), new KnowledgeSyncService(studentRoot).importReleaseBundle(input)]);
    expect(results.map((result) => result.deduplicated).sort()).toEqual([false, true]);
    expect(await new MaterialService(studentRoot).getActiveRelease(courseId)).toEqual(next);
  });
});
