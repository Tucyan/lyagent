import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RubricDocument } from "../web/src/components/RubricPreviewEditor.js";

describe("rubric teacher preview", () => {
  it("renders a human-readable scorecard instead of raw JSON", () => {
    const html = renderToStaticMarkup(<RubricDocument rubric={{
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [{ id: "late", name: "迟交", condition: "超过截止时间提交", deduction: 10, maxDeduction: 10, occurrence: "once", evidenceRequired: true }],
      overlapGroups: [],
    }} />);

    expect(html).toContain("扣分规则");
    expect(html).toContain("迟交");
    expect(html).toContain("−10 分");
    expect(html).not.toContain("&quot;schemaVersion&quot;");
  });

  it("shows score levels, evidence policy, and overlap aggregation", () => {
    const html = renderToStaticMarkup(<RubricDocument rubric={{
      schemaVersion: "1.0",
      mode: "hybrid",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [{ id: "analysis", name: "分析", description: "分析质量", maxScore: 100, scorePolicy: "range", evidenceRequired: true, levels: [{ id: "excellent", minScore: 80, maxScore: 100, condition: "证据充分" }] }],
      bonusRules: [],
      deductionRules: [{ id: "missing", name: "缺少引用", condition: "没有来源", deduction: 5, maxDeduction: 10, occurrence: "per-occurrence", evidenceRequired: true, overlapGroup: "evidence" }],
      overlapGroups: [{ id: "evidence", aggregation: "highest-only" }],
    }} />);

    expect(html).toContain("允许部分得分");
    expect(html).toContain("excellent");
    expect(html).toContain("80–100 分");
    expect(html).toContain("重叠组：evidence");
    expect(html).toContain("仅取最高项");
  });
});
