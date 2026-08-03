import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";

const roots: string[] = [];

type TestServer = Awaited<ReturnType<typeof createServer>>;

async function serverForTest(): Promise<{ app: TestServer; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-dashboard-api-"));
  roots.push(root);
  const app = await createServer({
    workspaceRoot: root,
    modelStatus: { provider: "deepseek", model: "deepseek-test", configured: true },
    materialPlanner: async (sections) => ({
      documents: [{ path: "module/notes.md", title: "Notes", sectionIds: sections.map((section) => section.id) }],
    }),
  });
  return { app, root };
}

async function createCourse(app: TestServer, name: string) {
  const created = await app.inject({ method: "POST", url: "/api/courses", payload: { name } });
  expect(created.statusCode).toBe(201);
  return created.json() as { id: string; name: string; createdAt: string };
}

async function publishCourse(app: TestServer, name: string) {
  const course = await createCourse(app, name);
  const imported = (await app.inject({
    method: "POST",
    url: `/api/courses/${course.id}/imports`,
    payload: { files: [{ relativePath: "source.md", content: "# Notes\nTOP_SECRET_SOURCE_TEXT" }] },
  })).json() as { id: string; draftVersion: number; manifestHash: string };
  const published = await app.inject({
    method: "POST",
    url: `/api/courses/${course.id}/imports/${imported.id}/publish`,
    payload: { expectedVersion: imported.draftVersion, expectedManifestHash: imported.manifestHash },
  });
  expect(published.statusCode).toBe(201);
  return { course, release: published.json() as { id: string; createdAt: string } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dashboard API", () => {
  it("returns zero-valued real metrics for an empty workspace", async () => {
    const { app } = await serverForTest();

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: { provider: "deepseek", model: "deepseek-test", configured: true },
      totals: { courses: 0, publishedCourses: 0, activeDocuments: 0, qaSessions: 0 },
      courses: [],
      recentActivity: [],
    });
    await app.close();
  });

  it("aggregates only active release metadata and safe session summaries", async () => {
    const { app } = await serverForTest();
    const draftOnly = await createCourse(app, "Draft only");
    const { course, release } = await publishCourse(app, "Published");
    const session = (await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions` })).json() as { id: string };
    await app.inject({ method: "PATCH", url: `/api/courses/${course.id}/qa/sessions/${session.id}`, payload: { title: "Review release" } });

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(200);
    const snapshot = response.json() as { totals: unknown; courses: unknown[]; recentActivity: unknown[] };
    expect(snapshot.totals).toMatchObject({ courses: 2, publishedCourses: 1, activeDocuments: 1, qaSessions: 1 });
    expect(snapshot.courses).toContainEqual(expect.objectContaining({ id: draftOnly.id, knowledgeStatus: "unpublished", releaseCount: 0, documentCount: 0, qaSessionCount: 0 }));
    expect(snapshot.courses).toContainEqual(expect.objectContaining({ id: course.id, knowledgeStatus: "published", activeRelease: expect.objectContaining({ id: release.id }), releaseCount: 1, documentCount: 1, qaSessionCount: 1 }));
    expect(snapshot.recentActivity).toContainEqual(expect.objectContaining({ type: "course_created", courseId: course.id }));
    expect(snapshot.recentActivity).toContainEqual(expect.objectContaining({ type: "release_published", courseId: course.id, releaseId: release.id }));
    expect(snapshot.recentActivity).toContainEqual(expect.objectContaining({ type: "qa_session_updated", courseId: course.id, sessionId: session.id, summary: "Review release" }));
    expect(response.body).not.toContain("TOP_SECRET_SOURCE_TEXT");
    expect(response.body).not.toContain("course-agent-dashboard-api-");
    await app.close();
  });

  it("limits sorted activity and isolates an unavailable active release", async () => {
    const { app, root } = await serverForTest();
    const first = await publishCourse(app, "First");
    const second = await publishCourse(app, "Second");
    const third = await publishCourse(app, "Third");
    for (const item of [first, second, third]) {
      const session = (await app.inject({ method: "POST", url: `/api/courses/${item.course.id}/qa/sessions` })).json() as { id: string };
      await app.inject({ method: "PATCH", url: `/api/courses/${item.course.id}/qa/sessions/${session.id}`, payload: { title: `Session ${item.course.name}` } });
    }
    await writeFile(path.join(root, "knowledge", second.course.id, "releases", second.release.id, "index", "tree.json"), "not json", "utf8");

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });
    const snapshot = response.json() as { courses: Array<{ id: string; knowledgeStatus: string }>; recentActivity: Array<{ at: string }> };

    expect(response.statusCode).toBe(200);
    expect(snapshot.courses).toContainEqual(expect.objectContaining({ id: second.course.id, knowledgeStatus: "unavailable" }));
    expect(snapshot.recentActivity).toHaveLength(8);
    expect(snapshot.recentActivity.every((activity, index, all) => index === 0 || all[index - 1]!.at >= activity.at)).toBe(true);
    await app.close();
  });
});
