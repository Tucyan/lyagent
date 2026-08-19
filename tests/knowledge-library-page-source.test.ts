import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("knowledge library page state synchronization", () => {
  it("synchronizes the course URL and rejects stale workspace and file responses", () => {
    const source = readFileSync(new URL("../web/src/pages/KnowledgeLibraryPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("navigateWithinApp");
    expect(source).toContain("LatestRequestGate");
    expect(source).toContain("workspaceGate");
    expect(source).toContain("releaseGate");
    expect(source).toContain("releaseContentGate");
    expect(source).toContain("draftGate");
    expect(source).toContain("draftContentGate");
    expect(source).toContain("courseIdRef");
    expect(source).toContain("lease.isCurrent()");
    expect(source).toMatch(/useEffect\(\(\) => \{[\s\S]*resetCourseState\(queryCourseId\)[\s\S]*\}, \[queryCourseId\]\)/);
  });
});
