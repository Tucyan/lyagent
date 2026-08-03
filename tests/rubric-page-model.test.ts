import { describe, expect, it } from "vitest";
import { assignmentIdFromSearch } from "../web/src/pages/rubric-page-model.js";

describe("rubric page selection", () => {
  it("reads the selected assignment ID from the session link", () => {
    expect(assignmentIdFromSearch("?assignment=8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1")).toBe("8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1");
  });
});
