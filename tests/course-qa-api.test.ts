import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type CourseQaAgentFactory } from "../src/api/server.js";
import { WebEvidenceService } from "../src/services/web-evidence-service.js";

const roots: string[] = [];

const fakeQaAgent: CourseQaAgentFactory = () => ({
  answer: async (_question, onEvent) => {
    onEvent?.({ type: "tool_start", id: "search-1", name: "search_knowledge", label: "搜索课程资料", summary: "搜索相关课程资料" });
    onEvent?.({ type: "tool_end", id: "search-1", name: "search_knowledge", label: "搜索课程资料", summary: "搜索相关课程资料", status: "completed" });
    onEvent?.({ type: "answer_delta", delta: "进程是正在执行的程序。" });
    return { answer: "进程是正在执行的程序。", citations: [{ type: "knowledge", path: "第一章/进程.md", startLine: 2, endLine: 2 }], insufficient: false };
  },
});

async function serverForTest(withAgent = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-qa-api-"));
  roots.push(root);
  return createServer({
    workspaceRoot: root,
    materialPlanner: async (sections) => ({ documents: [{ path: "第一章/进程.md", title: "进程", sectionIds: sections.map((section) => section.id) }] }),
    ...(withAgent ? { courseQaAgentFactory: fakeQaAgent } : {}),
  });
}

async function publishedCourse(app: Awaited<ReturnType<typeof serverForTest>>) {
  const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "操作系统" } })).json() as { id: string };
  const imported = (await app.inject({ method: "POST", url: `/api/courses/${course.id}/imports`, payload: { files: [{ relativePath: "source.md", content: "# 进程\n进程是正在执行的程序。\n" }] } })).json() as { id: string; draftVersion: number; manifestHash: string };
  await app.inject({ method: "POST", url: `/api/courses/${course.id}/imports/${imported.id}/publish`, payload: { expectedVersion: imported.draftVersion, expectedManifestHash: imported.manifestHash } });
  return course;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("course QA API", () => {
  it("renames and deletes a course-bound QA session", async () => {
    const app = await serverForTest();
    const course = await publishedCourse(app);
    const created = (await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions` })).json() as { id: string };

    const renamed = await app.inject({ method: "PATCH", url: `/api/courses/${course.id}/qa/sessions/${created.id}`, payload: { title: "复习重点" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: created.id, title: "复习重点" });

    const summaries = await app.inject({ method: "GET", url: `/api/courses/${course.id}/qa/sessions` });
    expect(summaries.json()).toEqual([expect.objectContaining({ id: created.id, summary: "复习重点" })]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/courses/${course.id}/qa/sessions/${created.id}` });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/courses/${course.id}/qa/sessions/${created.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("reports an empty declared JSON body as a client error", async () => {
    const app = await serverForTest();
    const course = await publishedCourse(app);

    const created = await app.inject({
      method: "POST",
      url: `/api/courses/${course.id}/qa/sessions`,
      headers: { "content-type": "application/json", "content-length": "0" },
      payload: "",
    });

    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ code: "FST_ERR_CTP_EMPTY_JSON_BODY" });
    await app.close();
  });

  it("passes a fresh web evidence context only when network search is requested", async () => {
    const web = new WebEvidenceService({ search: async () => [] }, async (url) => ({ url, title: "", content: "" }));
    const factory = vi.fn<CourseQaAgentFactory>(() => ({ answer: async () => ({ answer: "Not enough information.", citations: [], insufficient: true }) }));
    const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-qa-api-"));
    roots.push(root);
    const app = await createServer({
      workspaceRoot: root,
      materialPlanner: async (sections) => ({ documents: [{ path: "第一章/进程.md", title: "进程", sectionIds: sections.map((section) => section.id) }] }),
      courseQaAgentFactory: factory,
      webEvidenceFactory: () => web,
    });
    const course = await publishedCourse(app);
    const session = (await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions` })).json() as { id: string };

    await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions/${session.id}/messages/stream`, payload: { question: "What is current?", allowWebSearch: true } });

    expect(factory).toHaveBeenCalledWith(expect.anything(), web);
    await app.close();
  });

  it("streams tool activity and persists a verified answer only after final", async () => {
    const app = await serverForTest();
    const course = await publishedCourse(app);
    const active = await app.inject({ method: "GET", url: `/api/courses/${course.id}/qa/active` });
    expect(active.json()).toMatchObject({ documents: [{ path: "第一章/进程.md", title: "进程" }] });
    const created = await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions` });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string };

    const streamed = await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions/${session.id}/messages/stream`, payload: { question: "什么是进程？" } });

    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.body).toContain("event: tool_start");
    expect(streamed.body).toContain("event: answer_delta");
    expect(streamed.body).toContain("event: final");
    expect(streamed.body).not.toContain("course-agent-qa-api-");
    const saved = await app.inject({ method: "GET", url: `/api/courses/${course.id}/qa/sessions/${session.id}` });
    expect(saved.json()).toMatchObject({ messages: [{ role: "user" }, { role: "assistant", citations: [{ type: "knowledge", path: "第一章/进程.md" }] }] });
    const summaries = await app.inject({ method: "GET", url: `/api/courses/${course.id}/qa/sessions` });
    expect(summaries.json()).toEqual([expect.objectContaining({ id: session.id, summary: "什么是进程？" })]);
    await app.close();
  });

  it("rejects a stream without an active release or configured model", async () => {
    const app = await serverForTest(false);
    const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "空课程" } })).json() as { id: string };
    const noRelease = await app.inject({ method: "POST", url: `/api/courses/${course.id}/qa/sessions` });
    expect(noRelease.statusCode).toBe(409);

    const readyCourse = await publishedCourse(app);
    const session = (await app.inject({ method: "POST", url: `/api/courses/${readyCourse.id}/qa/sessions` })).json() as { id: string };
    const noModel = await app.inject({ method: "POST", url: `/api/courses/${readyCourse.id}/qa/sessions/${session.id}/messages/stream`, payload: { question: "什么是进程？" } });
    expect(noModel.statusCode).toBe(503);
    await app.close();
  });
});
