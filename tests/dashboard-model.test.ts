import { describe, expect, it } from "vitest";
import { dashboardQuickActions } from "../web/src/pages/dashboard-model.js";

describe("dashboard quick actions", () => {
  it("provides an entry point for creating a rubric", () => {
    expect(dashboardQuickActions).toContainEqual(expect.objectContaining({
      href: "/rubrics",
      label: "创建评分量表",
    }));
  });
});
