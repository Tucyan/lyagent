import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";

const roots: string[] = [];

async function serverForTest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-api-"));
  roots.push(root);
  return createServer({ workspaceRoot: root, materialPlanner: async (sections) => ({
    documents: [{ path: "01-课程/资料.md", title: "资料", sectionIds: sections.map((section) => section.id) }],
  }) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("material import API", () => {
  it("reports model configuration without exposing credentials", async () => {
    const app = await serverForTest();
    const response = await app.inject({ method: "GET", url: "/api/system/model" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", configured: false });
    expect(response.body).not.toContain("DEEPSEEK_API_KEY");
    await app.close();
  });

  it("creates, processes, previews, publishes, and activates a course release", async () => {
    const app = await serverForTest();
    const created = await app.inject({ method: "POST", url: "/api/courses", payload: { name: "测试课程" } });
    expect(created.statusCode).toBe(201);
    const course = created.json() as { id: string };

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/courses/${course.id}/imports`,
      payload: { files: [{ relativePath: "slides/one.md", content: "# 第一课\n正文" }] },
    });
    expect(uploaded.statusCode).toBe(201);
    const imported = uploaded.json() as { id: string; draftVersion: number; manifestHash: string };

    const tree = await app.inject({ method: "GET", url: `/api/courses/${course.id}/imports/${imported.id}/tree` });
    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toMatchObject({ version: 1, tree: [{ path: "01-课程/资料.md" }] });

    const edited = await app.inject({
      method: "PATCH", url: `/api/courses/${course.id}/imports/${imported.id}/tree`,
      payload: { expectedVersion: 1, operations: [{ type: "rename", path: "01-课程/资料.md", name: "课程资料.md" }] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ version: 2, tree: [{ path: "01-课程/课程资料.md" }] });

    const rerun = await app.inject({ method: "POST", url: `/api/courses/${course.id}/imports/${imported.id}/rerun` });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json()).toMatchObject({ version: 3 });
    const rerunDraft = rerun.json() as { version: number; manifestHash: string };

    const published = await app.inject({
      method: "POST",
      url: `/api/courses/${course.id}/imports/${imported.id}/publish`,
      payload: { expectedVersion: rerunDraft.version, expectedManifestHash: rerunDraft.manifestHash },
    });
    expect(published.statusCode).toBe(201);
    const release = published.json() as { id: string };

    const active = await app.inject({ method: "GET", url: `/api/courses/${course.id}/active` });
    expect(active.json()).toMatchObject({ id: release.id });
    await app.close();
  });

  it("returns conflict for a stale publish request without leaking filesystem paths", async () => {
    const app = await serverForTest();
    const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "测试课程" } })).json() as { id: string };
    const imported = (await app.inject({
      method: "POST", url: `/api/courses/${course.id}/imports`, payload: { files: [{ relativePath: "one.md", content: "# One" }] },
    })).json() as { id: string; manifestHash: string };

    const response = await app.inject({
      method: "POST", url: `/api/courses/${course.id}/imports/${imported.id}/publish`,
      payload: { expectedVersion: 0, expectedManifestHash: imported.manifestHash },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CONFLICT" });
    expect(response.body).not.toContain("course-agent-api-");
    await app.close();
  });

  it("browses a release and edits an isolated revision through the API", async () => {
    const app = await serverForTest();
    const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "测试课程" } })).json() as { id: string };
    const imported = (await app.inject({
      method: "POST",
      url: `/api/courses/${course.id}/imports`,
      payload: { files: [{ relativePath: "one.md", content: "# One\nOriginal content.\n" }] },
    })).json() as { id: string; draftVersion: number; manifestHash: string };
    const published = await app.inject({
      method: "POST",
      url: `/api/courses/${course.id}/imports/${imported.id}/publish`,
      payload: { expectedVersion: imported.draftVersion, expectedManifestHash: imported.manifestHash },
    });
    const release = published.json() as { id: string };

    const releaseTree = await app.inject({ method: "GET", url: `/api/courses/${course.id}/releases/${release.id}/tree` });
    expect(releaseTree.statusCode).toBe(200);
    expect(releaseTree.json()).toEqual([expect.objectContaining({ path: "01-课程/资料.md" })]);

    const createdRevision = await app.inject({ method: "POST", url: `/api/courses/${course.id}/releases/${release.id}/revisions` });
    expect(createdRevision.statusCode).toBe(201);
    const revision = createdRevision.json() as { id: string; draftVersion: number; manifestHash: string; baseReleaseId: string };
    expect(revision).toMatchObject({ baseReleaseId: release.id, draftVersion: 1 });

    const drafts = await app.inject({ method: "GET", url: `/api/courses/${course.id}/drafts` });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json()).toEqual([expect.objectContaining({ id: revision.id, baseReleaseId: release.id })]);

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/courses/${course.id}/imports/${revision.id}/content`,
      payload: { expectedVersion: revision.draftVersion, path: "01-课程/资料.md", content: "# One\nRevised content.\n" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 2 });
    expect((saved.json() as { manifestHash: string }).manifestHash).not.toBe(revision.manifestHash);

    const unchangedRelease = await app.inject({
      method: "GET",
      url: `/api/courses/${course.id}/releases/${release.id}/content?path=${encodeURIComponent("01-课程/资料.md")}`,
    });
    expect(unchangedRelease.body).toContain("Original content");
    expect(unchangedRelease.body).not.toContain("Revised content");

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/courses/${course.id}/imports/${revision.id}/content`,
      payload: { expectedVersion: revision.draftVersion, path: "01-课程/资料.md", content: "# One\nStale content.\n" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CONFLICT" });
    expect(stale.body).not.toContain("course-agent-api-");
    await app.close();
  });
});
