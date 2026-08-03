import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeReleaseError, MaterialService } from "../src/services/material-service.js";

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
