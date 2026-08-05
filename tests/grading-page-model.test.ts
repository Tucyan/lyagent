import { describe, expect, it } from "vitest";
import {
  applyGradingEvent,
  clampGradingPreviewPercent,
  conversionPresentation,
  initialLiveMessage,
  normalizeGradingExportOptions,
  parseGradingExportOptions,
  rubricSelectionKey,
  shouldPollConversion,
} from "../web/src/pages/grading-page-model.js";

describe("grading workbench presentation", () => {
  it("clamps the resizable preview pane", () => {
    expect(clampGradingPreviewPercent(10)).toBe(28);
    expect(clampGradingPreviewPercent(44)).toBe(44);
    expect(clampGradingPreviewPercent(90)).toBe(62);
  });

  it("interleaves safe process, reply, and tools then collapses them at completion", () => {
    let live = initialLiveMessage("run-1");
    live = applyGradingEvent(live, "process_delta", { delta: "正在核对。" });
    live = applyGradingEvent(live, "tool_start", {
      id: "t1",
      name: "search_submission",
      label: "搜索学生作业",
      summary: "定位关键词",
    });
    live = applyGradingEvent(live, "reply_delta", { delta: "已找到证据。" });
    live = applyGradingEvent(live, "tool_end", {
      id: "t1",
      name: "search_submission",
      label: "搜索学生作业",
      summary: "完成",
      status: "completed",
    });
    live = applyGradingEvent(live, "final", { message: "已找到证据。" });
    expect(live).toMatchObject({
      process: "正在核对。",
      content: "已找到证据。",
      complete: true,
      collapsed: true,
      tools: [{ status: "completed" }],
    });
  });

  it("keys exact frozen rubrics and normalizes cached CSV selections", () => {
    expect(rubricSelectionKey({ assignmentId: "a1", version: 3 })).toBe("a1:3");
    expect(
      normalizeGradingExportOptions({
        studentName: true,
        itemDetails: false,
        itemConfidence: true,
      }),
    ).toMatchObject({
      studentName: true,
      itemDetails: false,
      itemConfidence: false,
    });
    expect(
      parseGradingExportOptions(
        '{"studentNumber":true,"itemDetails":true,"itemConfidence":true}',
      ),
    ).toMatchObject({
      studentNumber: true,
      itemDetails: true,
      itemConfidence: true,
    });
    expect(parseGradingExportOptions("invalid")).toMatchObject({
      studentName: true,
      studentNumber: true,
      totalScore: true,
    });
  });

  it("presents converter waiting, parse failure, and rejected output with distinct actions", () => {
    expect(
      conversionPresentation({
        conversionStatus: "waiting_for_converter",
        conversionError: {
          code: "CONVERTER_UNAVAILABLE",
          message: "转换服务当前不可用，原始作业已安全保存。",
          retryable: true,
        },
      }),
    ).toMatchObject({
      title: "等待转换服务",
      canRetry: true,
      canReupload: true,
      tone: "warning",
    });
    expect(
      conversionPresentation({
        conversionStatus: "conversion_failed",
        conversionError: {
          code: "CONVERSION_FAILED",
          message: "转换服务无法解析该文件。",
          retryable: false,
        },
      }),
    ).toMatchObject({
      title: "作业文件无法转换",
      canRetry: false,
      canReupload: true,
      tone: "danger",
    });
    expect(
      conversionPresentation({
        conversionStatus: "result_rejected",
        conversionError: {
          code: "RESULT_REJECTED",
          message: "转换结果未通过安全校验。",
          retryable: false,
        },
      }),
    ).toMatchObject({
      title: "转换结果已被拒绝",
      canRetry: false,
      canReupload: true,
      tone: "danger",
    });
    expect(
      conversionPresentation({ conversionStatus: "running" }),
    ).toMatchObject({
      title: "正在转换作业",
      canRetry: false,
      canReupload: false,
      tone: "neutral",
    });
    expect(
      conversionPresentation({ conversionStatus: "ready" }),
    ).toBeUndefined();
  });

  it("polls active conversions and scheduled retries but not terminal or paused states", () => {
    expect(shouldPollConversion({ conversionStatus: "queued" })).toBe(true);
    expect(shouldPollConversion({ conversionStatus: "running" })).toBe(true);
    expect(
      shouldPollConversion({
        conversionStatus: "waiting_for_converter",
        conversionError: {
          code: "CONVERTER_UNAVAILABLE",
          message: "waiting",
          retryable: true,
          nextRetryAt: "2026-08-05T00:00:05.000Z",
        },
      }),
    ).toBe(true);
    expect(
      shouldPollConversion({
        conversionStatus: "waiting_for_converter",
        conversionError: {
          code: "CONVERTER_UNAVAILABLE",
          message: "paused",
          retryable: true,
        },
      }),
    ).toBe(false);
    expect(
      shouldPollConversion({ conversionStatus: "conversion_failed" }),
    ).toBe(false);
  });
});
