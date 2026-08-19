import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("course QA page state synchronization", () => {
  it("keeps route state, requests, citations, and streams owned by the active chat", () => {
    const source = readFileSync(new URL("../web/src/pages/CourseQaPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("navigateWithinApp");
    expect(source).toContain("LatestRequestGate");
    expect(source).toContain("courseGate");
    expect(source).toContain("sessionGate");
    expect(source).toContain("sourceGate");
    expect(source).toContain("streamGate");
    expect(source).toContain("controller.current?.abort()");
    expect(source).toContain("lease.isCurrent()");
    expect(source).toContain("答疑连接已中断，请重试");
  });
});
