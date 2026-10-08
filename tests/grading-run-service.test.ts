import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import { GradingResultService } from "../src/services/grading-result-service.js";
import { GradingRunService } from "../src/services/grading-run-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import { KnowledgeAccessError } from "../src/services/knowledge-service.js";
import { GradingResultValidationError } from "../src/schemas/grading.js";
import { AgentExecutionLimitError } from "../src/core/agent-execution-budget.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-run-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "报告", totalScore: 100, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, { schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [], rules: [{ id: "missing", name: "缺失", condition: "缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true }] });
  await rubrics.freeze(assignment.id, 1, []);
  const sessions = new GradingSessionService(root, rubrics);
  async function createSession(studentNumber: string, lock = true) {
    const source = path.join(root, `${studentNumber}.md`);
    await writeFile(source, "# 报告\n内容\n", "utf8");
    const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: 1, studentName: "学生", studentNumber, originalPath: source, originalFilename: `${studentNumber}.md`, autoStartAfterConversion: false });
    if (lock) await sessions.lockSubmissionForGrading(session.id);
    return session;
  }
  return { root, sessions, results: new GradingResultService(root, sessions, rubrics), createSession };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingRunService", () => {
  it("explains how to proceed when a teacher question is requested before grading starts", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20262002", false);
    const runs = new GradingRunService(root, sessions, () => ({ run: async () => ({ kind: "question", question: { question: "严格还是从宽？", options: ["严格", "从宽"] } }) }));
    try {
      const run = await runs.start(session.id, { kind: "chat", message: "先向教师确认" });
      const terminal = await runs.waitForTerminal(run.id);
      expect(terminal.status).toBe("failed");
      expect((await runs.listEvents(run.id, 0)).find((event) => event.type === "error")?.code).toBe("GRADING_ACTION_UNAVAILABLE");
      expect((await sessions.getSession(session.id)).gradingStatus).toBe("not_started");
    } finally { runs.close(); sessions.close(); }
  });
  it("bounds SQLite polling while a run is stalled and preserves timeout behavior", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20262001");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const runs = new GradingRunService(root, sessions, () => ({ run: async () => { await gate; return { kind: "reply", reply: "Done" }; } }));
    try {
      const run = await runs.start(session.id, { kind: "chat", message: "Explain" });
      await vi.waitFor(async () => expect((await runs.getRun(run.id)).status).toBe("running"));
      const reads = vi.spyOn(runs, "getRun");
      await expect(runs.waitForTerminal(run.id, 350)).rejects.toThrow("Timed out waiting for grading run");
      expect(reads.mock.calls.length).toBeLessThanOrEqual(6);
      reads.mockRestore();
      finish();
      await expect(runs.waitForTerminal(run.id)).resolves.toMatchObject({ status: "completed" });
    } finally { finish(); runs.close(); sessions.close(); }
  });

  it("persists stable safe failure categories without provider details", async () => {
    const { root, sessions, createSession } = await setup();
    const cases = [
      { student: "20261001", error: new Error("provider secret response"), code: "GRADING_MODEL_REQUEST_FAILED" },
      { student: "20261002", error: new Error("Grading Agent did not submit a draft"), code: "GRADING_TOOL_CALL_MISSING" },
      { student: "20261003", error: new GradingResultValidationError("raw invalid draft"), code: "GRADING_DRAFT_VALIDATION_FAILED" },
      { student: "20261004", error: new KnowledgeAccessError("ACTIVE_RELEASE_NOT_FOUND", "raw missing release"), code: "GRADING_KNOWLEDGE_UNAVAILABLE" },
      { student: "20261005", error: new AgentExecutionLimitError("AGENT_TOOL_CALL_LIMIT"), code: "AGENT_TOOL_CALL_LIMIT" },
      { student: "20261006", error: new AgentExecutionLimitError("AGENT_TIMEOUT"), code: "AGENT_TIMEOUT" },
    ];
    for (const item of cases) {
      const session = await createSession(item.student);
      const runs = new GradingRunService(root, sessions, () => ({ async run() { throw item.error; } }));
      const started = await runs.start(session.id, { kind: "grade", message: "开始" });
      const terminal = await runs.waitForTerminal(started.id);
      expect(terminal).toMatchObject({ status: "failed", errorCode: item.code });
      const events = await runs.listEvents(started.id, 0);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: item.code }));
      if (!(item.error instanceof AgentExecutionLimitError)) expect(JSON.stringify(events)).not.toContain(item.error.message);
      runs.close();
    }
    sessions.close();
  });

  it("honors an explicitly configured bounded worker concurrency", async () => {
    const { root, sessions, createSession } = await setup();
    const first = await createSession("20260001");
    const second = await createSession("20260002");
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const runs = new GradingRunService(root, sessions, () => ({
      async run() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { kind: "reply", reply: "完成" };
      },
    }), { concurrency: 2 });
    const firstRun = await runs.start(first.id, { kind: "chat", message: "一" });
    const secondRun = await runs.start(second.id, { kind: "chat", message: "二" });
    await vi.waitFor(() => expect(active).toBe(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all([runs.waitForTerminal(firstRun.id), runs.waitForTerminal(secondRun.id)]);
    expect(maximum).toBe(2);
    runs.close(); sessions.close();
  });

  it("runs independently of the page request and persists replayable safe events and conversation", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20260001");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const grader: PiAssignmentGrader = { run: async (_request, onEvent) => {
      onEvent?.({ type: "process_delta", delta: "安全处理摘要" });
      onEvent?.({ type: "tool_start", id: "tool-1", name: "search_submission", label: "搜索学生作业", summary: "搜索相关内容" });
      onEvent?.({ type: "model_switch", model: "vision-model", capability: "vision" });
      await gate;
      onEvent?.({ type: "reply_delta", delta: "已完成说明" });
      return { kind: "reply", reply: "已完成说明" };
    } };
    const runs = new GradingRunService(root, sessions, () => grader);

    const started = await runs.start(session.id, { kind: "chat", message: "请解释" });
    expect(started.status).toBe("queued");
    await vi.waitFor(() => expect(sessions.getSession(session.id)).resolves.toMatchObject({ activeRunId: started.id }));
    finish();
    await expect(runs.waitForTerminal(started.id)).resolves.toMatchObject({ status: "completed" });
    const events = await runs.listEvents(started.id, 0);
    expect(events.map(({ sequence }) => sequence)).toEqual([...events.keys()].map((index) => index + 1));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "process_delta" }), expect.objectContaining({ type: "tool_start" }), expect.objectContaining({ type: "model_switch", model: "vision-model", capability: "vision" }), expect.objectContaining({ type: "final" })]));
    expect(JSON.stringify(events)).not.toContain("submission-v1.md");
    expect(await runs.getConversation(session.id)).toMatchObject({ messages: [expect.objectContaining({ role: "user", content: "请解释" }), expect.objectContaining({ role: "assistant", content: "已完成说明", process: expect.stringContaining("已切换至视觉模型"), processCollapsed: true })] });
    expect((await sessions.getSession(session.id)).activeRunId).toBeUndefined();
    runs.close(); sessions.close();
  });

  it("uses one grading slot and releases it when a run waits for the teacher", async () => {
    const { root, sessions, createSession } = await setup();
    const first = await createSession("20260001");
    const second = await createSession("20260002");
    const calls: string[] = [];
    const factory = (sessionId: string): PiAssignmentGrader => ({ run: vi.fn(async (): ReturnType<PiAssignmentGrader["run"]> => {
      calls.push(sessionId);
      return sessionId === first.id ? { kind: "question", question: { question: "是否包含附件？", options: ["是", "否"] } } : { kind: "reply", reply: "第二份完成" };
    }) });
    const runs = new GradingRunService(root, sessions, factory);
    const firstRun = await runs.start(first.id, { kind: "grade", message: "开始" });
    const secondRun = await runs.start(second.id, { kind: "chat", message: "解释" });
    await Promise.all([runs.waitForTerminal(firstRun.id), runs.waitForTerminal(secondRun.id)]);
    expect(calls).toEqual([first.id, second.id]);
    expect((await sessions.getSession(first.id)).gradingStatus).toBe("waiting_for_teacher");
    expect((await sessions.getSession(second.id)).gradingStatus).not.toBe("running");
    runs.close(); sessions.close();
  });

  it("cancels only through run id and does not persist an unfinished assistant turn", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20260001");
    const grader: PiAssignmentGrader = { run: (_request, _onEvent, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) };
    const runs = new GradingRunService(root, sessions, () => grader);
    const run = await runs.start(session.id, { kind: "grade", message: "开始" });
    await vi.waitFor(() => expect(runs.getRun(run.id)).resolves.toMatchObject({ status: "running" }));
    await expect(runs.cancel(run.id)).resolves.toBe(true);
    await expect(runs.waitForTerminal(run.id)).resolves.toMatchObject({ status: "cancelled" });
    expect((await runs.getConversation(session.id)).messages).toEqual([expect.objectContaining({ role: "user", content: "开始" })]);
    runs.close(); sessions.close();
  });

  it("does not call the provider again for an interrupted running run", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20260001");
    const chatSession = await createSession("20260002");
    const database = new Database(path.join(root, "grading.sqlite"));
    database.prepare("UPDATE grading_sessions SET grading_status = 'running', active_run_id = ? WHERE id = ?").run("interrupted-run", session.id);
    database.prepare("INSERT INTO agent_runs (id, session_id, kind, input_message, status, created_at, updated_at) VALUES (?, ?, 'grade', '开始', 'running', ?, ?)").run("interrupted-run", session.id, "2026-08-04T10:00:00.000Z", "2026-08-04T10:00:00.000Z");
    database.prepare("UPDATE grading_sessions SET active_run_id = ? WHERE id = ?").run("interrupted-chat", chatSession.id);
    database.prepare("INSERT INTO agent_runs (id, session_id, kind, input_message, status, created_at, updated_at) VALUES (?, ?, 'chat', '解释', 'running', ?, ?)").run("interrupted-chat", chatSession.id, "2026-08-04T10:00:00.000Z", "2026-08-04T10:00:00.000Z");
    database.close();
    const provider = vi.fn(async (): ReturnType<PiAssignmentGrader["run"]> => ({ kind: "reply", reply: "不应调用" }));

    const runs = new GradingRunService(root, sessions, () => ({ run: provider }));

    await expect(runs.getRun("interrupted-run")).resolves.toMatchObject({ status: "failed", errorCode: "GRADING_RUN_INTERRUPTED" });
    expect(provider).not.toHaveBeenCalled();
    expect((await sessions.getSession(session.id)).gradingStatus).toBe("failed");
    const recoveredChatSession = await sessions.getSession(chatSession.id);
    expect(recoveredChatSession.gradingStatus).toBe("queued");
    expect(recoveredChatSession.activeRunId).toBeUndefined();
    expect(await runs.listEvents("interrupted-run", 0)).toEqual([expect.objectContaining({ type: "error", code: "GRADING_RUN_INTERRUPTED" })]);
    runs.close(); sessions.close();
  });

  it("rejects duplicate active runs and supplies prior conversation to follow-up turns", async () => {
    const { root, sessions, createSession } = await setup();
    const session = await createSession("20260001");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: Parameters<PiAssignmentGrader["run"]>[0][] = [];
    const grader: PiAssignmentGrader = { async run(request) { requests.push(request); if (requests.length === 1) await gate; return { kind: "reply", reply: `回复${requests.length}` }; } };
    const runs = new GradingRunService(root, sessions, () => grader);
    const first = await runs.start(session.id, { kind: "chat", message: "第一个问题" });
    await expect(runs.start(session.id, { kind: "chat", message: "重复请求" })).rejects.toThrow(/already active/i);
    release();
    await runs.waitForTerminal(first.id);
    const second = await runs.start(session.id, { kind: "chat", message: "继续解释" });
    await runs.waitForTerminal(second.id);
    expect(requests[1]?.history).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "第一个问题" }), expect.objectContaining({ role: "assistant", content: "回复1" })]));
    runs.close(); sessions.close();
  });
});
