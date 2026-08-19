import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { PiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import type { GradingAgentBuilder } from "../src/api/grading-routes.js";
import { createServer } from "../src/api/server.js";
import type { Rubric } from "../src/schemas/rubric.js";
import {
  ConversionUnavailableError,
  type ConversionTaskStatus,
  type DocumentConversionClient,
} from "../src/services/document-conversion-client.js";
import type { SubmissionConversionOptions } from "../src/services/submission-conversion-service.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const rubric: Rubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 10,
  partialCreditAllowed: true,
  criteria: [
    {
      id: "C1",
      name: "内容",
      maxScore: 10,
      description: "内容质量",
      scorePolicy: "range",
      evidenceRequired: true,
      levels: [
        { id: "L1", minScore: 5, maxScore: 10, condition: "完整" },
        { id: "L0", minScore: 0, maxScore: 4.99, condition: "缺失" },
      ],
    },
  ],
};

describe("grading API", () => {
  it("persists, resumes, and idempotently commits a batch upload draft", async () => {
    const grader: GradingAgentBuilder = () => ({
      async run() { return { kind: "reply", reply: "ready" }; },
    });
    const { app, assignmentId, root } = await setup(grader);
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/batch-uploads",
      payload: {
        title: "可恢复批次",
        assignmentId,
        rubricVersion: 1,
        concurrency: 2,
        items: [{ filename: "20260001_张晓明_校园AI报告.md" }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json();
    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/grading/batch-uploads/${draft.id}/items/${draft.items[0].id}/file`,
      headers: { "content-type": "multipart/form-data; boundary=draft" },
      payload: multipartWithAssets("draft", {
        assetManifest: "[]",
      }, {
        filename: "20260001_张晓明_校园AI报告.md",
        bytes: Buffer.from("# 校园 AI 报告\n\n正文"),
      }, []),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    let detail: any;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/grading/batch-uploads/${draft.id}` })).json();
      if (detail.items[0].status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(detail.items[0]).toMatchObject({ status: "ready", studentNumber: "20260001" });
    const committed = await app.inject({ method: "POST", url: `/api/grading/batch-uploads/${draft.id}/commit` });
    expect(committed.statusCode, committed.body).toBe(201);
    const repeated = await app.inject({ method: "POST", url: `/api/grading/batch-uploads/${draft.id}/commit` });
    expect(repeated.statusCode, repeated.body).toBe(201);
    expect(repeated.json().id).toBe(committed.json().id);
    await app.close();

    const reopened = await createServer({ workspaceRoot: root });
    const restored = await reopened.inject({ method: "GET", url: `/api/grading/batch-uploads/${draft.id}` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ status: "committed", committedBatchId: committed.json().id });
    await reopened.close();
  });

  it("uploads a Markdown report with nested image assets and a manifest", async () => {
    const { app, assignmentId } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=assets" },
      payload: multipartWithAssets("assets", {
        assignmentId,
        rubricVersion: "1",
        studentName: "",
        studentNumber: "",
        submissionTitle: "共享图片报告",
        assetManifest: JSON.stringify(["assets/charts/chart.png"]),
      }, {
        filename: "20260001_张晓明_共享图片报告.md",
        bytes: Buffer.from("# 报告\n\n![图表](assets/charts/chart.png)\n"),
      }, [{ filename: "chart.png", bytes: png }]),
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ studentName: "张晓明", studentNumber: "20260001" });
    const asset = await app.inject({
      method: "GET",
      url: `/api/grading/sessions/${response.json().id}/assets/charts/chart.png`,
    });
    expect(asset.statusCode, asset.body).toBe(200);
    expect(asset.rawPayload).toEqual(png);
    await app.close();
  });

  it("creates a one-report batch through the public API", async () => {
    const grader: GradingAgentBuilder = () => ({
      async run() { return { kind: "reply", reply: "ready" }; },
    });
    const { app, assignmentId } = await setup(grader);
    const session = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", {
        assignmentId,
        rubricVersion: "1",
        studentName: "张晓明",
        studentNumber: "20260001",
        submissionTitle: "同名报告",
      }, "20260001_张晓明_同名报告.md", "# 报告"),
    });
    expect(session.statusCode, session.body).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/api/grading/batches",
      payload: {
        title: "单份批次",
        assignmentId,
        rubricVersion: 1,
        concurrency: 1,
        sessionIds: [session.json().id],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ totalJobs: 1 });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/grading/batches",
      payload: {
        title: "空批次",
        assignmentId,
        rubricVersion: 1,
        concurrency: 1,
        sessionIds: [],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "请求参数无效，请检查标出的字段",
      issues: [{ path: "sessionIds" }],
    });
    await app.close();
  });

  it("creates, runs, inspects, and exports a 30-report batch", async () => {
    let asked = false;
    const grader: GradingAgentBuilder = (sessionId, runId, services) => ({
      async run() {
        if (!asked) {
          asked = true;
          return { kind: "question", question: { question: "附件是否为必交项？", options: ["是", "否"] } };
        }
        const currentDraft = await services.results.readDraft(sessionId);
        const stored = await services.results.submitDraft(sessionId, currentDraft?.version ?? 0, {
          schemaVersion: "1.0",
          mode: "additive",
          criteria: [{
            criterionId: "C1",
            selectedLevelId: "L1",
            score: 8,
            reason: "内容达到主要要求",
            evidence: [{ kind: "analysis", observation: "报告有完整正文", rubricBasis: "对应内容质量标准", scoreJustification: "达到良好但仍可完善" }],
            confidence: 0.9,
          }],
          strengths: ["结构清楚"],
          improvements: ["增加细节"],
          warnings: [],
        }, { type: "agent", id: runId });
        return { kind: "draft", draft: stored };
      },
    });
    const { app, assignmentId, root } = await setup(grader);
    const sessionIds: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/grading/sessions",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload: multipart("x", {
          assignmentId,
          rubricVersion: "1",
          studentName: `学生${index}`,
          studentNumber: `2026${String(index).padStart(4, "0")}`,
          submissionTitle: `批量报告${index}`,
        }, `2026${String(index).padStart(4, "0")}_学生${index}.md`, `# 批量报告${index}\n\n合成正文`),
      });
      expect(response.statusCode, response.body).toBe(201);
      sessionIds.push(response.json().id);
    }
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/batches",
      payload: { title: "一班批量报告", assignmentId, rubricVersion: 1, concurrency: 4, sessionIds },
    });
    expect(created.statusCode, created.body).toBe(201);
    const batch = created.json();
    expect(batch).toMatchObject({ status: "draft", totalJobs: 30, concurrency: 4 });
    const reservedDelete = await app.inject({ method: "DELETE", url: `/api/grading/sessions/${sessionIds[0]}` });
    expect(reservedDelete.statusCode, reservedDelete.body).toBe(409);
    const preserved = await app.inject({ method: "GET", url: `/api/grading/sessions/${sessionIds[0]}` });
    expect(preserved.statusCode, preserved.body).toBe(200);
    expect(preserved.json().submission.markdown).toContain("合成正文");
    const reservationDb = new Database(path.join(root, "grading.sqlite"));
    reservationDb.prepare("UPDATE grading_batch_jobs SET status = 'cancelled' WHERE session_id = ?").run(sessionIds[0]);
    reservationDb.close();
    const cancelledReservedDelete = await app.inject({ method: "DELETE", url: `/api/grading/sessions/${sessionIds[0]}` });
    expect(cancelledReservedDelete.statusCode, cancelledReservedDelete.body).toBe(409);
    const cancelledPreserved = await app.inject({ method: "GET", url: `/api/grading/sessions/${sessionIds[0]}` });
    expect(cancelledPreserved.json().submission.markdown).toContain("合成正文");
    const restoreDb = new Database(path.join(root, "grading.sqlite"));
    restoreDb.prepare("UPDATE grading_batch_jobs SET status = 'pending' WHERE session_id = ?").run(sessionIds[0]);
    restoreDb.close();
    const reservedDirectRun = await app.inject({ method: "POST", url: `/api/grading/sessions/${sessionIds[0]}/runs`, payload: { message: "绕过批次直接开始" } });
    expect(reservedDirectRun.statusCode, reservedDirectRun.body).toBe(409);
    expect(reservedDirectRun.json().message).toMatch(/reserved by a batch/i);
    expect((await app.inject({ method: "POST", url: `/api/grading/batches/${batch.id}/start` })).statusCode).toBe(202);
    let detail: Record<string, any> = {};
    for (let attempt = 0; attempt < 400; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/grading/batches/${batch.id}` })).json();
      if (detail.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail).toMatchObject({ status: "completed", counts: { waiting_for_teacher: 1, needs_review: 29, failed: 0 } });
    const waitingJob = detail.jobs.find((job: { status: string }) => job.status === "waiting_for_teacher");
    const answered = await app.inject({ method: "POST", url: `/api/grading/batches/${batch.id}/jobs/${waitingJob.id}/answer`, payload: { answer: "否，附件不是必交项" } });
    expect(answered.statusCode, answered.body).toBe(202);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/grading/batches/${batch.id}` })).json();
      if (detail.counts.needs_review === 30) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail).toMatchObject({ status: "completed", counts: { waiting_for_teacher: 0, needs_review: 30, failed: 0 } });
    const confirmJob = detail.jobs.find((job: { status: string }) => job.status === "needs_review");
    expect(confirmJob).toMatchObject({
      score: { earned: 8, possible: 10 },
      confidence: { overall: 0.9 },
      reviewStatus: "needs_review",
      resultVersion: 1,
    });
    const wrongBatchId = `${batch.id.slice(0, -1)}${batch.id.endsWith("0") ? "1" : "0"}`;
    const mismatchedConfirm = await app.inject({
      method: "POST",
      url: `/api/grading/batches/${wrongBatchId}/jobs/${confirmJob.id}/confirm`,
      payload: { expectedVersion: confirmJob.resultVersion, reviewNote: "批次复核确认", acknowledgedReasons: confirmJob.reviewReasons },
    });
    expect(mismatchedConfirm.statusCode).toBe(404);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/grading/batches/${batch.id}/jobs/${confirmJob.id}/confirm`,
      payload: { expectedVersion: confirmJob.resultVersion, reviewNote: "批次复核确认", acknowledgedReasons: confirmJob.reviewReasons },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    detail = (await app.inject({ method: "GET", url: `/api/grading/batches/${batch.id}` })).json();
    expect(detail.counts).toMatchObject({ needs_review: 29, completed: 1 });
    const exported = await app.inject({ method: "GET", url: `/api/grading/batches/${batch.id}/export.csv` });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("batch-grading-summary.csv");
    expect(exported.body.split("\r\n").filter(Boolean)).toHaveLength(31);
    await app.close();
  }, 15_000);

  it("creates a course-bound Markdown session and supports versioned editing", async () => {
    const { app, assignmentId } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "20260001",
          autoStartAfterConversion: "false",
        },
        "20260001_张晓明.md",
        "# AI 与生活\n\n正文",
      ),
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json();
    expect(session).toMatchObject({
      courseId: expect.any(String),
      conversionStatus: "ready",
      gradingStatus: "not_started",
      submissionVersion: 1,
      submissionTitle: "自动识别作业",
      submissionTitleStatus: "resolved",
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/grading/sessions/${session.id}`,
    });
    expect(read.json().submission.markdown).toContain("AI 与生活");
    const edited = await app.inject({
      method: "PUT",
      url: `/api/grading/sessions/${session.id}/submission`,
      payload: { expectedVersion: 1, markdown: "# 已修订\n\n正文" },
    });
    expect(edited.json().submissionVersion).toBe(2);
    expect(
      (await app.inject({ method: "GET", url: "/api/grading/rubrics" })).json(),
    ).toHaveLength(1);
    await app.close();
  });

  it("rejects legacy .doc with an actionable 415 response", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "20260001",
        },
        "report.doc",
        "legacy",
      ),
    });
    expect(response.statusCode, response.body).toBe(415);
    expect(response.json()).toMatchObject({
      code: "UNSUPPORTED_SUBMISSION_TYPE",
    });
    expect(response.json().message).toContain(".docx");
    await app.close();
  });

  it("reports a provider-neutral error when a convertible upload has no converter", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart("x", {
        assignmentId,
        rubricVersion: "1",
        studentName: "Student",
        studentNumber: "20260003",
        submissionTitle: "Report",
      }, "report.pdf", "%PDF-1.7 synthetic"),
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ code: "CONVERTER_NOT_CONFIGURED" });
    expect(response.body).not.toMatch(/mineru/i);
    await app.close();
  });

  it("returns 422 for incomplete student identity instead of an internal error", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "",
        },
        "report.md",
        "# 报告",
      ),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "STUDENT_IDENTITY_FIELDS_REQUIRED",
      issues: [
        { path: "studentName" },
        { path: "studentNumber" },
      ],
    });
    await app.close();
  });

  it("returns 503 before locking the submission when no grading model is configured", async () => {
    const { app, assignmentId } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "20260001",
        },
        "report.md",
        "# 报告",
      ),
    });
    const session = created.json();
    const response = await app.inject({
      method: "POST",
      url: `/api/grading/sessions/${session.id}/runs`,
      payload: { message: "开始" },
    });
    expect(response.statusCode).toBe(503);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/grading/sessions/${session.id}`,
        })
      ).json().gradingStatus,
    ).toBe("not_started");
    const autoStart = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "李华",
          studentNumber: "20260002",
          autoStartAfterConversion: "true",
        },
        "report.md",
        "# 报告",
      ),
    });
    expect(autoStart.statusCode).toBe(503);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/grading/sessions" })
      ).json(),
    ).toHaveLength(1);
    await app.close();
  });

  it("streams replayable grading events and exposes the persisted conversation", async () => {
    const grader: PiAssignmentGrader = {
      async run(_request, emit) {
        emit?.({ type: "process_delta", delta: "正在核对评分证据。" });
        emit?.({ type: "model_switch", model: "vision-model", capability: "vision" });
        emit?.({ type: "reply_delta", delta: "已完成核对。" });
        return { kind: "reply", reply: "已完成核对。" };
      },
    };
    const { app, assignmentId } = await setup(() => grader);
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "20260001",
        },
        "report.md",
        "# 报告",
      ),
    });
    const session = created.json();
    const runResponse = await app.inject({
      method: "POST",
      url: `/api/grading/sessions/${session.id}/messages`,
      payload: { message: "解释评分" },
    });
    const run = runResponse.json();
    const events = await app.inject({
      method: "GET",
      url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=true`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("event: process_delta");
    expect(events.body).toContain("event: model_switch");
    expect(events.body).toContain('"capability":"vision"');
    expect(events.body).toContain("event: final");
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/grading/sessions/${session.id}`,
      })
    ).json();
    expect(detail.conversation.messages.at(-1)).toMatchObject({
      role: "assistant",
      processCollapsed: true,
    });
    await app.close();
  });

  it("maps program-owned grading validation failures to 422", async () => {
    const grader: PiAssignmentGrader = {
      async run() {
        return {
          kind: "question",
          question: { question: "请确认", options: ["确认"] },
        };
      },
    };
    const { app, assignmentId } = await setup(() => grader);
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/grading/sessions",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload: multipart(
          "x",
          {
            assignmentId,
            rubricVersion: "1",
            studentName: "张晓明",
            studentNumber: "20260001",
          },
          "report.md",
          "# 报告",
        ),
      })
    ).json();
    const run = (
      await app.inject({
        method: "POST",
        url: `/api/grading/sessions/${session.id}/runs`,
        payload: { message: "开始" },
      })
    ).json();
    await app.inject({
      method: "GET",
      url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=true`,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/grading/sessions/${session.id}/draft`,
      payload: {
        expectedVersion: 0,
        note: "人工修订",
        draft: {
          schemaVersion: "1.0",
          mode: "additive",
          criteria: [
            {
              criterionId: "C1",
              score: 8,
              reason: "缺少等级",
              evidence: [
                {
                  kind: "text",
                  path: "submission-v1.md",
                  heading: "报告",
                  startLine: 1,
                  endLine: 1,
                  quote: "# 报告",
                },
              ],
              confidence: 0.9,
            },
          ],
          strengths: [],
          improvements: [],
          warnings: [],
        },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "GRADING_RESULT_INVALID" });
    await app.close();
  });

  it("cancels an active grading run through the public API", async () => {
    const grader: PiAssignmentGrader = {
      async run(_request, _emit, signal) {
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
        return { kind: "reply", reply: "unreachable" };
      },
    };
    const { app, assignmentId } = await setup(() => grader);
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId,
          rubricVersion: "1",
          studentName: "张晓明",
          studentNumber: "20260001",
        },
        "report.md",
        "# 报告",
      ),
    });
    const session = created.json();
    const run = (
      await app.inject({
        method: "POST",
        url: `/api/grading/sessions/${session.id}/runs`,
        payload: { message: "开始批改" },
      })
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/agent-runs/${run.id}/cancel`,
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ cancelled: true });
    const events = await app.inject({
      method: "GET",
      url: `/api/grading/sessions/${session.id}/runs/${run.id}/events?after=0&follow=false`,
    });
    expect(events.body).toContain("event: cancelled");
    const retry = await app.inject({
      method: "POST",
      url: `/api/grading/sessions/${session.id}/runs`,
      payload: { message: "重试批改" },
    });
    expect(retry.statusCode, retry.body).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.inject({
      method: "POST",
      url: `/api/agent-runs/${retry.json().id}/cancel`,
    });
    const revision = await app.inject({
      method: "POST",
      url: `/api/grading/sessions/${session.id}/revisions`,
    });
    expect(revision.statusCode, revision.body).toBe(201);
    expect(revision.json()).toMatchObject({
      gradingStatus: "not_started",
      studentNumber: "20260001",
    });
    await app.close();
  });

  it("exposes safe retryable converter outages and rejects retry for terminal parse failures", async () => {
    const unavailableClient: DocumentConversionClient = {
      health: async () => ({}),
      submit: async () => {
        throw new ConversionUnavailableError("private socket detail");
      },
      status: async (): Promise<ConversionTaskStatus> => ({ status: "running" }),
      result: async () => ({ kind: "archive", bytes: new Uint8Array() }),
    };
    const unavailableSetup = await setup(undefined, unavailableClient, {
      maxAttempts: 1,
      retryDelaysMs: [],
    });
    const unavailableCreated = await unavailableSetup.app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: multipart(
        "x",
        {
          assignmentId: unavailableSetup.assignmentId,
          rubricVersion: "1",
          studentName: "Student",
          studentNumber: "20260020",
          submissionTitle: "Report",
        },
        "report.pdf",
        "%PDF-1.7 synthetic",
      ),
    });
    const unavailable = await waitForConversionStatus(
      unavailableSetup.app,
      unavailableCreated.json().id,
      "waiting_for_converter",
    );
    expect(unavailable).toMatchObject({
      conversionAttemptCount: 1,
      conversionError: { code: "CONVERTER_UNAVAILABLE", retryable: true },
    });
    expect(JSON.stringify(unavailable)).not.toContain("private socket detail");
    expect(
      (
        await unavailableSetup.app.inject({
          method: "POST",
          url: `/api/grading/sessions/${unavailable.id}/conversion/retry`,
        })
      ).statusCode,
    ).toBe(202);
    await unavailableSetup.app.close();

    const failedClient: DocumentConversionClient = {
      health: async () => ({}),
      submit: async () => ({ taskId: "failed-task" }),
      status: async (): Promise<ConversionTaskStatus> => ({
        status: "failed",
        error: "private parser detail",
      }),
      result: async () => ({ kind: "archive", bytes: new Uint8Array() }),
    };
    const failedSetup = await setup(undefined, failedClient);
    const failedCreated = await failedSetup.app.inject({
      method: "POST",
      url: "/api/grading/sessions",
      headers: { "content-type": "multipart/form-data; boundary=y" },
      payload: multipart(
        "y",
        {
          assignmentId: failedSetup.assignmentId,
          rubricVersion: "1",
          studentName: "Student",
          studentNumber: "20260021",
          submissionTitle: "Report",
        },
        "report.pdf",
        "%PDF-1.7 synthetic",
      ),
    });
    const failed = await waitForConversionStatus(
      failedSetup.app,
      failedCreated.json().id,
      "conversion_failed",
    );
    expect(failed.conversionError).toMatchObject({
      code: "CONVERSION_FAILED",
      retryable: false,
    });
    expect(JSON.stringify(failed)).not.toContain("private parser detail");
    expect(
      (
        await failedSetup.app.inject({
          method: "POST",
          url: `/api/grading/sessions/${failed.id}/conversion/retry`,
        })
      ).statusCode,
    ).toBe(409);
    await failedSetup.app.close();
  });

  it("filters exact rubrics and renames and deletes grading sessions", async () => {
    const { app, assignmentId } = await setup();
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/grading/sessions",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload: multipart(
          "x",
          {
            assignmentId,
            rubricVersion: "1",
            studentName: "张晓明",
            studentNumber: "20260001",
            submissionTitle: "手填选题",
          },
          "report.md",
          "# 报告",
        ),
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/grading/sessions?assignmentId=${assignmentId}&rubricVersion=1`,
        })
      ).json(),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/grading/sessions?assignmentId=${assignmentId}&rubricVersion=2`,
        })
      ).json(),
    ).toHaveLength(0);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/grading/sessions/${session.id}`,
      payload: { title: "选题报告批改" },
    });
    expect(renamed.json()).toMatchObject({
      title: "选题报告批改",
      submissionTitle: "手填选题",
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/grading/sessions/${session.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/grading/sessions/${session.id}`,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("serves a configurable CSV export for an exact frozen rubric", async () => {
    const { app, assignmentId } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/grading/exports/csv",
      payload: {
        scope: { kind: "rubric", assignmentId, rubricVersion: 1 },
        columns: { studentName: true, totalScore: true },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(
      "grading-results.csv",
    );
    expect(response.body).toBe("\ufeff学生姓名,总分\r\n");
    await app.close();
  });
});

