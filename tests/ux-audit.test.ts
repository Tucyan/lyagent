import { describe, expect, it } from "vitest";
import { validateRubric } from "../src/schemas/rubric.js";
import { finalizeGradingDraft, type LockedSubmission } from "../src/schemas/grading.js";

describe("UX and interaction experience audit", () => {
  it("exposes raw English error messages and schema paths in rubric validation", () => {
    // 1. 评分表总分不匹配时，错误信息为纯英文，且包含原始 schema 路径
    const invalidRubric = {
      schemaVersion: "1.0",
      mode: "additive" as const,
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        {
          id: "criterion_1",
          name: "核心论点",
          description: "论点是否明确",
          maxScore: 60,
          scorePolicy: "continuous" as const,
          evidenceRequired: true,
        },
      ],
    };

    const result = validateRubric(invalidRubric);
    expect(result.errors.length).toBeGreaterThan(0);
    // 检验其直接生成英文提示 "Criterion maxima must equal the rubric total score"
    expect(result.errors[0]?.message).toBe("Criterion maxima must equal the rubric total score");
    // 检验其包含原始后端 schema path "criteria"
    expect(result.errors[0]?.path).toBe("criteria");
  });

  it("exposes raw English enum codes for review reasons in grading results", () => {
    // 2. 批改结果中的复核原因直接生成后端英文大写枚举，没有本地化文案
    const rubric = {
      schemaVersion: "1.0" as const,
      mode: "additive" as const,
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        {
          id: "c1",
          name: "标准1",
          description: "说明1",
          maxScore: 100,
          scorePolicy: "continuous" as const,
          evidenceRequired: false,
        },
      ],
    };

    const submission: LockedSubmission = {
      path: "submission.md",
      lineCount: 1,
      hash: "a".repeat(64),
      lines: ["学生作业内容"],
    };

    const draft = {
      schemaVersion: "1.0",
      mode: "additive" as const,
      criteria: [
        {
          criterionId: "c1",
          score: 80,
          confidence: 0.5, // 低于 0.7 阈值
          reason: "评分理由",
          evidence: [],
        },
      ],
      strengths: [],
      improvements: [],
      warnings: ["转换轻微格式异常"],
    };

    const finalized = finalizeGradingDraft({ rubric, submission, draft });
    expect(finalized.review.requiresReview).toBe(true);
    // 教师复核原因包含原始大写英文常量
    expect(finalized.review.reasons).toContain("LOW_CONFIDENCE");
    expect(finalized.review.reasons).toContain("CONVERSION_WARNING");
    // 在前端中直接展示给教师这些英文枚举字符串
  });

  it("throws raw English developer errors on manual grading draft score mismatch", () => {
    // 3. 教师手动修改评分草稿时，分数超过上限抛出纯英文错误
    const rubric = {
      schemaVersion: "1.0" as const,
      mode: "additive" as const,
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        {
          id: "crit_writing",
          name: "写作规范",
          description: "格式规范",
          maxScore: 20,
          scorePolicy: "continuous" as const,
          evidenceRequired: false,
        },
      ],
    };

    const submission: LockedSubmission = {
      path: "submission.md",
      lineCount: 1,
      hash: "b".repeat(64),
      lines: ["作业正文"],
    };

    const overScoreDraft = {
      schemaVersion: "1.0",
      mode: "additive" as const,
      criteria: [
        {
          criterionId: "crit_writing",
          score: 25, // 超过 maxScore 20
          confidence: 0.9,
          reason: "评分理由",
          evidence: [],
        },
      ],
      strengths: [],
      improvements: [],
      warnings: [],
    };

    expect(() =>
      finalizeGradingDraft({ rubric, submission, draft: overScoreDraft })
    ).toThrowError("Score for crit_writing exceeds its maximum");
  });
});
