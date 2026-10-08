import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradingReviewChecklist } from "../web/src/components/GradingReviewChecklist.js";
import { gradingItemLabel } from "../web/src/pages/grading-page-model.js";
import { batchJobStatusLabel } from "../web/src/pages/grading-batch-page-model.js";

describe("teacher review presentation", () => {
  it("uses frozen rubric names for all grading modes and hides unknown internal IDs", () => {
    const rubric = { criteria: [{ id: "experimental_process", name: "实验过程" }], deductionRules: [{ id: "late", name: "迟交" }], bonusRules: [{ id: "extra", name: "拓展分析" }] };
    expect(gradingItemLabel(rubric, "experimental_process", 0)).toBe("实验过程");
    expect(gradingItemLabel(rubric, "late", 1)).toBe("迟交");
    expect(gradingItemLabel(rubric, "extra", 2)).toBe("拓展分析");
    expect(gradingItemLabel({ rules: [{ id: "missing", name: "缺少结论" }] }, "missing", 0)).toBe("缺少结论");
    expect(gradingItemLabel(rubric, "private_id", 3)).toBe("评分项目 4");
  });
  it("shows confirmed review as a read-only record without unchecked controls", () => {
    const html = renderToStaticMarkup(<GradingReviewChecklist confirmed reasons={["CONVERSION_WARNING"]} notices={["评分尺度需核对"]} acknowledgedReasons={[]} onChange={() => undefined} />);
    expect(html).toContain("已完成教师复核");
    expect(html).toContain("评分尺度需核对");
    expect(html).not.toContain("checkbox");
    expect(html).not.toContain("CONVERSION_WARNING");
  });
  it("keeps acknowledgment controls available for an unconfirmed draft", () => {
    const html = renderToStaticMarkup(<GradingReviewChecklist confirmed={false} reasons={["CONVERSION_WARNING"]} acknowledgedReasons={["CONVERSION_WARNING"]} onChange={() => undefined} />);
    expect(html).toContain("checkbox");
    expect(html).toContain("checked");
    expect(html).toContain("需要教师复核");
  });
  it("distinguishes a formally confirmed grade from completion of batch processing", () => {
    expect(batchJobStatusLabel({ status: "completed", reviewStatus: "confirmed" })).toBe("成绩已确认");
    expect(batchJobStatusLabel({ status: "needs_review", reviewStatus: "needs_review" })).toBe("待复核");
    expect(batchJobStatusLabel({ status: "running" })).toBe("批改中");
  });
});