async function setup(
  graderFactory?: GradingAgentBuilder,
  conversionClient?: DocumentConversionClient,
  conversionOptions?: SubmissionConversionOptions,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-api-"));
  roots.push(root);
  const submissionTitleAgentFactory: GradingAgentBuilder = (
    sessionId,
    _runId,
    services,
  ) => ({
    async run() {
      await services.sessions.resolveSubmissionTitle(sessionId, "自动识别作业");
      return { kind: "title", title: "自动识别作业" };
    },
  });
  const app = await createServer({
    workspaceRoot: root,
    submissionTitleAgentFactory,
    ...(graderFactory ? { gradingAgentFactory: graderFactory } : {}),
    ...(conversionClient ? { conversionClient } : {}),
    ...(conversionOptions
      ? { submissionConversionOptions: conversionOptions }
      : {}),
  });
  const course = (
    await app.inject({
      method: "POST",
      url: "/api/courses",
      payload: { name: "唯一课程" },
    })
  ).json();
  expect(course.id).toBeTruthy();
  const assignmentResponse = await app.inject({
    method: "POST",
    url: "/api/rubrics/assignments",
    payload: {
      title: "评分表",
      totalScore: 10,
      requirements: "评价报告。",
      sources: [],
    },
  });
  expect(assignmentResponse.statusCode, assignmentResponse.body).toBe(201);
  const assignment = assignmentResponse.json();
  const modeResponse = await app.inject({
    method: "PUT",
    url: `/api/rubrics/assignments/${assignment.id}/mode`,
    payload: { mode: "additive" },
  });
  expect(modeResponse.statusCode, modeResponse.body).toBe(200);
  const draftResponse = await app.inject({
    method: "PUT",
    url: `/api/rubrics/assignments/${assignment.id}/draft`,
    payload: { expectedVersion: 0, rubric },
  });
  expect(draftResponse.statusCode, draftResponse.body).toBe(200);
  const freezeResponse = await app.inject({
    method: "POST",
    url: `/api/rubrics/assignments/${assignment.id}/freeze`,
    payload: { expectedVersion: 1, acknowledgedWarningCodes: [] },
  });
  expect(freezeResponse.statusCode, freezeResponse.body).toBe(201);
  return { app, assignmentId: assignment.id, root };
}

async function waitForConversionStatus(
  app: Awaited<ReturnType<typeof createServer>>,
  sessionId: string,
  status: string,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/grading/sessions/${sessionId}`,
      })
    ).json<Record<string, any>>();
    if (detail.conversionStatus === status) return detail;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Conversion did not reach ${status}`);
}

function multipart(
  boundary: string,
  fields: Record<string, string>,
  filename: string,
  content: string,
): Buffer {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields))
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  chunks.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
  return Buffer.from(chunks.join(""), "utf8");
}

function multipartWithAssets(
  boundary: string,
  fields: Record<string, string>,
  report: { filename: string; bytes: Buffer },
  assets: Array<{ filename: string; bytes: Buffer }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields))
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  const file = (fieldname: string, item: { filename: string; bytes: Buffer }) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${item.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(item.bytes, Buffer.from("\r\n"));
  };
  file("file", report);
  for (const asset of assets) file("asset", asset);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
