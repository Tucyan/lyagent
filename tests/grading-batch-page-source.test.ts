import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("batch grading table source", () => {
  it("shows score, confidence, review navigation, retry, and formal confirmation", () => {
    const source = readFileSync(new URL("../web/src/pages/GradingBatchPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("<th>分数</th>");
    expect(source).toContain("<th>置信度</th>");
    expect(source).toContain("batchReviewHref");
    expect(source).toContain(">Review</a>");
    expect(source).toContain("重试中…");
    expect(source).toContain("retryingItemId");
    expect(source).toContain("retryingJobId");
    expect(source).toContain(">确认</button>");
    expect(source).toContain("/confirm`");
  });

  it("serializes polling and ignores stale list, detail, and draft responses", () => {
    const source = readFileSync(new URL("../web/src/pages/GradingBatchPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("LatestRequestGate");
    expect(source).toContain("startSerialPolling");
    expect(source).not.toContain("setInterval");
    expect(source).toContain("listGate");
    expect(source).toContain("detailGate");
    expect(source).toContain("draftGate");
    expect(source).toContain("selectedIdRef");
    expect(source).toContain("uploadDraftIdRef");
    expect(source).toContain("lease.isCurrent()");
  });
});
