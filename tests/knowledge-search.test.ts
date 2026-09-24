import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeAccessError, KnowledgeService } from "../src/services/knowledge-service.js";
import { MaterialService } from "../src/services/material-service.js";
import { SafeFilesystem } from "../src/core/safe-filesystem.js";

const roots: string[] = [];

async function publishedCourse() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-knowledge-"));
  roots.push(root);
  const materials = new MaterialService(root);
  const course = await materials.createCourse("操作系统");
  const imported = await materials.createImport(course.id, [{
    relativePath: "source.md",
    content: "# 进程\n进程是程序的一次执行。\n\n## 调度\n调度决定下一个运行的进程。\n",
  }]);
  const draft = await materials.renderPlan(course.id, imported.id, {
    documents: [{ path: "第一章/进程.md", title: "进程与调度", sectionIds: ["source.md#0", "source.md#1"] }],
  });
  const release = await materials.publish(course.id, imported.id, draft.version, draft.manifestHash);
  return { root, course, release, knowledge: new KnowledgeService(root) };
}

async function convertToLegacyRelease(root: string, courseId: string, releaseId: string): Promise<void> {
  const releaseDirectory = path.join(root, "knowledge", courseId, "releases", releaseId);
  const draft = JSON.parse(await readFile(path.join(releaseDirectory, "index", "draft.json"), "utf8")) as {
    manifestHash: string;
    tree: Array<{ path: string }>;
  };
  const releasePath = path.join(releaseDirectory, "index", "release.json");
  const release = JSON.parse(await readFile(releasePath, "utf8")) as Record<string, unknown>;
  delete release.treeHash;
  release.manifestHash = draft.manifestHash;
  await writeFile(releasePath, JSON.stringify(release), "utf8");
  await writeFile(path.join(releaseDirectory, "index", "manifest.json"), JSON.stringify({
    manifestHash: draft.manifestHash,
    files: draft.tree.map(({ path: targetPath }) => targetPath),
  }), "utf8");
  await writeFile(path.join(root, "knowledge", courseId, "active.json"), JSON.stringify({
    releaseId,
    manifestHash: draft.manifestHash,
  }), "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KnowledgeService", () => {
  it("only exposes documents from the course active release", async () => {
    const { course, knowledge } = await publishedCourse();
    const other = new MaterialService(roots[0]!);
    const otherCourse = await other.createCourse("其他课程");
    const service = await knowledge.forCourse(course.id);

    await expect(knowledge.forCourse(otherCourse.id)).rejects.toBeInstanceOf(KnowledgeAccessError);
    await expect(service.listDirectory("")).resolves.toEqual([{ path: "第一章/进程.md", title: "进程与调度", type: "file" }]);
    expect(await service.search("进程")).toContainEqual(expect.objectContaining({ path: "第一章/进程.md", startLine: 1 }));
  });

  it("returns bounded logical search results and line ranges", async () => {
    const { course, knowledge } = await publishedCourse();
    const service = await knowledge.forCourse(course.id);

    const results = await service.search("调度", 0, 10);
    expect(results).toContainEqual(expect.objectContaining({ path: "第一章/进程.md", title: "进程与调度", startLine: 6, endLine: 6, excerpt: "调度决定下一个运行的进程。" }));
    await expect(service.readLines("第一章/进程.md", 5, 99)).resolves.toEqual({
      path: "第一章/进程.md", startLine: 5, endLine: 7, content: "## 调度\n调度决定下一个运行的进程。\n\n",
    });
    await expect(service.readLines("../staging/secret.md", 1, 1)).rejects.toBeInstanceOf(KnowledgeAccessError);
  });

  it("does not rescan release bodies for repeated listing and single-document reads", async () => {
    const { root, course, release, knowledge } = await publishedCourse();
    const releasePrefix = `knowledge/${course.id}/releases/${release.id}/`;
    const originalRead = SafeFilesystem.prototype.readText;
    let bodyReads = 0;
    const spy = vi.spyOn(SafeFilesystem.prototype, "readText").mockImplementation(async function (
      this: SafeFilesystem,
      relativePath: string,
    ) {
      if (path.resolve(this.root) === path.resolve(root) && relativePath.startsWith(releasePrefix) && relativePath.endsWith(".md")) bodyReads += 1;
      return originalRead.call(this, relativePath);
    });
    try {
      await (await knowledge.forCourse(course.id)).listDirectory("");
      await (await knowledge.forCourse(course.id)).readLines("第一章/进程.md", 1, 1);
      await (await knowledge.forCourse(course.id)).readLines("第一章/进程.md", 2, 2);
    } finally {
      spy.mockRestore();
    }
    expect(bodyReads).toBe(2);
  });

  it("caches a legacy release scan per material service while checking each used body", async () => {
    const { root, course, release, knowledge } = await publishedCourse();
    await convertToLegacyRelease(root, course.id, release.id);
    const releasePrefix = `knowledge/${course.id}/releases/${release.id}/`;
    const originalRead = SafeFilesystem.prototype.readText;
    let bodyReads = 0;
    const spy = vi.spyOn(SafeFilesystem.prototype, "readText").mockImplementation(async function (
      this: SafeFilesystem,
      relativePath: string,
    ) {
      if (path.resolve(this.root) === path.resolve(root) && relativePath.startsWith(releasePrefix) && relativePath.endsWith(".md")) bodyReads += 1;
      return originalRead.call(this, relativePath);
    });
    try {
      await (await knowledge.forCourse(course.id)).listDirectory("");
      await (await knowledge.forCourse(course.id)).readLines("第一章/进程.md", 1, 1);
      await (await knowledge.forCourse(course.id)).readLines("第一章/进程.md", 2, 2);
    } finally {
      spy.mockRestore();
    }
    // One initial legacy full scan and one hash-checked body read for each use.
    expect(bodyReads).toBe(3);
  });

  it("rejects a legacy body rewritten after its first successful full scan", async () => {
    const { root, course, release, knowledge } = await publishedCourse();
    await convertToLegacyRelease(root, course.id, release.id);
    const service = await knowledge.forCourse(course.id);

    const bodyPath = path.join(root, "knowledge", course.id, "releases", release.id, "第一章", "进程.md");
    await writeFile(bodyPath, "# 进程\n伪造的知识正文。\n", "utf8");

    await expect(service.readLines("第一章/进程.md", 1, 2))
      .rejects.toThrow(/integrity|release|unavailable/i);
  });
});
