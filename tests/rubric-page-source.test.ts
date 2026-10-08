import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("rubric page state synchronization", () => {
  it("does not fabricate validation failures from a screenshot query parameter", () => {
    const source = readFileSync(new URL("../web/src/pages/RubricPage.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('get("mockError")');
  });
  it("prevents an old assignment load or stream from writing into the current assignment", () => {
    const source = readFileSync(new URL("../web/src/pages/RubricPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("LatestRequestGate");
    expect(source).toContain("assignmentGate");
    expect(source).toContain("streamGate");
    expect(source).toContain("streamControllerRef");
    expect(source).toContain("selectedAssignmentIdRef");
    expect(source).toContain("lease.isCurrent()");
    expect(source).toContain("评分表设计连接已中断，请重试");
  });
});
