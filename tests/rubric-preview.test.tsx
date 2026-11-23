import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RubricDocument, RubricEditor } from "../web/src/components/RubricPreviewEditor.js";

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

  it("offers all three deduction strategies per rule", () => {
    const html = renderToStaticMarkup(<RubricEditor onChange={() => undefined} rubric={{
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [{ id: "severity", name: "Severity", condition: "By severity", amountPolicy: "range", maxDeduction: 20, occurrence: "once", evidenceRequired: true }],
      overlapGroups: [],
    }} />);

    expect(html).toContain("固定一次扣分");
    expect(html).toContain("按次扣分");
    expect(html).toContain("自由区间扣分");
    expect(html).toContain("按严重程度在整数区间内扣分");
  });

  it("localizes technical level ids and assigns graduated green-to-red tone tiers", () => {
    const html = renderToStaticMarkup(<RubricDocument rubric={{
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 10,
      partialCreditAllowed: true,
      criteria: [{
        id: "fmt",
        name: "格式规范",
        description: "格式与表达",
        maxScore: 10,
        scorePolicy: "continuous",
        evidenceRequired: true,
        levels: [
          { id: "fmt_excellent", minScore: 8, maxScore: 10, condition: "非常规范" },
          { id: "fmt_good", minScore: 6, maxScore: 7, condition: "较规范" },
          { id: "fmt_medium", minScore: 4, maxScore: 5, condition: "基本规范" },
          { id: "fmt_pass", minScore: 2, maxScore: 3, condition: "一般" },
          { id: "fmt_fail", minScore: 0, maxScore: 1, condition: "不合格" },
        ],
      }],
    }} />);

    expect(html).toContain("优秀");
    expect(html).toContain("良好");
    expect(html).toContain("中等");
    expect(html).toContain("合格");
    expect(html).toContain("不合格");
    expect(html).toContain("tier-high");
    expect(html).toContain("tier-good");
    expect(html).toContain("tier-mid");
    expect(html).toContain("tier-low");
    expect(html).toContain("tier-fail");
  });
});
