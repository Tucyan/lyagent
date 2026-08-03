import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPiCourseQaAgent } from "../src/agents/course-qa/agent.js";
import { KnowledgeService } from "../src/services/knowledge-service.js";
import { MaterialService } from "../src/services/material-service.js";
import { SessionService } from "../src/services/session-service.js";
import { WebEvidenceService } from "../src/services/web-evidence-service.js";

const roots: string[] = [];

async function courseFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-qa-"));
  roots.push(root);
  const materials = new MaterialService(root);
  const course = await materials.createCourse("操作系统");
  const imported = await materials.createImport(course.id, [{ relativePath: "source.md", content: "# 进程\n进程是正在执行的程序。\n" }]);
  const draft = await materials.renderPlan(course.id, imported.id, { documents: [{ path: "第一章/进程.md", title: "进程", sectionIds: ["source.md#0"] }] });
  const release = await materials.publish(course.id, imported.id, draft.version, draft.manifestHash);
  return { root, course, release, knowledge: await new KnowledgeService(root).forCourse(course.id) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("course QA agent", () => {
  it("uses searched web evidence only after reading it and emits safe web activity", async () => {
    const { knowledge } = await courseFixture();
    const web = new WebEvidenceService(
      { search: async () => [{ title: "Official guide", url: "https://example.edu/guide", snippet: "A summary" }] },
      async (url) => ({ url, title: "Official guide", content: "First line\nA running program." }),
    );
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("web_search", { query: "what is a process", count: 5 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_web_result", { resultId: "web-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_answer", {
        answer: "A process is a running program.",
        citations: [{ type: "web", sourceId: "web-1", startLine: 2, endLine: 2 }],
        insufficient: false,
      })], { stopReason: "toolUse" }),
    ]);
    const events: unknown[] = [];

    const answer = await createPiCourseQaAgent({ models, model: faux.getModel(), knowledge, web }).answer("What is a process?", (event) => events.push(event));

    expect(answer.citations).toEqual([expect.objectContaining({ type: "web", sourceId: "web-1", title: "Official guide", url: "https://example.edu/guide", startLine: 2, endLine: 2 })]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", name: "web_search", label: "搜索网络" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", name: "read_web_result", status: "completed" }));
    expect(JSON.stringify(events)).not.toContain("A running program");
  });

  it("streams safe tool activity and accepts only citations it has read", async () => {
    const { knowledge } = await courseFixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxText("我先检索课程资料。"), fauxToolCall("search_knowledge", { query: "进程", offset: 0, maxResults: 5 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_knowledge_lines", { path: "第一章/进程.md", startLine: 1, endLine: 2 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_answer", {
        answer: "进程是正在执行的程序。",
        citations: [{ type: "knowledge", path: "第一章/进程.md", startLine: 2, endLine: 2 }],
        insufficient: false,
      })], { stopReason: "toolUse" }),
    ]);
    const events: unknown[] = [];

    const answer = await createPiCourseQaAgent({ models, model: faux.getModel(), knowledge }).answer("什么是进程？", (event) => events.push(event));

    expect(answer).toMatchObject({ answer: "进程是正在执行的程序。", insufficient: false, citations: [{ type: "knowledge", path: "第一章/进程.md", startLine: 2, endLine: 2 }] });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", name: "search_knowledge", label: "搜索课程资料" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", name: "read_knowledge_lines", status: "completed" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "answer_delta", delta: "我先检索课程资料。" }));
    expect(JSON.stringify(events)).not.toContain("正在执行的程序");
    expect(JSON.stringify(events)).not.toContain("submit_answer");
  });

  it("keeps web sessions course-bound and writes an assistant answer only after completion", async () => {
    const { root, course, release } = await courseFixture();
    const sessions = new SessionService(root);
    const session = await sessions.create(course.id, release.id);

    await sessions.appendCompletedTurn(course.id, session.id, { role: "user", content: "什么是进程？" }, { role: "assistant", content: "进程是正在执行的程序。", citations: [] });

    await expect(sessions.get(course.id, session.id)).resolves.toMatchObject({ releaseId: release.id, messages: [{ role: "user" }, { role: "assistant" }] });
    await expect(sessions.get("00000000-0000-4000-8000-000000000000", session.id)).rejects.toThrow("Session was not found");
  });

  it("reads legacy knowledge citations as typed citations for historical sessions", async () => {
    const { root, course, release } = await courseFixture();
    const sessions = new SessionService(root);
    const session = await sessions.create(course.id, release.id);
    await writeFile(path.join(root, "sessions", "web", course.id, `${session.id}.json`), JSON.stringify({
      ...session,
      messages: [{ role: "assistant", content: "Legacy answer", citations: [{ path: "第一章/进程.md", startLine: 2, endLine: 2 }] }],
    }), "utf8");

    await expect(sessions.get(course.id, session.id)).resolves.toMatchObject({
      messages: [{ role: "assistant", citations: [{ type: "knowledge", path: "第一章/进程.md", startLine: 2, endLine: 2 }] }],
    });
  });
});
