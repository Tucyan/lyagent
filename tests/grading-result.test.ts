import { describe, expect, it } from "vitest";
import type { Rubric } from "../src/schemas/rubric.js";
import {
  GradingResultValidationError,
  finalizeGradingDraft,
  gradingDraftSchema,
} from "../src/schemas/grading.js";

const evidence = (startLine: number, endLine = startLine) => ({
  kind: "text" as const,
  path: "submission-v1.md",
  heading: "开发实现过程",
  startLine,
  endLine,
  quote: "合成报告中的短证据",
});

const deductiveRubric: Rubric = {
  schemaVersion: "1.0",
  mode: "deductive",
  totalScore: 100,
  rules: [
    { id: "background_missing", name: "缺少问题背景", condition: "未描述背景", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
    { id: "background_incomplete", name: "背景不完整", condition: "背景覆盖不完整", deduction: 10, maxDeduction: 10, occurrence: "once", evidenceRequired: true, overlapGroup: "background" },
    { id: "background_weak", name: "背景质量一般", condition: "背景重点不突出", deduction: 5, maxDeduction: 5, occurrence: "once", evidenceRequired: true, overlapGroup: "background" },
    { id: "process_no_output", name: "缺少系统输出", condition: "没有系统输出", deduction: 15, maxDeduction: 15, occurrence: "once", evidenceRequired: true },
  ],
  overlapGroups: [{ id: "background", aggregation: "highest-only" }],
};

describe("grading result schemas and deterministic calculation", () => {
  it("calculates a deductive result and applies overlap groups in program code", () => {
    const result = finalizeGradingDraft({
      rubric: deductiveRubric,
      submission: { path: "submission-v1.md", lineCount: 80, lines: Array(80).fill("合成报告中的短证据"), hash: "a".repeat(64) },
      draft: {
        schemaVersion: "1.0",
        mode: "deductive",
        deductions: [
          { ruleId: "background_missing", triggered: false, deduction: 0, reason: "背景完整", evidence: [evidence(5, 12)], confidence: 0.94 },
          { ruleId: "background_incomplete", triggered: true, deduction: 10, reason: "意义说明较少", evidence: [evidence(10)], confidence: 0.8 },
          { ruleId: "background_weak", triggered: true, deduction: 5, reason: "重点不够突出", evidence: [evidence(11)], confidence: 0.9 },
          { ruleId: "process_no_output", triggered: true, deduction: 15, reason: "只写了提示词", evidence: [evidence(40, 45)], confidence: 0.55 },
        ],
        strengths: ["结构清晰"],
        improvements: ["补充系统输出"],
        warnings: [],
      },
    });

    expect(result.score).toEqual({ earned: 75, possible: 100 });
    expect(result.confidence.overall).toBe(0.79);
    expect(result.confidence.minimum).toBe(0.55);
    expect(result.confidence.lowCount).toBe(1);
    expect(result.review.requiresReview).toBe(true);
    expect(result.review.reasons).toContain("LOW_CONFIDENCE");
  });

  it("rejects unknown rule IDs and evidence outside the locked submission", () => {
    expect(() => finalizeGradingDraft({
      rubric: deductiveRubric,
      submission: { path: "submission-v1.md", lineCount: 20, lines: Array(20).fill("合成报告中的短证据"), hash: "b".repeat(64) },
      draft: {
        schemaVersion: "1.0",
        mode: "deductive",
        deductions: [
          { ruleId: "unknown", triggered: true, deduction: 5, reason: "无效规则", evidence: [evidence(1)], confidence: 0.9 },
        ],
        strengths: [], improvements: [], warnings: [],
      },
    })).toThrow(GradingResultValidationError);

    expect(() => finalizeGradingDraft({
      rubric: deductiveRubric,
      submission: { path: "submission-v1.md", lineCount: 20, lines: Array(20).fill("合成报告中的短证据"), hash: "c".repeat(64) },
      draft: {
        schemaVersion: "1.0",
        mode: "deductive",
        deductions: deductiveRubric.rules.map((rule) => ({
          ruleId: rule.id,
          triggered: false,
          deduction: 0,
          reason: "未触发",
          evidence: [{ ...evidence(21), path: "../other-session/submission.md" }],
          confidence: 0.9,
        })),
        strengths: [], improvements: [], warnings: [],
      },
    })).toThrow(/current locked submission/i);
  });

  it("requires one decision for every deductive rule, including rules not triggered", () => {
    const parsed = gradingDraftSchema.safeParse({
      schemaVersion: "1.0",
      mode: "deductive",
      deductions: [],
      strengths: [], improvements: [], warnings: [],
    });
    expect(parsed.success).toBe(true);
    expect(() => finalizeGradingDraft({
      rubric: deductiveRubric,
      submission: { path: "submission-v1.md", lineCount: 10, lines: Array(10).fill("合成报告中的短证据"), hash: "d".repeat(64) },
      draft: parsed.data!,
    })).toThrow(/every rubric rule/i);
  });

  it("supports additive and hybrid drafts while keeping the score program-owned", () => {
    const additive: Rubric = {
      schemaVersion: "1.0", mode: "additive", totalScore: 10, partialCreditAllowed: true,
      criteria: [{ id: "quality", name: "质量", description: "成果质量", maxScore: 10, scorePolicy: "continuous", evidenceRequired: true }],
    };
    const additiveResult = finalizeGradingDraft({
      rubric: additive,
      submission: { path: "submission-v1.md", lineCount: 5, lines: Array(5).fill("合成报告中的短证据"), hash: "e".repeat(64) },
      draft: { schemaVersion: "1.0", mode: "additive", criteria: [{ criterionId: "quality", score: 8, reason: "完成良好", evidence: [evidence(2)], confidence: 0.8 }], strengths: [], improvements: [], warnings: [] },
    });
    expect(additiveResult.score.earned).toBe(8);

    const hybrid: Rubric = {
      schemaVersion: "1.0", mode: "hybrid", totalScore: 10, partialCreditAllowed: true,
      criteria: additive.criteria,
      bonusRules: [{ id: "bonus", name: "创新", condition: "有创新", bonus: 2, maxBonus: 2, occurrence: "once", evidenceRequired: true }],
      deductionRules: [{ id: "late", name: "迟交", condition: "迟交", deduction: 1, maxDeduction: 1, occurrence: "once", evidenceRequired: false }],
      overlapGroups: [],
    };
    const hybridResult = finalizeGradingDraft({
      rubric: hybrid,
      submission: { path: "submission-v1.md", lineCount: 5, lines: Array(5).fill("合成报告中的短证据"), hash: "f".repeat(64) },
      draft: {
        schemaVersion: "1.0", mode: "hybrid",
        criteria: [{ criterionId: "quality", score: 8, reason: "完成良好", evidence: [evidence(2)], confidence: 0.8 }],
        bonuses: [{ ruleId: "bonus", triggered: true, bonus: 2, reason: "方案创新", evidence: [evidence(3)], confidence: 0.9 }],
        deductions: [{ ruleId: "late", triggered: true, deduction: 1, reason: "迟交", evidence: [], confidence: 1 }],
        strengths: [], improvements: [], warnings: [],
      },
    });
    expect(hybridResult.score.earned).toBe(9);
  });

  it("enforces frozen level policies and rule occurrence increments", () => {
    const additive: Rubric = {
      schemaVersion: "1.0", mode: "additive", totalScore: 10, partialCreditAllowed: true,
      criteria: [{ id: "quality", name: "质量", description: "成果质量", maxScore: 10, scorePolicy: "range", evidenceRequired: false, levels: [
        { id: "low", minScore: 0, maxScore: 4, condition: "较弱" },
        { id: "high", minScore: 5, maxScore: 10, condition: "良好" },
      ] }],
    };
    const submission = { path: "submission-v1.md", lineCount: 5, lines: Array(5).fill("合成报告中的短证据"), hash: "1".repeat(64) };
    const base = { schemaVersion: "1.0" as const, mode: "additive" as const, strengths: [], improvements: [], warnings: [] };
    expect(() => finalizeGradingDraft({ rubric: additive, submission, draft: { ...base, criteria: [{ criterionId: "quality", selectedLevelId: "low", score: 8, reason: "不匹配", evidence: [], confidence: 1 }] } })).toThrow(/selected level/i);
    expect(() => finalizeGradingDraft({ rubric: additive, submission, draft: { ...base, criteria: [{ criterionId: "quality", score: 8, reason: "缺少等级", evidence: [], confidence: 1 }] } })).toThrow(/level.*required/i);
    expect(() => finalizeGradingDraft({ rubric: additive, submission, draft: { ...base, criteria: [{ criterionId: "quality", selectedLevelId: "low", score: 0.009, reason: "精度过高", evidence: [], confidence: 1 }] } })).toThrow(/two decimal/i);

    const perOccurrence: Rubric = { schemaVersion: "1.0", mode: "deductive", totalScore: 20, overlapGroups: [], rules: [
      { id: "error", name: "错误", condition: "每处错误", deduction: 3, maxDeduction: 9, occurrence: "per-occurrence", evidenceRequired: false },
    ] };
    expect(() => finalizeGradingDraft({ rubric: perOccurrence, submission, draft: { schemaVersion: "1.0", mode: "deductive", deductions: [{ ruleId: "error", triggered: true, deduction: 4, reason: "任意扣分", evidence: [], confidence: 1 }], strengths: [], improvements: [], warnings: [] } })).toThrow(/increment/i);
  });

  it("allows integer range deductions while preserving legacy fixed deductions", () => {
    const submission = { path: "submission-v1.md", lineCount: 1, lines: ["report"], hash: "3".repeat(64) };
    const rangeRubric: Rubric = { schemaVersion: "1.0", mode: "deductive", totalScore: 20, overlapGroups: [], rules: [
      { id: "severity", name: "Severity", condition: "Weak quality", amountPolicy: "range", maxDeduction: 20, occurrence: "once", evidenceRequired: false },
    ] };
    const rangeDraft = (deduction: number) => ({
      schemaVersion: "1.0" as const,
      mode: "deductive" as const,
      deductions: [{ ruleId: "severity", triggered: true, deduction, reason: "Severity-based deduction", evidence: [], confidence: 1 }],
      strengths: [], improvements: [], warnings: [],
    });

    expect(finalizeGradingDraft({ rubric: rangeRubric, submission, draft: rangeDraft(4) }).score.earned).toBe(16);
    expect(() => finalizeGradingDraft({ rubric: rangeRubric, submission, draft: rangeDraft(4.5) })).toThrow(/integer/i);
    expect(() => finalizeGradingDraft({ rubric: rangeRubric, submission, draft: rangeDraft(21) })).toThrow(/maximum/i);

    const legacyFixed: Rubric = { schemaVersion: "1.0", mode: "deductive", totalScore: 20, overlapGroups: [], rules: [
      { id: "fixed", name: "Fixed", condition: "Missing", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: false },
    ] };
    const fixedDraft = { ...rangeDraft(4), deductions: [{ ...rangeDraft(4).deductions[0]!, ruleId: "fixed" }] };
    expect(() => finalizeGradingDraft({ rubric: legacyFixed, submission, draft: fixedDraft })).toThrow(/fixed/i);
  });

  it("rejects a fabricated quote even when its path and line range are valid", () => {
    expect(() => finalizeGradingDraft({
      rubric: deductiveRubric,
      submission: { path: "submission-v1.md", lineCount: 80, lines: Array(80).fill("真实正文"), hash: "2".repeat(64) },
      draft: {
        schemaVersion: "1.0", mode: "deductive",
        deductions: deductiveRubric.rules.map((rule) => ({ ruleId: rule.id, triggered: false, deduction: 0, reason: "未触发", evidence: [{ ...evidence(1), quote: "伪造引文" }], confidence: 0.9 })),
        strengths: [], improvements: [], warnings: [],
      },
    })).toThrow(/quote must occur/i);
  });

  it("accepts a structured grading argument as required evidence without a verbatim quote", () => {
    const draft = {
      schemaVersion: "1.0" as const,
      mode: "deductive" as const,
      deductions: deductiveRubric.rules.map((rule) => ({
        ruleId: rule.id,
        triggered: rule.id === "background_incomplete",
        deduction: rule.id === "background_incomplete" ? 10 : 0,
        reason: "根据完成度作出判断",
        evidence: [{
          kind: "analysis" as const,
          observation: "报告提到了问题背景，但意义部分只有一句概括。",
          rubricBasis: "该规则要求完整呈现背景、待解决问题和意义。",
          scoreJustification: "三项中有一项明显不充分，因此触发中等程度扣分10分。",
        }],
        confidence: 0.9,
      })),
      strengths: [], improvements: [], warnings: [],
    };

    expect(finalizeGradingDraft({ rubric: deductiveRubric, submission: { path: "submission-v1.md", lineCount: 80, lines: Array(80).fill("合成报告中的短证据"), hash: "a".repeat(64) }, draft }).score).toEqual({ earned: 90, possible: 100 });
  });
});
