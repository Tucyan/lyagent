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

const drafts = new Map<string, any>([
  ["s3", { version: 1, result: { score: { earned: 74, possible: 100 }, confidence: { overall: 0.72 }, decisions: { mode: "deductive", deductions: [{ ruleId: "D1", triggered: true, deduction: 26, confidence: 0.7 }] } }, updatedAt: "2026-08-05T08:00:00.000Z" }],
]);

const batches = {
  async getBatch(batchId: string) {
    if (batchId !== "b1") throw new Error("Batch not found");
    return {
      id: "b1",
      courseId: "c1",
      title: "一班批改",
      assignmentId: "a1",
      rubricVersion: 1,
      jobs: [
        { id: "j1", sessionId: "s1", status: "completed" },
        { id: "j2", sessionId: "s3", status: "needs_review" },
      ],
    };
  },
};

const service = new GradingCsvExportService(
  {
    async getSession(id: string) {
      const found = sessions.find((s) => s.id === id);
      if (!found) throw new Error("Session not found");
      return found;
    },
    async listSessions(filter: any) { return sessions.filter((session) => !filter.studentNumber || session.studentNumber === filter.studentNumber).filter((session) => !filter.assignmentId || session.assignmentId === filter.assignmentId).filter((session) => !filter.rubricVersion || session.rubricVersion === filter.rubricVersion); },
  } as any,
  {
    async readConfirmedResult(id: string) { return confirmed.get(id); },
    async readDraft(id: string) { return drafts.get(id); },
  } as any,
  rubrics as any,
  batches as any,
);

