import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraderSystemPrompt, buildSubmissionNamingPrompt, createPiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import { GradingResultService } from "../src/services/grading-result-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "assignment-grader-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "报告", totalScore: 100, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, { schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [], rules: [{ id: "missing", name: "缺失", condition: "缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true }] });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.md");
  await writeFile(source, "# 报告\n\n内容完整\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: 1, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false });
  await sessions.lockSubmissionForGrading(session.id);
  const results = new GradingResultService(root, sessions, rubrics);
  const knowledge = { listDirectory: async () => [], search: async () => [], readLines: async () => ({ path: "course.md", startLine: 1, endLine: 1, content: "course" }) };
  return { sessions, results, rubrics, frozen, session, knowledge };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const gradingDraft = {
  schemaVersion: "1.0", mode: "deductive",
  deductions: [{ ruleId: "missing", triggered: false, deduction: 0, reason: "内容完整", evidence: [{ kind: "text", path: "submission-v1.md", heading: "报告", startLine: 1, endLine: 3, quote: "内容完整" }], confidence: 0.9 }],
  strengths: ["内容完整"], improvements: [], warnings: [],
};

describe("assignment grader Agent", () => {
  it("injects the frozen rubric into the system prompt without adding a rubric-read tool", async () => {
    const { frozen, sessions } = await fixture();
    const prompt = buildGraderSystemPrompt(frozen);
    expect(prompt).toContain('"mode":"deductive"');
    expect(prompt).toContain('"id":"missing"');
    expect(prompt).toContain("program code recalculates");
    expect(prompt).toContain("Prefer a specific in-range integer");
    expect(prompt).toContain("Full credit is exceptional");
    expect(prompt).toContain("Do not turn fixed or per-occurrence rules into ranges");
    expect(prompt).toContain("structured grading argument");
    expect(prompt).toContain("not hidden chain-of-thought");
    sessions.close();
  });

  it("submits a validated grading draft and streams only safe process/tool events", async () => {
    const { sessions, results, rubrics, session, knowledge } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxText("I will inspect the report."), fauxToolCall("read_submission_lines", { path: "submission-v1.md", startLine: 1, endLine: 3 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_grading_draft", { expectedVersion: 0, draft: gradingDraft })], { stopReason: "toolUse" }),
    ]);
    const events: unknown[] = [];
    const grader = createPiAssignmentGrader({ models, model: faux.getModel(), sessions, results, rubrics, sessionId: session.id, runId: "run-1", knowledge: knowledge as any });
    const outcome = await grader.run({ kind: "grade", message: "开始批改" }, (event) => events.push(event));
    expect(outcome).toMatchObject({ kind: "draft", draft: { version: 1 } });
    expect(events).toContainEqual(expect.objectContaining({ type: "process_delta", delta: expect.stringContaining("正在分析") }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", name: "read_submission_lines", label: "阅读作业内容" }));
    expect(JSON.stringify(events)).not.toContain("内容完整");
    expect(JSON.stringify(events)).not.toContain("submission-v1.md");
    sessions.close();
  });

  it("allows a conversational teacher reply without changing the draft", async () => {
    const { sessions, results, rubrics, session, knowledge } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText("该项未扣分，因为正文已经提供了对应内容。")], { stopReason: "stop" })]);
    const grader = createPiAssignmentGrader({ models, model: faux.getModel(), sessions, results, rubrics, sessionId: session.id, runId: "run-2", knowledge: knowledge as any });
    await expect(grader.run({ kind: "chat", message: "为什么没有扣分？" })).resolves.toEqual({ kind: "reply", reply: "该项未扣分，因为正文已经提供了对应内容。" });
    expect(await results.readDraft(session.id)).toBeUndefined();
    sessions.close();
  });

  it("requires the naming tool and prefers a body title over the original filename", async () => {
    const { sessions, results, rubrics, session, knowledge } = await fixture();
    expect(buildSubmissionNamingPrompt()).toContain("document body wins");
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_submission_files", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_submission_lines", { path: "submission-v1.md", startLine: 1, endLine: 3 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("set_submission_title", { title: "报告" })], { stopReason: "toolUse" }),
    ]);
    const grader = createPiAssignmentGrader({ models, model: faux.getModel(), sessions, results, rubrics, sessionId: session.id, runId: "name-1", knowledge: knowledge as any });
    await expect(grader.run({ kind: "name", message: "识别作业名称" })).resolves.toEqual({ kind: "title", title: "报告" });
    expect(await sessions.getSession(session.id)).toMatchObject({ submissionTitle: "报告", submissionTitleStatus: "resolved" });
    sessions.close();
  });
});
