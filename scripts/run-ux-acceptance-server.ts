/** Isolated, synthetic UI acceptance. Never a production model quality test. */
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "../src/api/server.js";
import { registerWebAssets } from "../src/api/web-assets.js";
import type { GradingAgentBuilder } from "../src/api/grading-routes.js";

const workspaceRoot = path.resolve(process.env.COURSE_AGENT_WORKSPACE ?? path.join(os.tmpdir(), "course-agent-ux-acceptance"));
const port = Number(process.env.PORT ?? 3017);
await mkdir(workspaceRoot, { recursive: true });
const grader: GradingAgentBuilder = (sessionId, runId, services) => ({
  async run(request, _events, signal) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    signal?.throwIfAborted();
    if (request.kind === "chat") return { kind: "reply", reply: "这是合成验收回复：请核对评分分析后正式确认。" };
    const existing = await services.results.readDraft(sessionId);
    const draft = await services.results.submitDraft(sessionId, existing?.version ?? 0, {
      schemaVersion: "1.0", mode: "additive",
      criteria: [{ criterionId: "C1", selectedLevelId: "L1", score: 8, confidence: 0.5,
        reason: "合成报告主要结构完整，需教师核对论证细节。",
        evidence: [{ kind: "analysis", observation: "包含问题、方法、结果与反思。", rubricBasis: "对应完整性与论证标准。", scoreJustification: "达到良好等级，保留两分改进空间。" }] }],
      strengths: ["结构完整"], improvements: ["补充量化证据"], warnings: [],
    }, { type: "agent", id: runId });
    return { kind: "draft", draft };
  },
});
const app = await createServer({
  workspaceRoot,
  modelStatus: { provider: "synthetic-acceptance", model: "deterministic", configured: true },
  materialPlanner: async (sections) => ({ documents: [{ path: "课程/资料.md", title: "课程资料", sectionIds: sections.map((section) => section.id) }] }),
  courseQaAgentFactory: () => ({ answer: async (question) => {
    if (question.includes("模拟失败")) throw new Error("synthetic provider error: SECRET C:\\private");
    return { answer: "这是合成验收回答：报告包含问题、方法、结果与反思。", citations: [], insufficient: true };
  } }),
  studentIdentityClient: { async identify(filename) {
    const match = /^(\d+)_([^_]+)_/.exec(filename);
    if (!match) throw new Error("Synthetic identity fixture requires teacher input");
    return { studentNumber: match[1]!, studentName: match[2]! };
  } },
  gradingAgentFactory: grader,
  submissionTitleAgentFactory: (sessionId, _runId, services) => ({ async run() {
    await services.sessions.resolveSubmissionTitle(sessionId, "合成研究报告");
    return { kind: "title", title: "合成研究报告" };
  } }),
});
await registerWebAssets(app, path.resolve("dist/web"));
const inject = async (method: "POST" | "PUT", url: string, payload: object) => {
  const response = await app.inject({ method, url, payload });
  if (response.statusCode >= 400) throw new Error(`Synthetic setup failed: ${url} (${response.statusCode})`);
  return response.json();
};
const courses = (await app.inject({ method: "GET", url: "/api/courses" })).json<Array<{ id: string }>>();
if (!courses.length) {
  const course = await inject("POST", "/api/courses", { name: "试用示例课程" }) as { id: string };
  await inject("POST", "/api/courses", { name: "尚未发布资料的课程" });
  const imported = await inject("POST", `/api/courses/${course.id}/imports`, { files: [{ relativePath: "说明.md", content: "# 报告要求\n报告包含问题、方法、结果与反思。\n" }] }) as { id: string; draftVersion: number; manifestHash: string };
  await inject("POST", `/api/courses/${course.id}/imports/${imported.id}/publish`, { expectedVersion: imported.draftVersion, expectedManifestHash: imported.manifestHash });
  const assignment = await inject("POST", "/api/rubrics/assignments", { courseId: course.id, title: "试用报告评分表", totalScore: 10, requirements: "检查研究报告结构和论证。", sources: [] }) as { id: string };
  await inject("PUT", `/api/rubrics/assignments/${assignment.id}/mode`, { mode: "additive" });
  await inject("PUT", `/api/rubrics/assignments/${assignment.id}/draft`, { expectedVersion: 0, rubric: {
    schemaVersion: "1.0", mode: "additive", totalScore: 10, partialCreditAllowed: true,
    criteria: [{ id: "C1", name: "报告完整性与论证", description: "核对报告结构和论证。", maxScore: 10, scorePolicy: "range", evidenceRequired: true,
      levels: [{ id: "L1", minScore: 5, maxScore: 10, condition: "主要结构完整" }, { id: "L0", minScore: 0, maxScore: 4.99, condition: "关键内容缺失" }] }],
  } });
  await inject("POST", `/api/rubrics/assignments/${assignment.id}/freeze`, { expectedVersion: 1, acknowledgedWarningCodes: [] });
}
const fixtures = path.join(workspaceRoot, "synthetic-fixtures");
await mkdir(fixtures, { recursive: true });
for (const [number, name] of [["20261001", "示例学生甲"], ["20261002", "示例学生乙"]]) {
  await writeFile(path.join(fixtures, `${number}_${name}_研究报告.md`), "# 合成研究报告\n\n## 问题\n研究课程知识如何帮助理解报告。\n\n## 方法\n比较两种说明方式。\n\n## 结果\n结构清晰的说明更容易理解。\n\n## 反思\n需要更多量化数据。\n", "utf8");
}

await app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic UX acceptance ready: http://127.0.0.1:${port} ; fixtures: ${fixtures}`);
process.once("SIGINT", () => { void app.close(); });
