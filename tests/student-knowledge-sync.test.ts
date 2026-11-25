import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
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
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createPublishedTeacherCourse(teacherRoot: string) {
  const materials = new MaterialService(teacherRoot);
  const course = await materials.createCourse("计算机网络");
  const imported = await materials.createImport(course.id, [
    { relativePath: "ch1.md", content: "# 概述\n分组交换把报文划分为分组。\n" },
  ]);
  const draft = await materials.renderPlan(course.id, imported.id, {
    documents: [{ path: "01-概述/01-分组交换.md", title: "分组交换", sectionIds: ["ch1.md#0"] }],
  });
  const release = await materials.publish(course.id, imported.id, draft.version, draft.manifestHash);
  return { course, release };
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
});
