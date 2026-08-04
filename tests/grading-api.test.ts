import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import { createServer } from "../src/api/server.js";
import type { Rubric } from "../src/schemas/rubric.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const rubric: Rubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 10,
  partialCreditAllowed: true,
  criteria: [{
    id: "C1", name: "内容", maxScore: 10, description: "内容质量",
    scorePolicy: "range", evidenceRequired: true,
    levels: [{ id: "L1", minScore: 5, maxScore: 10, condition: "完整" }, { id: "L0", minScore: 0, maxScore: 4.99, condition: "缺失" }],
  }],
};

describe("grading API", () => {
  it("creates a course-bound Markdown session and supports versioned editing", async () => {
    const { app, assignmentId } = await setup();
    const created = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001", autoStartAfterConversion: "false" }, "20260001_张晓明.md", "# AI 与生活\n\n正文"),
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json();
    expect(session).toMatchObject({ courseId: expect.any(String), conversionStatus: "ready", gradingStatus: "not_started", submissionVersion: 1 });

    const read = await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}` });
    expect(read.json().submission.markdown).toContain("AI 与生活");
    const edited = await app.inject({ method: "PUT", url: `/api/grading/sessions/${session.id}/submission`, payload: { expectedVersion: 1, markdown: "# 已修订\n\n正文" } });
    expect(edited.json().submissionVersion).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/grading/rubrics" })).json()).toHaveLength(1);
    await app.close();
  });

  it("rejects legacy .doc with an actionable 415 response", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001" }, "report.doc", "legacy"),
    });
    expect(response.statusCode, response.body).toBe(415);
    expect(response.json()).toMatchObject({ code: "UNSUPPORTED_SUBMISSION_TYPE" });
    expect(response.json().message).toContain(".docx");
    await app.close();
  });

  it("returns 422 for incomplete student identity instead of an internal error", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "" }, "report.md", "# 报告"),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "STUDENT_IDENTITY_ERROR" });
    await app.close();
  });

  it("returns 503 before locking the submission when no grading model is configured", async () => {
    const { app, assignmentId } = await setup();
    const created = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001" }, "report.md", "# 报告"),
    });
    const session = created.json();
    const response = await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/runs`, payload: { message: "开始" } });
    expect(response.statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}` })).json().gradingStatus).toBe("not_started");
    const autoStart = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "李华", studentNumber: "20260002", autoStartAfterConversion: "true" }, "report.md", "# 报告"),
    });
    expect(autoStart.statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/grading/sessions" })).json()).toHaveLength(1);
    await app.close();
  });

  it("streams replayable grading events and exposes the persisted conversation", async () => {
    const grader: PiAssignmentGrader = {
      async run(_request, emit) {
        emit?.({ type: "process_delta", delta: "正在核对评分证据。" });
        emit?.({ type: "reply_delta", delta: "已完成核对。" });
        return { kind: "reply", reply: "已完成核对。" };
      },
    };
    const { app, assignmentId } = await setup(() => grader);
    const created = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001" }, "report.md", "# 报告"),
    });
    const session = created.json();
    const runResponse = await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/messages`, payload: { message: "解释评分" } });
    const run = runResponse.json();
    const events = await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=true` });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("event: process_delta");
    expect(events.body).toContain("event: final");
    const detail = (await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}` })).json();
    expect(detail.conversation.messages.at(-1)).toMatchObject({ role: "assistant", processCollapsed: true });
    await app.close();
  });

  it("maps program-owned grading validation failures to 422", async () => {
    const grader: PiAssignmentGrader = { async run() { return { kind: "question", question: { question: "请确认", options: ["确认"] } }; } };
    const { app, assignmentId } = await setup(() => grader);
    const session = (await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001" }, "report.md", "# 报告"),
    })).json();
    const run = (await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/runs`, payload: { message: "开始" } })).json();
    await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=true` });
    const response = await app.inject({ method: "PUT", url: `/api/grading/sessions/${session.id}/draft`, payload: { expectedVersion: 0, note: "人工修订", draft: { schemaVersion: "1.0", mode: "additive", criteria: [{ criterionId: "C1", score: 8, reason: "缺少等级", evidence: [{ kind: "text", path: "submission-v1.md", heading: "报告", startLine: 1, endLine: 1, quote: "# 报告" }], confidence: 0.9 }], strengths: [], improvements: [], warnings: [] } } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "GRADING_RESULT_INVALID" });
    await app.close();
  });

  it("cancels an active grading run through the public API", async () => {
    const grader: PiAssignmentGrader = {
      async run(_request, _emit, signal) {
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
        return { kind: "reply", reply: "unreachable" };
      },
    };
    const { app, assignmentId } = await setup(() => grader);
    const created = await app.inject({
      method: "POST", url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", { assignmentId, rubricVersion: "1", studentName: "张晓明", studentNumber: "20260001" }, "report.md", "# 报告"),
    });
    const session = created.json();
    const run = (await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/runs`, payload: { message: "开始批改" } })).json();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelled = await app.inject({ method: "POST", url: `/api/agent-runs/${run.id}/cancel` });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ cancelled: true });
    const events = await app.inject({ method: "GET", url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=false` });
    expect(events.body).toContain("event: cancelled");
    const retry = await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/runs`, payload: { message: "重试批改" } });
    expect(retry.statusCode, retry.body).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.inject({ method: "POST", url: `/api/agent-runs/${retry.json().id}/cancel` });
    const revision = await app.inject({ method: "POST", url: `/api/grading/sessions/${session.id}/revisions` });
    expect(revision.statusCode, revision.body).toBe(201);
    expect(revision.json()).toMatchObject({ gradingStatus: "not_started", studentNumber: "20260001" });
    await app.close();
  });
});

async function setup(graderFactory?: () => PiAssignmentGrader) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-api-"));
  roots.push(root);
  const app = await createServer({ workspaceRoot: root, ...(graderFactory ? { gradingAgentFactory: graderFactory } : {}) });
  const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "唯一课程" } })).json();
  expect(course.id).toBeTruthy();
  const assignmentResponse = await app.inject({ method: "POST", url: "/api/rubrics/assignments", payload: { title: "评分表", totalScore: 10, requirements: "评价报告。", sources: [] } });
  expect(assignmentResponse.statusCode, assignmentResponse.body).toBe(201);
  const assignment = assignmentResponse.json();
  const modeResponse = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
  expect(modeResponse.statusCode, modeResponse.body).toBe(200);
  const draftResponse = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
  expect(draftResponse.statusCode, draftResponse.body).toBe(200);
  const freezeResponse = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: [] } });
  expect(freezeResponse.statusCode, freezeResponse.body).toBe(201);
  return { app, assignmentId: assignment.id };
}

function multipart(boundary: string, fields: Record<string, string>, filename: string, content: string): Buffer {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}
