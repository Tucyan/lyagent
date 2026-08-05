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
  expect(converterStatusLabel({ status: "ready", backend: "hybrid-engine" })).toBe("转换器就绪 · hybrid-engine");
  expect(converterStatusLabel({ status: "unavailable", backend: "pipeline" })).toBe("转换器不可用 · pipeline");
});
