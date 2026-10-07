import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RubricDesignerFactory } from "../src/api/server.js";
import type { PiRubricDesigner } from "../src/agents/rubric-designer/agent.js";
import type { Rubric } from "../src/schemas/rubric.js";
import { AgentExecutionLimitError } from "../src/core/agent-execution-budget.js";
import { RubricService, RubricServiceError } from "../src/services/rubric-service.js";

const roots: string[] = [];

const rubric: Rubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 100,
  partialCreditAllowed: true,
  criteria: [{
    id: "argument",
    name: "Argument",
    description: "Makes a clear, supported argument.",
    maxScore: 100,
    scorePolicy: "continuous",
    evidenceRequired: true,
  }],
};

async function serverForTest(factory?: RubricDesignerFactory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rubric-api-"));
  roots.push(root);
  const app = await createServer({ workspaceRoot: root, ...(factory ? { rubricDesignerFactory: factory } : {}) });
  const course = await app.inject({ method: "POST", url: "/api/courses", payload: { name: "唯一课程" } });
  expect(course.statusCode).toBe(201);
  return app;
}

async function createAssignment(app: Awaited<ReturnType<typeof serverForTest>>, sources: Array<{ role: "rubric_draft" | "note"; name: string; content: string }> = []) {
  const response = await app.inject({
    method: "POST",
    url: "/api/rubrics/assignments",
    payload: { title: "AI and life report", totalScore: 100, requirements: "Evaluate the report.", sources },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("rubric HTTP API", () => {
  it.each([
    { totalScore: 19.555, requirements: "Assess report", sources: [], code: "RUBRIC_TOTAL_SCORE_INVALID", message: "Assignment total score must be a positive score with at most two decimal places" },
    { totalScore: 100, requirements: "", sources: [], code: "RUBRIC_SOURCES_REQUIRED", message: "Assignment requirements or at least one non-empty source is required" },
  ])("preserves the concrete safe validation reason: $code", async ({ totalScore, requirements, sources, code, message }) => {
    const app = await serverForTest();
    try {
      const response = await app.inject({ method: "POST", url: "/api/rubrics/assignments", payload: { title: "Report", totalScore, requirements, sources } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ code, message });
    } finally { await app.close(); }
  });

  it("reports missing warning acknowledgement with a specific safe error", async () => {
    const app = await serverForTest();
    try {
      const assignment = await createAssignment(app);
      await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
      await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
      const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: [] } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "RUBRIC_WARNINGS_UNACKNOWLEDGED", message: "Current rubric warnings must be acknowledged before freezing" });
    } finally { await app.close(); }
  });

  it("keeps unclassified internal errors generic without echoing paths or source names", async () => {
    const app = await serverForTest();
    const failure = vi.spyOn(RubricService.prototype, "createAssignment").mockRejectedValue(new RubricServiceError("private-source-name C:\\private\\workspace"));
    try {
      const response = await app.inject({ method: "POST", url: "/api/rubrics/assignments", payload: { title: "Report", totalScore: 100, requirements: "Assess", sources: [] } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "RUBRIC_STATE_ERROR", message: "The rubric request is not valid for the current session state" });
      expect(response.body).not.toContain("private-source-name");
      expect(response.body).not.toContain("private\\workspace");
    } finally { failure.mockRestore(); await app.close(); }
  });

  it("reports an execution limit safely without persisting an incomplete turn", async () => {
    const app = await serverForTest(() => ({ recommendModes: async () => ({ options: [] }), design: async () => { throw new AgentExecutionLimitError("AGENT_TOOL_CALL_LIMIT"); } }));
    try {
      const assignment = await createAssignment(app);
      await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
      const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Create rubric" } });
      expect(response.body).toContain('"code":"AGENT_TOOL_CALL_LIMIT"');
      expect(response.body).toContain("模型工具调用次数已达到上限");
      expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json().messages).toEqual([]);
    } finally { await app.close(); }
  });

  it("binds new rubrics to the unique existing course and rejects ambiguous course ownership", async () => {
    const app = await serverForTest();
    const courseId = (await app.inject({ method: "GET", url: "/api/courses" })).json()[0].id;
    const assignment = await createAssignment(app);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}` })).json()).toMatchObject({ courseId });

    await app.inject({ method: "POST", url: "/api/courses", payload: { name: "第二课程" } });
    const ambiguous = await app.inject({ method: "POST", url: "/api/rubrics/assignments", payload: { title: "Ambiguous", totalScore: 100, requirements: "Test", sources: [] } });
    expect(ambiguous.statusCode).toBe(422);
    expect(ambiguous.json()).toMatchObject({ code: "RUBRIC_COURSE_BINDING_ERROR" });
    await app.close();
  });

  it("creates a rubric for the explicitly selected course in a multi-course workspace", async () => {
    const app = await serverForTest();
    const selectedCourse = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "Selected course" } })).json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: "/api/rubrics/assignments",
      payload: { courseId: selectedCourse.id, title: "Selected course rubric", totalScore: 100, requirements: "Test", sources: [] },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ courseId: selectedCourse.id, title: "Selected course rubric" });
    await app.close();
  });

  it("continues and persists a rubric reply after the page stream disconnects", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    let observedSignal: AbortSignal | undefined;
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: async (_request, _onEvent, signal) => {
        observedSignal = signal;
        await ready;
        return { kind: "reply", reply: "切换页面后仍然完成。", message: "切换页面后仍然完成。" };
      },
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/rubrics/assignments/${assignment.id}/messages/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "页面切换测试" }),
    });

    await response.body!.cancel();
    finish();
    await vi.waitFor(async () => {
      const session = (await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json();
      expect(session.messages).toHaveLength(2);
    }, { timeout: 5_000 });
    expect(observedSignal?.aborted).toBe(false);
    await app.close();
  });

  it("creates, lists, reads, renames, and deletes rubric sessions", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);

    expect((await app.inject({ method: "GET", url: "/api/rubrics/assignments" })).json()).toEqual([expect.objectContaining({ id: assignment.id, title: "AI and life report" })]);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}` })).json()).toMatchObject({ id: assignment.id, totalScore: 100 });
    const longTitle = "R".repeat(100);
    expect((await app.inject({ method: "PATCH", url: `/api/rubrics/assignments/${assignment.id}`, payload: { title: longTitle } })).json()).toMatchObject({ title: longTitle });
    expect((await app.inject({ method: "DELETE", url: `/api/rubrics/assignments/${assignment.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("returns static recommendations and manual mode state when no model is configured", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);

    const recommendation = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/recommendations` });
    expect(recommendation.statusCode).toBe(200);
    expect(recommendation.json()).toMatchObject({ source: "static", options: expect.arrayContaining([expect.objectContaining({ mode: "deductive", recommended: true, reason: expect.stringContaining("扣分") })]) });

    const selected = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ selectedMode: "additive", state: "manual" });

    const started = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode/stream`, payload: { mode: "additive" } });
    expect(started.json()).toMatchObject({ selectedMode: "additive", state: "manual", draft: { version: 1, rubric: { mode: "additive", totalScore: 100 } } });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` })).json()).toMatchObject({ version: 1 });
    await app.close();
  });

  it("returns null when an assignment has no editable rubric draft", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);

    const response = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
    await app.close();
  });

  it("rejects formal rubric chat until a scoring mode has been selected", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: async () => ({ kind: "question", question: { question: "Unused" }, message: "A clarification is needed before the rubric can be updated." }),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Create a rubric." } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "RUBRIC_STATE_ERROR" });
    await app.close();
  });

  it("uses source-aware recommendations and streams a safe generated draft after selecting a mode", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: vi.fn(async () => ({ options: [
        { mode: "additive" as const, recommended: true, reason: "The draft defines weighted criteria." },
        { mode: "deductive" as const, recommended: false, benefit: "Tracks penalties." },
        { mode: "hybrid" as const, recommended: false, benefit: "Supports exceptional work." },
      ] })),
      design: vi.fn(async () => ({ kind: "draft" as const, draft: { version: 1, rubric, updatedAt: "2026-08-03T00:00:00.000Z" }, message: "The rubric draft has been updated and is ready for review." as const })),
    };
    const factory = vi.fn<RubricDesignerFactory>(() => designer);
    const app = await serverForTest(factory);
    const assignment = await createAssignment(app, [{ role: "rubric_draft", name: "draft.md", content: "Secret draft source text" }]);

    const recommendation = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/recommendations` });
    expect(recommendation.json()).toMatchObject({ source: "model", options: expect.arrayContaining([expect.objectContaining({ mode: "additive", recommended: true })]) });
    expect(designer.recommendModes).toHaveBeenCalledWith(["Secret draft source text"]);

    const selected = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode/stream`, payload: { mode: "additive" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.body).toContain("event: final");
    expect(selected.body).toContain("rubric draft has been updated");
    expect(selected.body).not.toContain("Secret draft source text");
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` })).json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json()).toMatchObject({
      selectedMode: "additive",
      messages: [
        expect.objectContaining({ role: "user", content: expect.stringContaining("第一版评分表") }),
        expect.objectContaining({ role: "assistant", content: expect.stringContaining("已更新") }),
      ],
    });
    await app.close();
  });

  it("restores an existing rubric session without invoking scoring-mode recommendations", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: vi.fn(async () => ({ options: [] })),
      design: vi.fn(async () => ({ kind: "question" as const, question: { question: "Unused" }, message: "A clarification is needed before the rubric can be updated." as const })),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app, [{ role: "note", name: "notes.txt", content: "Use weighted criteria." }]);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "hybrid" } });

    const reopened = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` });

    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ selectedMode: "hybrid", messages: [] });
    expect(designer.recommendModes).not.toHaveBeenCalled();
    await app.close();
  });

  it("streams and persists safe rubric processing and tool activity", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: vi.fn(async (_request, onEvent) => {
        onEvent?.({ type: "status", phase: "thinking" });
        onEvent?.({ type: "process_delta", delta: "UNTRUSTED SOURCE CONTENT MUST NOT LEAK" });
        onEvent?.({ type: "tool_start", id: "context-1", name: "read_assignment_context", label: "Read assignment context", summary: "Read the current assignment" });
        onEvent?.({ type: "tool_end", id: "context-1", name: "read_assignment_context", label: "Read assignment context", summary: "Read the current assignment", status: "completed" });
        return { kind: "draft" as const, draft: { version: 1, rubric, updatedAt: "2026-08-03T00:00:00.000Z" }, message: "The rubric draft has been updated and is ready for review." as const };
      }),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Create it." } });
    const history = (await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json();

    expect(response.body).toContain("event: tool_start");
    expect(response.body).toContain("event: process_delta");
    expect(response.body).not.toContain("UNTRUSTED SOURCE CONTENT MUST NOT LEAK");
    expect(history.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Create it." }),
      expect.objectContaining({ role: "assistant", process: expect.stringContaining("正在分析"), tools: [expect.objectContaining({ id: "context-1", status: "completed" })] }),
    ]);
    await app.close();
  });

  it("persists a conversational recommendation without changing or emitting a draft", async () => {
    const recommendation = "建议补充优秀、合格和待改进三个等级的可观察证据，并说明边界情况。";
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: vi.fn(async (_request, onEvent) => {
        onEvent?.({ type: "reply_delta", delta: "建议补充优秀、合格和" });
        onEvent?.({ type: "reply_delta", delta: "待改进三个等级的可观察证据，并说明边界情况。" });
        return { kind: "reply" as const, reply: recommendation, message: recommendation };
      }),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    const existing = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "现在的评分标准有进一步改进的建议吗？" } });
    const draft = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` });
    const session = (await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json();

    expect(response.body).toContain("event: reply");
    expect(response.body.match(/event: reply_delta/g)).toHaveLength(2);
    expect(response.body).toContain(recommendation);
    expect(response.body).not.toContain("event: draft");
    expect(draft.json()).toEqual(existing.json());
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: recommendation });
    await app.close();
  });

  it("returns a localized stream error and does not persist a failed turn", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: async () => { throw new Error("provider failure"); },
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Create it." } });
    const session = (await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/session` })).json();

    expect(response.body).toContain("评分表设计未能完成");
    expect(session.messages).toEqual([]);
    await app.close();
  });

  it("edits, validates, freezes, exports, and restores frozen rubric versions", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });

    const saved = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/validate`, payload: { rubric } })).json()).toMatchObject({ errors: [] });
    const frozen = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: ["CONTINUOUS_WITHOUT_ANCHORS"] } });
    expect(frozen.statusCode).toBe(201);
    expect(frozen.json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions` })).json()).toEqual([expect.objectContaining({ version: 1 })]);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions/1/export.json` })).json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions/1/export.md` })).body).toContain("Argument");
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/versions/1/revisions` })).json()).toMatchObject({ version: 1, baseRubricVersion: 1 });
    await app.close();
  });

  it("allows only an explicit revision to reopen editable work after a rubric is frozen", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
    await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: ["CONTINUOUS_WITHOUT_ANCHORS"] } });

    expect((await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode/stream`, payload: { mode: "additive" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Revise this rubric." } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/versions/1/revisions` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` })).json()).toMatchObject({ baseRubricVersion: 1, rubric });
    await app.close();
  });

  it("returns 404 rather than validating a rubric for a nonexistent assignment", async () => {
    const app = await serverForTest();

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${randomUUID()}/validate`, payload: { rubric } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RUBRIC_NOT_FOUND" });
    await app.close();
  });

  it("persists a subsequent designer draft when its factory did not use rubric tools", async () => {
    const revised = { ...rubric, criteria: [{ ...rubric.criteria[0]!, name: "Revised argument" }] };
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: vi.fn()
        .mockResolvedValueOnce({ kind: "draft" as const, draft: { version: 1, rubric, updatedAt: "2026-08-03T00:00:00.000Z" }, message: "The rubric draft has been updated and is ready for review." as const })
        .mockResolvedValueOnce({ kind: "draft" as const, draft: { version: 2, rubric: revised, updatedAt: "2026-08-03T00:01:00.000Z" }, message: "The rubric draft has been updated and is ready for review." as const }),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);

    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode/stream`, payload: { mode: "additive" } });
    const updated = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Make the argument criterion clearer." } });

    expect(updated.body).toContain("event: draft");
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` })).json()).toMatchObject({ version: 2, rubric: revised });
    await app.close();
  });

  it("maps stale writes to 409 and invalid rubrics to safe 422 validation errors", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });

    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 1, rubric } });
    const stale = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 1, rubric } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "RUBRIC_CONFLICT" });
    const invalid = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/validate`, payload: { rubric: { ...rubric, totalScore: 99 } } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: "RUBRIC_VALIDATION_FAILED" });
    await app.close();
  });
});
