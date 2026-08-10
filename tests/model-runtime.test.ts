import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ConfiguredModels } from "../src/models/openai-compatible.js";
import { createPrimaryModelRuntime } from "../src/models/runtime.js";
import { GradingResultService } from "../src/services/grading-result-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("names a submission without requiring an active course knowledge release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-runtime-name-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({
    courseId: "11111111-1111-4111-8111-111111111111",
    title: "评分表",
    totalScore: 10,
    requirements: "评分",
    sources: [],
  });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0",
    mode: "deductive",
    totalScore: 10,
    overlapGroups: [],
    rules: [{
      id: "R1",
      name: "缺失内容",
      condition: "缺失内容",
      deduction: 10,
      maxDeduction: 10,
      occurrence: "once",
      evidenceRequired: true,
    }],
  });
  await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "filename-topic.md");
  await writeFile(source, "# 正文主题\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({
    assignmentId: assignment.id,
    rubricVersion: 1,
    studentName: "张晓明",
    studentNumber: "20260001",
    originalPath: source,
    originalFilename: "文件名主题.md",
    autoStartAfterConversion: false,
  });
  try {
    const results = new GradingResultService(root, sessions, rubrics);
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_submission_files", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_submission_lines", { path: "submission-v1.md", startLine: 1, endLine: 1 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("set_submission_title", { title: "正文主题" })], { stopReason: "toolUse" }),
    ]);
    const configured = {
      models,
      primary: faux.getModel()!,
      getApiKey: async () => "test-key",
    } as ConfiguredModels;
    const runtime = createPrimaryModelRuntime({ workspaceRoot: root, configured, apiKey: "test-key" });
    const grader = runtime.gradingAgentFactory!(session.id, "name-run", { sessions, results, rubrics });

    await expect(grader.run({ kind: "name", message: "识别名称" })).resolves.toEqual({ kind: "title", title: "正文主题" });
    expect(await sessions.getSession(session.id)).toMatchObject({ submissionTitle: "正文主题", submissionTitleStatus: "resolved" });

    await sessions.lockSubmissionForGrading(session.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_knowledge_root", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read_submission_lines", { path: "submission-v1.md", startLine: 1, endLine: 1 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_grading_draft", {
        expectedVersion: 0,
        draft: {
          schemaVersion: "1.0",
          mode: "deductive",
          deductions: [{
            ruleId: "R1", triggered: false, deduction: 0, reason: "正文包含内容",
            evidence: [{ kind: "text", path: "submission-v1.md", heading: "正文主题", startLine: 1, endLine: 1, quote: "# 正文主题" }],
            confidence: 0.9,
          }],
          strengths: ["已提交正文"], improvements: [], warnings: [],
        },
      })], { stopReason: "toolUse" }),
    ]);
    const grading = runtime.gradingAgentFactory!(session.id, "grade-run", { sessions, results, rubrics });
    await expect(grading.run({ kind: "grade", message: "开始批改" })).resolves.toMatchObject({ kind: "draft" });
    await expect(results.readDraft(session.id)).resolves.toMatchObject({ version: 1 });
  } finally {
    sessions.close();
  }
});