describe("GradingCsvExportService", () => {
  it("exports all confirmed assignments for one student with rubricName column, scoreRate, uniform-score detection, and compact detail headings", async () => {
    const preview = await service.preview({
      scope: { kind: "student", courseId: "c1", studentNumber: "20260001" },
      columns: { studentName: true, studentNumber: true, submissionTitle: true, rubricName: true, itemDetails: true, itemConfidence: true, totalScore: true, possibleScore: true, scoreRate: true, overallConfidence: true },
    });
    const csv = preview.csvText;
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("学生姓名,学号,作业名称,评分标准");
    expect(csv).toContain("总分,满分,得分率,总置信度");
    expect(csv).toContain("报告评分表 v1");
    expect(csv).toContain("短文评分表 v1");
    expect(csv).toContain(",论证不足,论证不足（置信度）,内容质量,内容质量（置信度）,");
    expect(csv).not.toContain("扣分点：");
    expect(csv).not.toContain("得分点：");
    expect(csv).toContain("'=恶意姓名,20260001,\"低碳,交通\",报告评分表 v1");
    expect(csv).toContain("-18,0.75");
    expect(csv).toContain("82,100,82.0%,0.8");
    expect(csv).toContain("9,0.95,9,10,90.0%,0.95");
    expect(preview.rows[0]).toMatchObject({ rubricKey: "a1:1", rubricTitle: "报告评分表 v1" });
    expect(preview.summary).toMatchObject({
      hasUniformPossibleScore: false,
      commonPossibleScore: null,
      averageScoreRate: 86,
      highestScoreRate: 90,
      lowestScoreRate: 82,
    });
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("disambiguates detail headings only when item names collide across multiple rubrics", async () => {
    const sharedSessions = [
      { id: "x1", courseId: "c1", assignmentId: "a1", rubricVersion: 1, studentName: "王五", studentNumber: "20260003", submissionTitle: "第一次", gradingStatus: "confirmed" },
      { id: "x2", courseId: "c1", assignmentId: "a2", rubricVersion: 1, studentName: "王五", studentNumber: "20260003", submissionTitle: "第二次", gradingStatus: "confirmed" },
    ] as any[];
    const sharedConfirmed = new Map<string, any>([
      ["x1", { result: { score: { earned: 18, possible: 20 }, confidence: { overall: 0.9 }, decisions: { mode: "additive", criteria: [{ criterionId: "C1", score: 10, confidence: 0.9 }, { criterionId: "C2", score: 8, confidence: 0.85 }] } } }],
      ["x2", { result: { score: { earned: 9, possible: 10 }, confidence: { overall: 0.92 }, decisions: { mode: "additive", criteria: [{ criterionId: "C1", score: 9, confidence: 0.92 }] } } }],
    ]);
    const sharedRubrics = {
      async getAssignment(id: string) { return { id, title: id === "a1" ? "实验一评分标准" : "实验二评分标准" }; },
      async getVersion(id: string) {
        return id === "a1"
          ? { rubric: { mode: "additive", criteria: [{ id: "C1", name: "内容质量" }, { id: "C2", name: "唯一指标" }] } }
          : { rubric: { mode: "additive", criteria: [{ id: "C1", name: "内容质量" }] } };
      },
    };
    const collisionService = new GradingCsvExportService(
      { async listSessions() { return sharedSessions; } } as any,
      { async readConfirmedResult(id: string) { return sharedConfirmed.get(id); } } as any,
      sharedRubrics as any,
    );
    const preview = await collisionService.preview({
      scope: { kind: "student", courseId: "c1", studentNumber: "20260003" },
      columns: { submissionTitle: true, rubricName: true, itemDetails: true, itemConfidence: true },
    });
    expect(preview.headers).toEqual([
      "作业名称",
      "评分标准",
      "内容质量（实验一评分标准 v1）",
      "内容质量（实验一评分标准 v1 · 置信度）",
      "唯一指标",
      "唯一指标（置信度）",
      "内容质量（实验二评分标准 v1）",
      "内容质量（实验二评分标准 v1 · 置信度）",
    ]);
  });

  it("exports only confirmed rows for one exact frozen rubric and rejects empty columns", async () => {
    const csv = await service.export({ scope: { kind: "rubric", assignmentId: "a1", rubricVersion: 1 }, columns: { studentName: true, totalScore: true } });
    expect(csv).toContain("学生姓名,总分");
    expect(csv).toContain("'=恶意姓名,82");
    expect(csv).not.toContain("李华");
    await expect(service.export({ scope: { kind: "rubric", assignmentId: "a1", rubricVersion: 1 }, columns: {} })).rejects.toThrow(/column/i);
  });

  it("includes rubric detail column headers even when no confirmed rows exist for rubric scope", async () => {
    const emptyService = new GradingCsvExportService(
      { async listSessions() { return []; } } as any,
      { async readConfirmedResult() { return undefined; } } as any,
      rubrics as any,
    );
    const csv = await emptyService.export({
      scope: { kind: "rubric", assignmentId: "a1", rubricVersion: 1 },
      columns: { studentName: true, studentNumber: true, submissionTitle: true, rubricName: true, itemDetails: true, totalScore: true, overallConfidence: true },
    });
    const headerLine = csv.replace(/^\ufeff/, "").trim().split(/\r?\n/)[0] ?? "";
    expect(headerLine).toContain("学生姓名,学号,作业名称,评分标准,论证不足,总分,总置信度");
    expect(headerLine.split(",")).toHaveLength(7);
  });

  it("exports batch scope with optional unconfirmed drafts, possibleScore, reviewStatus, and structured preview stats", async () => {
    const confirmedOnly = await service.preview({
      scope: { kind: "batch", batchId: "b1", includeUnconfirmed: false },
      columns: { studentName: true, studentNumber: true, totalScore: true, possibleScore: true, reviewStatus: true },
    });
    expect(confirmedOnly.headers).toEqual(["学生姓名", "学号", "总分", "满分", "复核状态"]);
    expect(confirmedOnly.rows).toHaveLength(1);
    expect(confirmedOnly.rows[0]).toMatchObject({
      sessionId: "s1",
      studentNumber: "20260001",
      reviewStatus: "confirmed",
      earnedScore: 82,
      possibleScore: 100,
    });
    expect(confirmedOnly.summary).toEqual({
      totalCount: 1,
      uniqueStudentCount: 1,
      confirmedCount: 1,
      needsReviewCount: 0,
      averageScore: 82,
      highestScore: 82,
      lowestScore: 82,
      hasUniformPossibleScore: true,
      commonPossibleScore: 100,
      averageScoreRate: 82,
      highestScoreRate: 82,
      lowestScoreRate: 82,
    });

    const withUnconfirmed = await service.preview({
      scope: { kind: "batch", batchId: "b1", includeUnconfirmed: true },
      columns: { studentName: true, studentNumber: true, itemDetails: true, totalScore: true, possibleScore: true, reviewStatus: true },
    });
    expect(withUnconfirmed.rows).toHaveLength(2);
    expect(withUnconfirmed.summary).toEqual({
      totalCount: 2,
      uniqueStudentCount: 2,
      confirmedCount: 1,
      needsReviewCount: 1,
      averageScore: 78,
      highestScore: 82,
      lowestScore: 74,
      hasUniformPossibleScore: true,
      commonPossibleScore: 100,
      averageScoreRate: 78,
      highestScoreRate: 82,
      lowestScoreRate: 74,
    });
    expect(withUnconfirmed.csvText).toContain("已确认");
    expect(withUnconfirmed.csvText).toContain("待复核");
    expect(withUnconfirmed.csvText).toContain("'=恶意姓名");
  });
});
