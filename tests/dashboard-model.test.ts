import { describe, expect, it } from "vitest";
import { converterStatusLabel, dashboardQuickActions } from "../web/src/pages/dashboard-model.js";

describe("dashboard quick actions", () => {
  it("provides an entry point for creating a rubric", () => {
    expect(dashboardQuickActions).toContainEqual(expect.objectContaining({
      href: "/rubrics",
      label: "创建评分量表",
    }));
  });
});

it("formats a safe converter runtime status", () => {
  expect(converterStatusLabel({ provider: "docling", status: "ready", device: "auto" })).toBe("Docling 就绪 · auto");
  expect(converterStatusLabel({ provider: "docling", status: "unavailable", device: "cpu" })).toBe("Docling 不可用 · cpu");
});
