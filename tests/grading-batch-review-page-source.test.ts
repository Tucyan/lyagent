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
    expect(page).toContain(">保存修改</button>");
    expect(page).toContain(">重试</button>");
    expect(page).toContain(">确认</button>");
  });
});
