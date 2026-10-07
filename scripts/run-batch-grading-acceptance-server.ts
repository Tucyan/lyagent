import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { GradingAgentBuilder } from "../src/api/grading-routes.js";
import { createServer } from "../src/api/server.js";
import { registerWebAssets } from "../src/api/web-assets.js";

const workspaceRoot = path.resolve(process.env.COURSE_AGENT_WORKSPACE ?? "workspace-m5-acceptance");
await mkdir(workspaceRoot, { recursive: true });
const grader: GradingAgentBuilder = (sessionId, runId, services) => ({
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const stored = await services.results.submitDraft(sessionId, 0, {
      schemaVersion: "1.0",
      mode: "additive",
      criteria: [{
        criterionId: "C1",
        selectedLevelId: "L1",
        score: 8,
        reason: "合成报告覆盖主要要求，仍可补充细节。",
        evidence: [{
          kind: "analysis",
          observation: "报告包含问题、方法、结果与反思。",
          rubricBasis: "对应完整性与论证质量标准。",
          scoreJustification: "达到良好等级，保留两分改进空间。",
        }],
        confidence: 0.9,
      }],
      strengths: ["结构完整"],
      improvements: ["补充量化证据"],
      warnings: [],
    }, { type: "agent", id: runId });
    return { kind: "draft", draft: stored };
  },
});
const titleAgent: GradingAgentBuilder = (sessionId, _runId, services) => ({
  async run() {
    const title = "合成报告";
    await services.sessions.resolveSubmissionTitle(sessionId, title);
    return { kind: "title", title };
  },
});

const app = await createServer({
  workspaceRoot,
  studentIdentityClient: {
    async identify(filename) {
      const match = /^(\d+)_([^_]+)_/.exec(filename);
      if (!match) throw new Error("Synthetic fixture filename is invalid");
      return { studentNumber: match[1]!, studentName: match[2]! };
    },
  },
  gradingAgentFactory: grader,
  submissionTitleAgentFactory: titleAgent,
  modelStatus: { provider: "deterministic-acceptance", model: "m5-fake", configured: true },
});

await registerWebAssets(app, path.resolve("dist/web"));
const courses = (await app.inject({ method: "GET", url: "/api/courses" })).json<Array<{ id: string }>>();
if (courses.length === 0) {
  await app.inject({ method: "POST", url: "/api/courses", payload: { name: "M5 合成验收课程" } });
  const assignment = (await app.inject({
    method: "POST",
    url: "/api/rubrics/assignments",
    payload: { title: "M5 合成报告评分表", totalScore: 10, requirements: "评价合成研究报告的完整性与论证。", sources: [] },
  })).json<{ id: string }>();
  await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
  await app.inject({
    method: "PUT",
    url: `/api/rubrics/assignments/${assignment.id}/draft`,
    payload: {
      expectedVersion: 0,
      rubric: {
        schemaVersion: "1.0",
        mode: "additive",
        totalScore: 10,
        partialCreditAllowed: true,
        criteria: [{
          id: "C1",
          name: "报告完整性与论证",
          maxScore: 10,
          description: "检查问题、方法、结果与反思。",
          scorePolicy: "range",
          evidenceRequired: true,
          levels: [{ id: "L1", minScore: 5, maxScore: 10, condition: "主要结构完整" }, { id: "L0", minScore: 0, maxScore: 4.99, condition: "关键内容缺失" }],
        }],
      },
    },
  });
  await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: [] } });
}
const port = Number(process.env.PORT ?? 3001);
await app.listen({ host: "127.0.0.1", port });
console.log(`M5 deterministic acceptance server ready at http://127.0.0.1:${port}/grading/batches (${workspaceRoot})`);
