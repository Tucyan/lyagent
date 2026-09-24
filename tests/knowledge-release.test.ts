import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeReleaseError, MaterialService } from "../src/services/material-service.js";
import { KnowledgeService } from "../src/services/knowledge-service.js";

const roots: string[] = [];

async function serviceForTest(): Promise<MaterialService> {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-release-"));
  roots.push(root);
  return new MaterialService(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("knowledge release", () => {
  it("does not let renderPlan delete an existing directory outside staging through a junction", async ({ skip }) => {
    const service = await serviceForTest();
    const course = await service.createCourse("受控 staging");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# Lesson\n" }]);
    const outside = await mkdtemp(path.join(os.tmpdir(), "course-agent-outside-staging-"));
    roots.push(outside);
    const courseDirectory = path.join(service.root, "knowledge", course.id);
    const stagingDirectory = path.join(courseDirectory, "staging");
    await mkdir(courseDirectory, { recursive: true });
    await mkdir(path.join(outside, imported.id), { recursive: true });
    await writeFile(path.join(outside, imported.id, "sentinel.md"), "keep", "utf8");
    try {
      await symlink(outside, stagingDirectory, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); static path rejection remains covered by path-security tests.`);
    }

    await expect(service.renderPlan(course.id, imported.id, {
      documents: [{ path: "lesson.md", title: "Lesson", sectionIds: ["source.md#0"] }],
    })).rejects.toThrow();
    await expect(readFile(path.join(outside, imported.id, "sentinel.md"), "utf8")).resolves.toBe("keep");
  });

  it("does not move a published release outside its root through a junction", async ({ skip }) => {
    const service = await serviceForTest();
    const course = await service.createCourse("受控 release");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# Lesson\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "lesson.md", title: "Lesson", sectionIds: ["source.md#0"] }],
    });
    const outside = await mkdtemp(path.join(os.tmpdir(), "course-agent-outside-release-"));
    roots.push(outside);
    const courseDirectory = path.join(service.root, "knowledge", course.id);
    const releasesDirectory = path.join(courseDirectory, "releases");
    await mkdir(courseDirectory, { recursive: true });
    try {
      await symlink(outside, releasesDirectory, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); static path rejection remains covered by path-security tests.`);
    }

    await expect(service.publish(course.id, imported.id, draft.version, draft.manifestHash)).rejects.toThrow();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("publishes a complete draft and switches the active release atomically", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const imported = await service.createImport(course.id, [{
      relativePath: "slides/origin.md",
      content: "# AI\n第一段\n\n## 医疗\n第二段\n",
    }]);

    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "01-概述/AI.md", title: "AI", sectionIds: ["slides/origin.md#0", "slides/origin.md#1"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);

    expect(release.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await service.getActiveRelease(course.id))?.id).toBe(release.id);
    expect(await service.readReleaseContent(course.id, release.id, "01-概述/AI.md")).toContain("## 医疗");
    expect(await readFile(path.join(service.root, "knowledge", course.id, "active.json"), "utf8")).toContain(release.id);
  });

  it("does not publish an incomplete draft or disturb an existing active release", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const first = await service.createImport(course.id, [{ relativePath: "a.md", content: "# One\n" }]);
    const firstDraft = await service.renderPlan(course.id, first.id, {
      documents: [{ path: "one.md", title: "One", sectionIds: ["a.md#0"] }],
    });
    const firstRelease = await service.publish(course.id, first.id, firstDraft.version, firstDraft.manifestHash);

    const second = await service.createImport(course.id, [{ relativePath: "b.md", content: "# One\n\n# Two\n" }]);
    await expect(service.renderPlan(course.id, second.id, {
      documents: [{ path: "one.md", title: "One", sectionIds: ["b.md#0"] }],
    })).rejects.toBeInstanceOf(KnowledgeReleaseError);
    expect((await service.getActiveRelease(course.id))?.id).toBe(firstRelease.id);
  });

  it("rejects broken relative Markdown links and rolls back by changing only the pointer", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const first = await service.createImport(course.id, [{ relativePath: "a.md", content: "# First\n" }]);
    const firstDraft = await service.renderPlan(course.id, first.id, {
      documents: [{ path: "first.md", title: "First", sectionIds: ["a.md#0"] }],
    });
    const firstRelease = await service.publish(course.id, first.id, firstDraft.version, firstDraft.manifestHash);

    const second = await service.createImport(course.id, [{ relativePath: "b.md", content: "# Second\n[missing](missing.md)\n" }]);
    const secondDraft = await service.renderPlan(course.id, second.id, {
      documents: [{ path: "second.md", title: "Second", sectionIds: ["b.md#0"] }],
    });
    await expect(service.publish(course.id, second.id, secondDraft.version, secondDraft.manifestHash)).rejects.toBeInstanceOf(KnowledgeReleaseError);
    expect((await service.getActiveRelease(course.id))?.id).toBe(firstRelease.id);

    await service.activateRelease(course.id, firstRelease.id);
    expect((await service.getActiveRelease(course.id))?.id).toBe(firstRelease.id);
  });

  it.each(["content", "tree"] as const)("refuses to use a release with modified %s", async (part) => {
    const service = await serviceForTest();
    const course = await service.createCourse("完整性校验");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# 原文\n可信内容\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const releaseDirectory = path.join(service.root, "knowledge", course.id, "releases", release.id);
    if (part === "content") {
      await writeFile(path.join(releaseDirectory, "chapter.md"), "# 原文\n篡改内容\n", "utf8");
      const knowledge = await new KnowledgeService(service.root).forCourse(course.id);
      await expect(knowledge.readLines("chapter.md", 1, 2)).rejects.toThrow(/release|unavailable|integrity/i);
      await expect(service.readReleaseContent(course.id, release.id, "chapter.md")).rejects.toThrow(/release|integrity/i);
    } else {
      await writeFile(path.join(releaseDirectory, "index", "tree.json"), "[]", "utf8");
      await expect(new KnowledgeService(service.root).forCourse(course.id)).rejects.toThrow(/release|unavailable|integrity/i);
    }
  });

  it("binds the complete per-file manifest index to the published release hash", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("索引完整性");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "trusted body\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const manifestPath = path.join(service.root, "knowledge", course.id, "releases", release.id, "index", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ contentHash: string }> };
    manifest.entries[0]!.contentHash = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(service.getActiveRelease(course.id)).rejects.toThrow(/release|manifest|integrity/i);
  });

  it("rejects unrecognized fields added to the release manifest index", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("完整索引字段");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "trusted body\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const manifestPath = path.join(service.root, "knowledge", course.id, "releases", release.id, "index", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.unbound = "not covered by the release hash";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(service.getActiveRelease(course.id)).rejects.toThrow(/release|manifest|integrity/i);
  });

  it("checks that the active pointer hash identifies the release metadata", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("指针校验");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# 原文\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const activePath = path.join(service.root, "knowledge", course.id, "active.json");
    const active = JSON.parse(await readFile(activePath, "utf8")) as { releaseId: string; manifestHash: string };
    await writeFile(activePath, JSON.stringify({ ...active, manifestHash: "0".repeat(64) }), "utf8");

    await expect(service.getActiveRelease(course.id)).rejects.toThrow(/release|manifest|integrity/i);
  });

  it("binds release tree metadata to the manifest hash referenced by active.json", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("树元数据校验");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# 原文\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const releaseDirectory = path.join(service.root, "knowledge", course.id, "releases", release.id);
    const treePath = path.join(releaseDirectory, "index", "tree.json");
    const releasePath = path.join(releaseDirectory, "index", "release.json");
    const tree = JSON.parse(await readFile(treePath, "utf8")) as Array<{ title: string }>;
    tree[0]!.title = "篡改标题";
    await writeFile(treePath, JSON.stringify(tree), "utf8");
    const metadata = JSON.parse(await readFile(releasePath, "utf8")) as { treeHash: string };
    metadata.treeHash = createHash("sha256").update(JSON.stringify(tree)).digest("hex");
    await writeFile(releasePath, JSON.stringify(metadata), "utf8");

    await expect(service.getActiveRelease(course.id)).rejects.toThrow(/release|manifest|integrity/i);
  });

  it("uses the preserved draft tree to detect a title change in a legacy release", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("旧版树校验");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# 原文\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter.md", title: "原文", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const releaseDirectory = path.join(service.root, "knowledge", course.id, "releases", release.id);
    const releasePath = path.join(releaseDirectory, "index", "release.json");
    const manifestPath = path.join(releaseDirectory, "index", "manifest.json");
    const activePath = path.join(service.root, "knowledge", course.id, "active.json");
    const metadata = JSON.parse(await readFile(releasePath, "utf8")) as Record<string, unknown>;
    delete metadata.treeHash;
    metadata.manifestHash = draft.manifestHash;
    await writeFile(releasePath, JSON.stringify(metadata), "utf8");
    await writeFile(manifestPath, JSON.stringify({ manifestHash: draft.manifestHash, files: ["chapter.md"] }), "utf8");
    await writeFile(activePath, JSON.stringify({ releaseId: release.id, manifestHash: draft.manifestHash }), "utf8");
    await expect(service.getActiveRelease(course.id)).resolves.toMatchObject({ id: release.id });
    const contentPath = path.join(releaseDirectory, "chapter.md");
    await writeFile(contentPath, "# 原文\n篡改内容\n", "utf8");
    await expect(service.readReleaseContent(course.id, release.id, "chapter.md")).rejects.toThrow(/release|manifest|integrity/i);
    await writeFile(contentPath, "# 原文\n", "utf8");
    const treePath = path.join(releaseDirectory, "index", "tree.json");
    const tree = JSON.parse(await readFile(treePath, "utf8")) as Array<{ title: string }>;
    tree[0]!.title = "篡改标题";
    await writeFile(treePath, JSON.stringify(tree), "utf8");

    await expect(service.getActiveRelease(course.id)).rejects.toThrow(/release|manifest|integrity/i);
  });

  it("rolls back to an intact earlier release by changing the active pointer", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("正常回滚");
    const firstImport = await service.createImport(course.id, [{ relativePath: "first.md", content: "# 第一版\n" }]);
    const firstDraft = await service.renderPlan(course.id, firstImport.id, {
      documents: [{ path: "chapter.md", title: "第一版", sectionIds: ["first.md#0"] }],
    });
    const first = await service.publish(course.id, firstImport.id, firstDraft.version, firstDraft.manifestHash);
    const secondImport = await service.createImport(course.id, [{ relativePath: "second.md", content: "# 第二版\n" }]);
    const secondDraft = await service.renderPlan(course.id, secondImport.id, {
      documents: [{ path: "chapter.md", title: "第二版", sectionIds: ["second.md#0"] }],
    });
    const second = await service.publish(course.id, secondImport.id, secondDraft.version, secondDraft.manifestHash);
    expect((await service.getActiveRelease(course.id))?.id).toBe(second.id);

    await service.activateRelease(course.id, first.id);

    expect((await service.getActiveRelease(course.id))?.id).toBe(first.id);
    expect(await service.readReleaseContent(course.id, first.id, "chapter.md")).toContain("第一版");
  });

  it("creates an isolated revision draft from an immutable release", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# First\nOriginal content.\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "chapter/first.md", title: "First", sectionIds: ["source.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);

    const releaseTree = await service.getReleaseTree(course.id, release.id);
    const revision = await service.createRevisionDraft(course.id, release.id);

    expect(releaseTree).toEqual([{ path: "chapter/first.md", type: "file", title: "First", sourceSectionIds: ["source.md#0"] }]);
    expect(revision.imported).toMatchObject({ courseId: course.id, status: "ready", baseReleaseId: release.id });
    expect(revision.imported.id).not.toBe(imported.id);
    expect(revision.draft.tree.map(({ path: targetPath, title }) => ({ path: targetPath, title })))
      .toEqual([{ path: "chapter/first.md", title: "First" }]);
    expect(await service.readDraftContent(course.id, revision.imported.id, "chapter/first.md")).toBe("# First\nOriginal content.\n");
    expect(await service.readReleaseContent(course.id, release.id, "chapter/first.md")).toBe("# First\nOriginal content.\n");
    expect((await service.getActiveRelease(course.id))?.id).toBe(release.id);
    expect(await service.listDrafts(course.id)).toEqual([expect.objectContaining({ id: revision.imported.id, baseReleaseId: release.id })]);
  });

  it("updates revision Markdown with optimistic versioning and a content-aware manifest", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const imported = await service.createImport(course.id, [{ relativePath: "first.md", content: "# First\nOriginal content.\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "first.md", title: "First", sectionIds: ["first.md#0"] }],
    });
    const release = await service.publish(course.id, imported.id, draft.version, draft.manifestHash);
    const revision = await service.createRevisionDraft(course.id, release.id);

    const updated = await service.updateDraftContent(
      course.id,
      revision.imported.id,
      revision.draft.version,
      "first.md",
      "# First\nRevised content.\n",
    );

    expect(updated.version).toBe(revision.draft.version + 1);
    expect(updated.manifestHash).not.toBe(revision.draft.manifestHash);
    expect(updated.tree).toEqual(revision.draft.tree);
    expect(await service.readDraftContent(course.id, revision.imported.id, "first.md")).toContain("Revised content");
    expect(await service.readReleaseContent(course.id, release.id, "first.md")).toContain("Original content");
    await expect(service.updateDraftContent(
      course.id,
      revision.imported.id,
      revision.draft.version,
      "first.md",
      "# First\nStale edit.\n",
    )).rejects.toThrow("Draft has changed");
  });

  it("preserves saved Markdown when a draft document is renamed", async () => {
    const service = await serviceForTest();
    const course = await service.createCourse("AI 与生活");
    const imported = await service.createImport(course.id, [{ relativePath: "first.md", content: "# First\nOriginal content.\n" }]);
    const draft = await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "first.md", title: "First", sectionIds: ["first.md#0"] }],
    });
    const saved = await service.updateDraftContent(course.id, imported.id, draft.version, "first.md", "# First\nTeacher revision.\n");

    const renamed = await service.editDraft(course.id, imported.id, saved.version, [{ type: "rename", path: "first.md", name: "renamed.md" }]);

    expect(renamed.tree).toEqual([expect.objectContaining({ path: "renamed.md" })]);
    expect(await service.readDraftContent(course.id, imported.id, "renamed.md")).toContain("Teacher revision");
  });
});
