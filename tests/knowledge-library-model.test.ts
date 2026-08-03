import { describe, expect, it } from "vitest";
import { numberReleases } from "../web/src/pages/knowledge-library-model.js";

describe("knowledge library presentation model", () => {
  it("assigns readable version numbers to newest-first releases", () => {
    expect(numberReleases([
      { id: "new", createdAt: "2026-08-03T00:00:00.000Z" },
      { id: "old", createdAt: "2026-08-01T00:00:00.000Z" },
    ])).toEqual([
      { id: "new", createdAt: "2026-08-03T00:00:00.000Z", versionNumber: 2, versionLabel: "v2" },
      { id: "old", createdAt: "2026-08-01T00:00:00.000Z", versionNumber: 1, versionLabel: "v1" },
    ]);
  });

  it("retains API order when release timestamps are equal", () => {
    expect(numberReleases([
      { id: "first", createdAt: "2026-08-03T00:00:00.000Z" },
      { id: "second", createdAt: "2026-08-03T00:00:00.000Z" },
    ]).map((release) => release.id)).toEqual(["first", "second"]);
  });
});
