import { describe, expect, it } from "vitest";
import { GradingCsvExportService } from "../src/services/grading-csv-export-service.js";

const sessions = [
  { id: "s1", courseId: "c1", assignmentId: "a1", rubricVersion: 1, studentName: "=恶意姓名", studentNumber: "20260001", submissionTitle: "低碳,交通", gradingStatus: "confirmed" },
  { id: "s2", courseId: "c1", assignmentId: "a2", rubricVersion: 1, studentName: "张晓明", studentNumber: "20260001", submissionTitle: "人工智能伦理", gradingStatus: "confirmed" },
  { id: "s3", courseId: "c1", assignmentId: "a1", rubricVersion: 1, studentName: "李华", studentNumber: "20260002", submissionTitle: "城市更新", gradingStatus: "draft_ready" },
] as any[];

const confirmed = new Map<string, any>([
  ["s1", { result: { score: { earned: 82, possible: 100 }, confidence: { overall: 0.8 }, decisions: { mode: "deductive", deductions: [{ ruleId: "D1", triggered: true, deduction: 18, confidence: 0.75 }] } } }],
  ["s2", { result: { score: { earned: 9, possible: 10 }, confidence: { overall: 0.95 }, decisions: { mode: "additive", criteria: [{ criterionId: "C1", score: 9, confidence: 0.95 }] } } }],
]);

const rubrics = {
  async getAssignment(id: string) { return { id, title: id === "a1" ? "报告评分表" : "短文评分表" }; },
  async getVersion(id: string) {
    return id === "a1"
      ? { rubric: { mode: "deductive", rules: [{ id: "D1", name: "论证不足" }] } }
      : { rubric: { mode: "additive", criteria: [{ id: "C1", name: "内容质量" }] } };
  },
};

const service = new GradingCsvExportService(
  { async listSessions(filter: any) { return sessions.filter((session) => !filter.studentNumber || session.studentNumber === filter.studentNumber).filter((session) => !filter.assignmentId || session.assignmentId === filter.assignmentId).filter((session) => !filter.rubricVersion || session.rubricVersion === filter.rubricVersion); } } as any,
  { async readConfirmedResult(id: string) { return confirmed.get(id); } } as any,
  rubrics as any,
);

describe("GradingCsvExportService", () => {
  it("exports all confirmed assignments for one student with configurable details", async () => {
    const csv = await service.export({ scope: { kind: "student", courseId: "c1", studentNumber: "20260001" }, columns: { studentName: true, studentNumber: true, submissionTitle: true, itemDetails: true, itemConfidence: true, totalScore: true, overallConfidence: true } });
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("学生姓名,学号,作业名称");
    expect(csv).toContain("报告评分表 v1 · 扣分点：论证不足");
    expect(csv).toContain("报告评分表 v1 · 置信度：论证不足");
    expect(csv).toContain("短文评分表 v1 · 得分点：内容质量");
    expect(csv).toContain("'=恶意姓名,20260001,\"低碳,交通\"");
    expect(csv).toContain("-18,0.75");
    expect(csv).toContain("9,0.95,9,0.95");
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("exports only confirmed rows for one exact frozen rubric and rejects empty columns", async () => {
    const csv = await service.export({ scope: { kind: "rubric", assignmentId: "a1", rubricVersion: 1 }, columns: { studentName: true, totalScore: true } });
    expect(csv).toContain("学生姓名,总分");
    expect(csv).toContain("'=恶意姓名,82");
    expect(csv).not.toContain("李华");
    await expect(service.export({ scope: { kind: "rubric", assignmentId: "a1", rubricVersion: 1 }, columns: {} })).rejects.toThrow(/column/i);
  });
});
