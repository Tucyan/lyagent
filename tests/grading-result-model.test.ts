import { describe, expect, it } from "vitest";
import {
  collectAllEvidenceTargets,
  collectCitedLineNumbers,
  decisionEntries,
  isAttentionDecisionItem,
  nextStepHint,
  partitionDecisionEvidence,
  resolveLowConfidenceCount,
  splitLineHighlightSegments,
  summarizeGradingResult,
} from "../web/src/components/grading/grading-result-model.js";

describe("grading result progressive presentation model", () => {
  it("normalizes lowCount and lowConfidenceCount consistently", () => {
    expect(resolveLowConfidenceCount({ overall: 0.85, minimum: 0.65, lowCount: 2 })).toBe(2);
    expect(resolveLowConfidenceCount({ overall: 0.85, minimum: 0.65, lowConfidenceCount: 1 })).toBe(1);
    expect(resolveLowConfidenceCount({ overall: 0.9, minimum: 0.9 })).toBe(0);
  });

  it("partitions citation evidence from agent analysis entries", () => {
    const { citations, analyses } = partitionDecisionEvidence([
      { kind: "text", path: "submission.md", startLine: 1, endLine: 2, quote: "原文引用" },
      { kind: "analysis", observation: "表现", rubricBasis: "标准", scoreJustification: "理由" },
      { kind: "image", path: "assets/fig1.png", explanation: "图表" },
    ]);

    expect(citations).toHaveLength(2);
    expect(citations.map((item) => item.kind)).toEqual(["text", "image"]);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.kind).toBe("analysis");
  });

  it("detects attention items and summarizes overview status and next-step hints", () => {
    const decisions = {
      criteria: [
        { criterionId: "c1", score: 8, confidence: 0.92, reason: "完整" },
        { criterionId: "c2", score: 5, confidence: 0.62, reason: "边界模糊", evidenceInsufficient: true },
      ],
      deductions: [
        { ruleId: "d1", triggered: false, deduction: 0, confidence: 0.95, reason: "未触发" },
      ],
    };

    expect(decisionEntries(decisions)).toHaveLength(3);
    expect(isAttentionDecisionItem(decisions.criteria[0]!)).toBe(false);
    expect(isAttentionDecisionItem(decisions.criteria[1]!)).toBe(true);

    const summaryReview = summarizeGradingResult(
      {
        score: { earned: 13, possible: 20 },
        confidence: { overall: 0.77, minimum: 0.62, lowCount: 1 },
        review: { requiresReview: true, reasons: ["LOW_CONFIDENCE"] },
        decisions,
      },
      { mode: "single", confirmed: false },
    );

    expect(summaryReview).toMatchObject({
      earned: 13,
      possible: 20,
      scorePercent: 65,
      overallConfidencePercent: 77,
      minimumConfidencePercent: 62,
      lowConfidenceCount: 1,
      totalItems: 3,
      attentionItemCount: 1,
      requiresReview: true,
      statusLabel: "待复核",
      statusTone: "review",
    });
    expect(summaryReview.nextStep).toContain("待复核事项");

    const summaryReady = summarizeGradingResult(
      {
        score: { earned: 19, possible: 20 },
        confidence: { overall: 0.95, minimum: 0.9, lowConfidenceCount: 0 },
        review: { requiresReview: false, reasons: [] },
        decisions: { criteria: [decisions.criteria[0]!] },
      },
      { mode: "batch", confirmed: false },
    );
    expect(summaryReady.statusLabel).toBe("可确认发布");
    expect(summaryReady.statusTone).toBe("ready");
    expect(summaryReady.nextStep).toContain("可直接确认");

    expect(nextStepHint("single", true, false)).toContain("导出");
    expect(nextStepHint("batch", true, false)).toContain("下一份");
  });

  it("collects cited line numbers and splits quote highlight segments", () => {
    const cited = collectCitedLineNumbers({
      criteria: [
        {
          criterionId: "c1",
          evidence: [
            { kind: "text", path: "submission.md", startLine: 2, endLine: 4, quote: "核心内容" },
            { kind: "analysis", observation: "ok", rubricBasis: "ok", scoreJustification: "ok" },
          ],
        },
      ],
    });
    expect([...cited]).toEqual([2, 3, 4]);

    const segments = splitLineHighlightSegments("这里是核心内容展示区域", "核心内容");
    expect(segments).toEqual([
      { text: "这里是", highlighted: false },
      { text: "核心内容", highlighted: true },
      { text: "展示区域", highlighted: false },
    ]);

    const targets = collectAllEvidenceTargets(
      {
        criteria: [
          {
            criterionId: "c1",
            evidence: [
              { kind: "text", path: "submission.md", startLine: 2, endLine: 4, quote: "核心内容" },
              { kind: "analysis", observation: "ok", rubricBasis: "ok", scoreJustification: "ok" },
              { kind: "image", path: "assets/chart.png", explanation: "柱状图" },
            ],
          },
        ],
      },
      { criteria: [{ id: "c1", name: "核心论点" }] },
    );
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ key: "criteria:c1:0", kind: "text", itemLabel: "核心论点", startLine: 2, endLine: 4 });
    expect(targets[1]).toMatchObject({ key: "criteria:c1:1", kind: "image", itemLabel: "核心论点", path: "assets/chart.png" });
  });
});
