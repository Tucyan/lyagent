import { describe, expect, it } from "vitest";
import type { Rubric } from "../src/schemas/rubric.js";
import { summarizeRubricDraftUpdate } from "../src/services/rubric-diff-summary.js";
import { collapseConsecutiveToolSteps } from "../web/src/lib/qa-presentation.js";

describe("rubric draft diff summary and consecutive tool step collapsing", () => {
  it("summarizes initial draft creation with mode, total score, and criteria names", () => {
    const rubric: Rubric = {
      schemaVersion: "1.0",
      mode: "hybrid",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        { id: "bg", name: "问题背景", description: "背景清晰", maxScore: 20, scorePolicy: "range", evidenceRequired: true },
        { id: "impl", name: "实现质量", description: "实现完整", maxScore: 80, scorePolicy: "range", evidenceRequired: true },
      ],
      bonusRules: [],
      deductionRules: [],
      overlapGroups: [],
    };
    const summary = summarizeRubricDraftUpdate(undefined, rubric, 1);
    expect(summary).toContain("评分表草稿已更新为 v1");
    expect(summary).toContain("混合制");
    expect(summary).toContain("总分 100 分");
    expect(summary).toContain("问题背景（20 分）");
  });

  it("summarizes concrete policy, score, and criteria additions/removals between versions", () => {
    const previous: Rubric = {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 100,
      partialCreditAllowed: false,
      criteria: [
        { id: "bg", name: "问题背景", description: "背景清晰", maxScore: 20, scorePolicy: "exact-level", evidenceRequired: true },
        { id: "impl", name: "实现质量", description: "实现完整", maxScore: 80, scorePolicy: "exact-level", evidenceRequired: true },
      ],
    };
    const next: Rubric = {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        { id: "bg", name: "问题背景", description: "背景清晰", maxScore: 30, scorePolicy: "range", evidenceRequired: true },
        { id: "impl", name: "实现质量", description: "实现完整", maxScore: 50, scorePolicy: "range", evidenceRequired: true },
        { id: "fmt", name: "格式规范", description: "格式清晰", maxScore: 20, scorePolicy: "continuous", evidenceRequired: true },
      ],
    };
    const summary = summarizeRubricDraftUpdate(previous, next, 2);
    expect(summary).toContain("评分表草稿 v2");
    expect(summary).toContain("已开启允许部分得分");
    expect(summary).toContain("新增评分项目");
    expect(summary).toContain("格式规范");
    expect(summary).toContain("按档定分 → 区间打分");
    expect(summary).toContain("20 → 30 分");
  });

  it("collapses consecutive identical tool calls into counted entries without merging across different statuses or tools", () => {
    const collapsed = collapseConsecutiveToolSteps([
      { id: "1", label: "读取上下文", summary: "读取作业信息", status: "completed" },
      { id: "2", label: "校验评分表", summary: "检查结构、总分和评分规则是否有效", status: "completed" },
      { id: "3", label: "校验评分表", summary: "检查结构、总分和评分规则是否有效", status: "completed" },
      { id: "4", label: "校验评分表", summary: "检查结构、总分和评分规则是否有效", status: "completed" },
      { id: "5", label: "校验评分表", summary: "检查结构、总分和评分规则是否有效", status: "failed" },
      { id: "6", label: "更新评分表草稿", summary: "使用版本校验更新当前草稿", status: "completed" },
    ]);
    expect(collapsed).toHaveLength(4);
    expect(collapsed[1]).toMatchObject({ label: "校验评分表", status: "completed", count: 3 });
    expect(collapsed[2]).toMatchObject({ label: "校验评分表", status: "failed", count: 1 });
    expect(collapsed[3]).toMatchObject({ label: "更新评分表草稿", count: 1 });
  });
});
