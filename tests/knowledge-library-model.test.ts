import { describe, expect, it } from "vitest";
import { numberReleases, previewRepeatsTitle } from "../web/src/pages/knowledge-library-model.js";

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
it("suppresses a separate preview title only when the Markdown opens with the same heading", () => {
  expect(previewRepeatsTitle("\uFEFF\n# 预约指南\n\n第一段", "预约指南")).toBe(true);
  expect(previewRepeatsTitle("## 工作流程 ##\n\n第一段", "工作流程")).toBe(true);
  expect(previewRepeatsTitle("第一段\n\n# 预约指南", "预约指南")).toBe(false);
  expect(previewRepeatsTitle("# 原来的名字\n\n第一段", "新的名字")).toBe(false);
});
