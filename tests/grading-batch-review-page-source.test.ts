import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("batch review workspace source", () => {
  it("routes to an editable split review workspace with retry and confirm", () => {
    const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../web/src/pages/GradingBatchReviewPage.tsx", import.meta.url), "utf8");
    expect(app).toContain('path === "/grading/batches/review"');
    expect(page).toContain('className="batch-review-sidebar"');
    expect(page).toContain('role="separator"');
    expect(page).toContain("onPointerDown");
    expect(page).toContain("DecisionEditor");
    expect(page).toContain("保存中…");
    expect(page).toContain("重试中…");
    expect(page).toContain("确认中…");
    expect(page).toContain("busyAction");
  });

  it("polls the batch and selected session serially without stale route writes", () => {
    const page = readFileSync(new URL("../web/src/pages/GradingBatchReviewPage.tsx", import.meta.url), "utf8");

    expect(page).toContain("LatestRequestGate");
    expect(page).toContain("startSerialPolling");
    expect(page).not.toContain("setInterval");
    expect(page).toContain("batchGate");
    expect(page).toContain("sessionGate");
    expect(page).toContain("batchIdRef");
    expect(page).toContain("sessionIdRef");
    expect(page).toMatch(/startSerialPolling[\s\S]*refreshBatch[\s\S]*refreshSession/);
    expect(page).toContain("lease.isCurrent()");
  });
});
