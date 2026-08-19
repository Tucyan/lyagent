import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("batch grading table source", () => {
  it("shows score, confidence, review navigation, retry, and formal confirmation", () => {
    const source = readFileSync(new URL("../web/src/pages/GradingBatchPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("<th>分数</th>");
    expect(source).toContain("<th>置信度</th>");
    expect(source).toContain("batchReviewHref");
    expect(source).toContain(">Review</a>");
    expect(source).toContain(">重试</button>");
    expect(source).toContain(">确认</button>");
    expect(source).toContain("/confirm`");
  });
});
