import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GradingResultService } from "../src/services/grading-result-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import { createAssignmentGraderTools, gradingToolActivity } from "../src/tools/grading/index.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-tools-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "报告", totalScore: 100, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, { schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [], rules: [{ id: "missing", name: "缺失", condition: "缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true }] });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.md");
  await writeFile(source, "# 报告\n\n课程概念与实现过程\n\n![图表](assets/chart.png)\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false, revisionAssets: [{ path: "assets/chart.png", bytes: new Uint8Array([1, 2, 3]) }] });
  await sessions.lockSubmissionForGrading(session.id);
  const results = new GradingResultService(root, sessions, rubrics);
  const knowledge = {
    listDirectory: async () => [{ path: "课程/要求.md", title: "课程要求", type: "file" as const }],
    search: async () => [{ path: "课程/要求.md", title: "课程要求", startLine: 2, endLine: 2, excerpt: "课程概念" }],
    readLines: async () => ({ path: "课程/要求.md", startLine: 1, endLine: 2, content: "# 要求\n课程概念\n" }),
  };
  const web = {
    search: async () => [{ resultId: "web-1", title: "公开资料", url: "https://example.edu", snippet: "摘要" }],
    read: async () => ({ sourceId: "web-1", title: "公开资料", url: "https://example.edu", content: "网页内容", startLine: 1, endLine: 1 }),
    citation: () => undefined,
  };
  return { sessions, results, rubrics, session, knowledge, web };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const draft = {
  schemaVersion: "1.0", mode: "deductive",
  deductions: [{ ruleId: "missing", triggered: false, deduction: 0, reason: "内容存在", evidence: [{ kind: "text", path: "submission-v1.md", heading: "报告", startLine: 1, endLine: 3, quote: "课程概念" }], confidence: 0.9 }],
  strengths: ["完整"], improvements: [], warnings: [],
};

describe("assignment grader tools", () => {
  it("exposes exactly the approved fixed allow-list without rubric or score tools", async () => {
    const { sessions, results, session, knowledge, web } = await fixture();
    const tools = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-1", knowledge: knowledge as any, web: web as any });
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "list_submission_files", "search_submission", "read_submission_lines", "read_submission_image",
      "read_grading_draft", "submit_grading_draft",
      "get_knowledge_root", "list_knowledge_directory", "search_knowledge", "read_knowledge_lines",
      "web_search", "read_web_result", "ask_grading_question",
    ]);
    expect(JSON.stringify(tools.tools.map(({ parameters }) => parameters))).not.toContain("sessionId");
    expect(tools.tools.some(({ name }) => name.includes("rubric") || name.includes("score") || name.includes("validate"))).toBe(false);
    sessions.close();
  });

  it("lists, searches, and reads only the current locked submission", async () => {
    const { sessions, results, session, knowledge } = await fixture();
    const tools = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-1", knowledge: knowledge as any });
    const list = await tools.tools.find(({ name }) => name === "list_submission_files")!.execute("list", {});
    const search = await tools.tools.find(({ name }) => name === "search_submission")!.execute("search", { query: "实现", maxResults: 5 });
    const read = await tools.tools.find(({ name }) => name === "read_submission_lines")!.execute("read", { path: "submission-v1.md", startLine: 1, endLine: 3 });
    expect(JSON.stringify(list)).toContain("submission-v1.md");
    expect(JSON.stringify(list)).toContain("report.md");
    expect(JSON.stringify(search)).toContain("课程概念与实现过程");
    expect(JSON.stringify(read)).toContain("# 报告");
    await expect(tools.tools.find(({ name }) => name === "read_submission_lines")!.execute("bad", { path: "../other/submission.md", startLine: 1, endLine: 3 })).rejects.toThrow(/current submission/i);
    sessions.close();
  });

  it("exposes a terminal submission naming tool only during mandatory naming", async () => {
    const { sessions, results, session, knowledge } = await fixture();
    const tools = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "name-1", knowledge: knowledge as any, purpose: "naming" });
    expect(tools.tools.map(({ name }) => name)).toEqual(["list_submission_files", "search_submission", "read_submission_lines", "set_submission_title"]);
    const named = await tools.tools.find(({ name }) => name === "set_submission_title")!.execute("set-title", { title: "课程概念的工程实现" });
    expect(named.terminate).toBe(true);
    expect(tools.capturedTitle()).toBe("课程概念的工程实现");
    expect(await sessions.getSession(session.id)).toMatchObject({ submissionTitle: "课程概念的工程实现", submissionTitleStatus: "resolved" });
    await expect(tools.tools.find(({ name }) => name === "set_submission_title")!.execute("again", { title: "另一个标题" })).rejects.toThrow(/already/i);
    expect(gradingToolActivity("set_submission_title", { title: "sensitive title" })).toEqual({ label: "命名学生作业", summary: "保存当前作业的识别名称" });
    sessions.close();
  });

  it("reads and submits a versioned grading draft through the program-owned validator", async () => {
    const { sessions, results, session, knowledge } = await fixture();
    const tools = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-1", knowledge: knowledge as any });
    const readTool = tools.tools.find(({ name }) => name === "read_grading_draft")!;
    expect(JSON.stringify(await readTool.execute("read-draft", {}))).toContain("null");
    const submitted = await tools.tools.find(({ name }) => name === "submit_grading_draft")!.execute("submit", { expectedVersion: 0, draft });
    expect(submitted.terminate).toBe(true);
    expect(tools.updatedDraft()).toMatchObject({ version: 1, result: { score: { earned: 100 } } });
    const reread = await readTool.execute("read-draft-2", {});
    const text = reread.content.find((item): item is { type: "text"; text: string } => item.type === "text")!;
    expect(JSON.parse(text.text)).toMatchObject({ version: 1 });
    sessions.close();
  });

  it("captures one structured teacher question and emits only safe activity summaries", async () => {
    const { sessions, results, session, knowledge } = await fixture();
    const tools = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-1", knowledge: knowledge as any });
    const asked = await tools.tools.find(({ name }) => name === "ask_grading_question")!.execute("ask", { question: "图表是否属于正文？", options: ["是", "否"] });
    expect(asked.terminate).toBe(true);
    expect(tools.capturedQuestion()).toEqual({ question: "图表是否属于正文？", options: ["是", "否"] });
    expect(gradingToolActivity("read_submission_lines", { path: "private/absolute/path.md", startLine: 1, endLine: 2 })).toEqual({ label: "阅读作业内容", summary: "读取当前作业正文片段 · L1-L2" });
    sessions.close();
  });

  it("returns controlled image content only when a vision model is available", async () => {
    const { sessions, results, session, knowledge } = await fixture();
    const withVision = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-vision", knowledge: knowledge as any, visionAvailable: true });
    const image = await withVision.tools.find(({ name }) => name === "read_submission_image")!.execute("image", { path: "assets/chart.png" });
    expect(image.content).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);

    const withoutVision = createAssignmentGraderTools({ sessions, results, sessionId: session.id, runId: "run-text", knowledge: knowledge as any, visionAvailable: false });
    const unavailable = await withoutVision.tools.find(({ name }) => name === "read_submission_image")!.execute("image", { path: "assets/chart.png" });
    expect(unavailable.content).toEqual([{ type: "text", text: JSON.stringify({ code: "VISION_MODEL_NOT_CONFIGURED" }) }]);
    expect(JSON.stringify(unavailable)).not.toContain("chart.png");
    sessions.close();
  });
});
