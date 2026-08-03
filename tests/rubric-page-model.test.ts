import { describe, expect, it } from "vitest";
import { assignmentIdFromSearch, loadRubricSession } from "../web/src/pages/rubric-page-model.js";

describe("rubric page selection", () => {
  it("reads the selected assignment ID from the session link", () => {
    expect(assignmentIdFromSearch("?assignment=8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1")).toBe("8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1");
  });

  it("shows the session before a slow recommendation is ready", async () => {
    let resolveRecommendation: ((value: { options: string[] }) => void) | undefined;
    const recommendation = new Promise<{ options: string[] }>((resolve) => { resolveRecommendation = resolve; });
    const calls: string[] = [];
    const loaded = loadRubricSession({
      assignment: () => Promise.resolve({ id: "assignment" }),
      draft: () => Promise.resolve(null),
      recommendations: () => recommendation,
      onCore: () => calls.push("core"),
      onRecommendations: () => calls.push("recommendations"),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["core"]);
    resolveRecommendation?.({ options: [] });
    await loaded;
    expect(calls).toEqual(["core", "recommendations"]);
  });
});
