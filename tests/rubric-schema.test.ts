import { describe, expect, it } from "vitest";
import { calculateRubricScore, validateRubric, type AdditiveRubric, type Rubric } from "../src/schemas/rubric.js";

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
});
