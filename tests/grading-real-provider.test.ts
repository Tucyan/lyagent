import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import { SafeFilesystem } from "../src/core/safe-filesystem.js";
import { rubricSchema } from "../src/schemas/rubric.js";
import { GradingResultService } from "../src/services/grading-result-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { CourseKnowledgeService } from "../src/services/knowledge-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import { DeepSeekStudentIdentityClient } from "../src/services/student-identity-service.js";

const enabled = process.env.RUN_REAL_AI === "1";
let root: string | undefined;

describe.runIf(enabled)("single grading real provider acceptance", () => {
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("recognizes the filename and grades every item in the supplied frozen rubric", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when RUN_REAL_AI=1");
    const identity = await new DeepSeekStudentIdentityClient({ apiKey }).identify("20260001_张晓明_生成式AI生活助手报告.pdf");
    expect(identity).toEqual({ studentName: "张晓明", studentNumber: "20260001" });

    root = await mkdtemp(path.join(os.tmpdir(), "grading-real-ai-"));
    const rubrics = new RubricService(root);
    const exported = JSON.parse(await (await import("node:fs/promises")).readFile(path.resolve("tests/fixtures/single-grading/ai-life-report/rubric-v1.json"), "utf8"));
    const rubric = rubricSchema.parse(exported.rubric);
    const assignment = await rubrics.createAssignment({ courseId: "00000000-0000-4000-8000-000000000001", title: "真实批改校准", totalScore: 100, requirements: "按冻结评分表批改报告。", sources: [] });
    await rubrics.selectMode(assignment.id, "deductive");
    await rubrics.createDraft(assignment.id, rubric);
    const frozen = await rubrics.freeze(assignment.id, 1, []);
    expect(frozen.rubric).toEqual(rubric);
    expect(frozen.hash).toMatch(/^[a-f0-9]{64}$/);
    const sessions = new GradingSessionService(root, rubrics);
    const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: 1, ...identity, originalPath: path.resolve("tests/fixtures/single-grading/ai-life-report/20260001_张晓明_生成式AI生活助手报告.md"), originalFilename: "20260001_张晓明_生成式AI生活助手报告.md", autoStartAfterConversion: false });
    await sessions.lockSubmissionForGrading(session.id);
    const results = new GradingResultService(root, sessions, rubrics);
    const models = createModels(); models.setProvider(deepseekProvider());
    const model = models.getModel("deepseek", "deepseek-v4-flash");
    if (!model) throw new Error("DeepSeek grading model is unavailable");
    const knowledge = new CourseKnowledgeService({ id: "00000000-0000-4000-8000-000000000002", courseId: session.courseId, importId: "00000000-0000-4000-8000-000000000003", manifestHash: "0".repeat(64), createdAt: new Date().toISOString() }, [], new SafeFilesystem(root));
    const grader = createPiAssignmentGrader({ models, model, sessions, results, rubrics, sessionId: session.id, runId: "00000000-0000-4000-8000-000000000004", knowledge, getApiKey: () => apiKey });
    const outcome = await grader.run({ kind: "grade", message: "按冻结评分表完成逐项批改；必须为全部 16 条规则提交判断。" });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.draft.result.decisions.mode).toBe("deductive");
    if (outcome.draft.result.decisions.mode !== "deductive") return;
    expect(outcome.draft.result.decisions.deductions).toHaveLength(16);
    expect(outcome.draft.result.decisions.deductions.find(({ ruleId }) => ruleId === "process_no_output")).toMatchObject({ triggered: true, deduction: 15 });
    expect(outcome.draft.result.score).toEqual({ earned: 85, possible: 100 });
    sessions.close();
  }, 180_000);
});
