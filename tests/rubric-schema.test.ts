import { describe, expect, it } from "vitest";
import {
  calculateRubricScore,
  upgradeRubricV1ToV2,
  validateRubric,
  type AdditiveRubric,
  type Rubric,
  type RubricV2,
} from "../src/schemas/rubric.js";

const additive: AdditiveRubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 100,
  partialCreditAllowed: true,
  criteria: [
    {
      id: "content",
      name: "内容分析",
      description: "评价分析质量",
      maxScore: 100,
      scorePolicy: "range",
      evidenceRequired: true,
      levels: [
        { id: "excellent", minScore: 80, maxScore: 100, condition: "分析完整" },
        { id: "basic", minScore: 0, maxScore: 79.99, condition: "分析不足" },
      ],
    },
  ],
};
const additiveCriterion = additive.criteria[0]!;

describe("rubric schema", () => {
  it("accepts contiguous additive ranges and totals criterion scores", () => {
    expect(validateRubric(additive).errors).toEqual([]);
    expect(calculateRubricScore(additive, { criteria: { content: 86.5 } })).toBe(86.5);
  });

  it("rejects additive criteria whose maxima do not equal the total score", () => {
    const invalid: Rubric = { ...additive, criteria: [{ ...additiveCriterion, maxScore: 90 }] };

    expect(validateRubric(invalid).errors).toContainEqual(expect.objectContaining({ code: "CRITERIA_TOTAL_MISMATCH" }));
  });

  it("applies deductions from the maximum score and honours highest-only overlap groups", () => {
    const rubric: Rubric = {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [
        { id: "missing-analysis", name: "缺少分析", condition: "没有分析", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true, overlapGroup: "analysis" },
        { id: "weak-analysis", name: "分析不足", condition: "分析很弱", deduction: 10, maxDeduction: 10, occurrence: "once", evidenceRequired: true, overlapGroup: "analysis" },
      ],
      overlapGroups: [{ id: "analysis", aggregation: "highest-only" }],
    };

    expect(calculateRubricScore(rubric, { deductions: { "missing-analysis": 20, "weak-analysis": 10 } })).toBe(80);
  });

  it("accepts fixed, per-occurrence, and integer range deduction rules together", () => {
    const rubric: Rubric = {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [
        { id: "fixed", name: "Fixed", condition: "Missing", amountPolicy: "fixed", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
        { id: "repeated", name: "Repeated", condition: "Each error", amountPolicy: "per-occurrence", deduction: 2, maxDeduction: 10, occurrence: "per-occurrence", evidenceRequired: true },
        { id: "severity", name: "Severity", condition: "Weak quality", amountPolicy: "range", maxDeduction: 20, occurrence: "once", evidenceRequired: true },
      ],
      overlapGroups: [],
    };

    expect(validateRubric(rubric).errors).toEqual([]);
    expect(calculateRubricScore(rubric, { deductions: { fixed: 20, repeated: 6, severity: 4 } })).toBe(70);
  });

  it("rejects range deductions configured as per-occurrence", () => {
    const rubric = {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [{ id: "severity", name: "Severity", condition: "Weak quality", amountPolicy: "range", maxDeduction: 20, occurrence: "per-occurrence", evidenceRequired: true }],
      overlapGroups: [],
    } as const;

    expect(validateRubric(rubric).errors).toContainEqual(expect.objectContaining({ code: "RANGE_DEDUCTION_MUST_BE_ONCE" }));
  });

  it("clamps hybrid criteria plus bonuses minus deductions to the assignment total", () => {
    const rubric: Rubric = {
      schemaVersion: "1.0",
      mode: "hybrid",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [{ ...additiveCriterion }],
      bonusRules: [{ id: "insight", name: "额外洞察", condition: "有额外洞察", bonus: 8, maxBonus: 8, occurrence: "once", evidenceRequired: true }],
      deductionRules: [{ id: "citation", name: "引用缺失", condition: "缺少引用", deduction: 15, maxDeduction: 15, occurrence: "once", evidenceRequired: true }],
      overlapGroups: [],
    };

    expect(calculateRubricScore(rubric, { criteria: { content: 98 }, bonuses: { insight: 8 }, deductions: { citation: 3 } })).toBe(100);
  });

  it("enforces duplicate level IDs, integer range maxDeduction, and warns on continuous level gaps or disabled partial credit", () => {
    const dupLevelRubric: Rubric = {
      ...additive,
      criteria: [{
        ...additiveCriterion,
        levels: [
          { id: "dup", minScore: 50, maxScore: 100, condition: "好" },
          { id: "dup", minScore: 0, maxScore: 49.99, condition: "差" },
        ],
      }],
    };
    expect(validateRubric(dupLevelRubric).errors).toContainEqual(expect.objectContaining({ code: "DUPLICATE_LEVEL_ID" }));

    const continuousGap: Rubric = {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 10,
      partialCreditAllowed: false,
      criteria: [{
        id: "fmt",
        name: "格式",
        description: "格式说明",
        maxScore: 10,
        scorePolicy: "continuous",
        evidenceRequired: true,
        levels: [
          { id: "excellent", minScore: 8, maxScore: 10, condition: "优" },
          { id: "fail", minScore: 0, maxScore: 1, condition: "差" },
        ],
      }],
    };
    const res = validateRubric(continuousGap);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: "CONTINUOUS_LEVELS_GAP_OR_OVERLAP" }));
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: "PARTIAL_CREDIT_DISABLED_WITH_RANGE" }));

    const fractionalRangeDeduction: Rubric = {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [{ id: "r1", name: "R1", condition: "Weak", amountPolicy: "range", maxDeduction: 0.5, occurrence: "once", evidenceRequired: true }],
      overlapGroups: [],
    };
    expect(validateRubric(fractionalRangeDeduction).errors).toContainEqual(expect.objectContaining({ code: "RANGE_DEDUCTION_MUST_BE_INTEGER" }));
  });

  it("supports v2.0 step-aligned natural intervals without 0.01 gaps, fractional range rules, and scoreCaps", () => {
    const v2: RubricV2 = {
      schemaVersion: "2.0",
      mode: "hybrid",
      totalScore: 100,
      criteria: [
        {
          id: "analysis",
          name: "核心分析",
          description: "分析质量",
          maxScore: 80,
          scoringType: "scored",
          step: 1,
          evidenceRequired: true,
          levels: [
            { id: "fail", label: "不合格", minScore: 0, maxScore: 47, condition: "缺失关键内容" },
            { id: "pass", label: "合格", minScore: 48, maxScore: 63, condition: "基本完成" },
            { id: "excellent", label: "优秀", minScore: 64, maxScore: 80, condition: "全面深入" },
          ],
        },
        {
          id: "submission",
          name: "必交材料",
          description: "按要求提交附件",
          maxScore: 20,
          scoringType: "levels",
          evidenceRequired: false,
          levels: [
            { id: "full", label: "达标", score: 20, condition: "完整提交" },
            { id: "zero", label: "未达标", score: 0, condition: "缺失材料" },
          ],
        },
      ],
      bonusRules: [
        { id: "insight", name: "额外洞察", condition: "有额外深度洞察", policy: "range", maxAmount: 5, step: 0.5, evidenceRequired: true },
      ],
      deductionRules: [
        { id: "format", name: "格式问题", condition: "格式扣分", policy: "range", maxAmount: 2.5, step: 0.5, evidenceRequired: false },
      ],
      scoreCaps: [
        { id: "too_short", name: "字数严重不足", condition: "正文不足300字", maxTotalScore: 30, evidenceRequired: true },
      ],
      overlapGroups: [],
    };

    expect(validateRubric(v2)).toEqual({ errors: [], warnings: [] });
    expect(calculateRubricScore(v2, { criteria: { analysis: 70, submission: 20 }, bonuses: { insight: 3.5 }, deductions: { format: 1.5 } })).toBe(92);
    expect(calculateRubricScore(v2, { criteria: { analysis: 70, submission: 20 }, scoreCaps: { too_short: true } })).toBe(30);
  });

  it("rejects overlapping v2.0 levels, misaligned steps, and invalid scoreCaps", () => {
    const invalidV2: RubricV2 = {
      schemaVersion: "2.0",
      mode: "additive",
      totalScore: 100,
      criteria: [
        {
          id: "c1",
          name: "项目一",
          description: "说明",
          maxScore: 100,
          scoringType: "scored",
          step: 1,
          evidenceRequired: false,
          levels: [
            { id: "l1", minScore: 0, maxScore: 60, condition: "低" },
            { id: "l2", minScore: 60, maxScore: 100, condition: "高" },
          ],
        },
      ],
      scoreCaps: [
        { id: "bad_cap", name: "无效封顶", condition: "条件", maxTotalScore: 100, evidenceRequired: false },
      ],
    };
    const res = validateRubric(invalidV2);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: "LEVEL_OVERLAP" }));
    expect(res.errors).toContainEqual(expect.objectContaining({ code: "SCORE_CAP_NOT_BELOW_TOTAL" }));
  });

  it("losslessly upgrades v1.0 rubrics to v2.0 when creating revisions", () => {
    const upgraded = upgradeRubricV1ToV2({
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 10,
      partialCreditAllowed: false,
      criteria: [{ id: "c1", name: "必答", description: "全对才给分", maxScore: 10, scorePolicy: "continuous", evidenceRequired: true }],
    });
    expect(upgraded.schemaVersion).toBe("2.0");
    expect(upgraded.mode === "additive" && upgraded.criteria[0]).toMatchObject({
      scoringType: "levels",
      levels: [
        expect.objectContaining({ score: 10 }),
        expect.objectContaining({ score: 0 }),
      ],
    });
    expect(validateRubric(upgraded).errors).toEqual([]);
  });
});
