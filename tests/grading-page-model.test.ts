import { describe, expect, it } from "vitest";
import { applyGradingEvent, clampGradingPreviewPercent, initialLiveMessage } from "../web/src/pages/grading-page-model.js";

describe("grading workbench presentation", () => {
  it("clamps the resizable preview pane", () => {
    expect(clampGradingPreviewPercent(10)).toBe(28);
    expect(clampGradingPreviewPercent(44)).toBe(44);
    expect(clampGradingPreviewPercent(90)).toBe(62);
  });

  it("interleaves safe process, reply, and tools then collapses them at completion", () => {
    let live = initialLiveMessage("run-1");
    live = applyGradingEvent(live, "process_delta", { delta: "正在核对。" });
    live = applyGradingEvent(live, "tool_start", { id: "t1", name: "search_submission", label: "搜索学生作业", summary: "定位关键词" });
    live = applyGradingEvent(live, "reply_delta", { delta: "已找到证据。" });
    live = applyGradingEvent(live, "tool_end", { id: "t1", name: "search_submission", label: "搜索学生作业", summary: "完成", status: "completed" });
    live = applyGradingEvent(live, "final", { message: "已找到证据。" });
    expect(live).toMatchObject({ process: "正在核对。", content: "已找到证据。", complete: true, collapsed: true, tools: [{ status: "completed" }] });
  });
});
