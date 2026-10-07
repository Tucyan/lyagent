import { describe, expect, it } from "vitest";
import {
  applyGradingEvent,
  buildAssetManifest,
  clampGradingPreviewPercent,
  conversionPresentation,
  gradingSessionStatusLabel,
  initialLiveMessage,
  normalizeGradingExportOptions,
  parseGradingExportOptions,
  resolveGradingSessionScope,
  resolveGradingRubricKey,
  rubricSelectionKey,
  shouldPollConversion,
  shouldPollSessionPreparation,
  submissionTitlePresentation,
} from "../web/src/pages/grading-page-model.js";

describe("grading workbench presentation", () => {
  it("offers manual retry after automatic conversion retries are exhausted without polling", () => {
    const input = { conversionStatus: "conversion_failed", conversionError: { code: "CONVERTER_UNAVAILABLE", message: "Automatic retries exhausted", retryable: true } };
    expect(conversionPresentation(input)).toMatchObject({ title: "转换已停止", canRetry: true, canReupload: true });
    expect(shouldPollConversion(input)).toBe(false);
  });

  it("builds an assets-rooted manifest from a selected directory", () => {
    expect(buildAssetManifest([
      { name: "chart.png", webkitRelativePath: "assets/charts/chart.png" },
      { name: "photo.jpg", webkitRelativePath: "assets/photo.jpg" },
    ])).toEqual(["assets/charts/chart.png", "assets/photo.jpg"]);
    expect(() => buildAssetManifest([
      { name: "chart.png", webkitRelativePath: "images/chart.png" },
    ])).toThrow(/assets/i);
    expect(() => buildAssetManifest([
      { name: "chart.png", webkitRelativePath: "assets/chart.png" },
      { name: "chart.png", webkitRelativePath: "assets/chart.png" },
    ])).toThrow(/duplicate/i);
  });

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
    live = applyGradingEvent(live, "model_switch", { model: "vision-model", capability: "vision" });
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
      process: expect.stringContaining("正在核对。\n已切换至视觉模型"),
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

  it("falls back to the first frozen rubric when the cached selection is stale", () => {
    const rubrics = [
      { assignmentId: "current", version: 2 },
      { assignmentId: "older", version: 1 },
    ];
    expect(resolveGradingRubricKey(rubrics, "deleted:1")).toBe("current:2");
    expect(resolveGradingRubricKey(rubrics, "older:1")).toBe("older:1");
    expect(resolveGradingRubricKey([], "deleted:1")).toBe("");
  });

  it("keeps the current session list scope while frozen rubrics are still loading", () => {
    expect(
      resolveGradingSessionScope(
        {
          assignmentId: "assignment-current",
          rubricVersion: 3,
        },
        [],
        "stale:1",
      ),
    ).toEqual({ assignmentId: "assignment-current", version: 3 });
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

  it("keeps polling while naming is active and labels every preparation state", () => {
    expect(shouldPollSessionPreparation({
      conversionStatus: "ready",
      submissionTitleStatus: "pending",
    })).toBe(true);
    expect(shouldPollSessionPreparation({
      conversionStatus: "ready",
      submissionTitleStatus: "resolving",
    })).toBe(true);
    expect(shouldPollSessionPreparation({
      conversionStatus: "ready",
      submissionTitleStatus: "resolved",
    })).toBe(false);
    expect(shouldPollSessionPreparation({
      conversionStatus: "ready",
      submissionTitleStatus: "failed",
    })).toBe(false);
    expect(gradingSessionStatusLabel({ conversionStatus: "queued", submissionTitleStatus: "pending" })).toBe("等待转换");
    expect(gradingSessionStatusLabel({ conversionStatus: "running", submissionTitleStatus: "pending" })).toBe("等待转换");
    expect(gradingSessionStatusLabel({ conversionStatus: "ready", submissionTitleStatus: "resolving" })).toBe("正在识别");
    expect(gradingSessionStatusLabel({ conversionStatus: "ready", submissionTitleStatus: "failed" })).toBe("识别失败");
    expect(gradingSessionStatusLabel({ conversionStatus: "ready", submissionTitleStatus: "resolved" })).toBe("已就绪");
  });

  it("presents an immediate safe retry state without the stale failure", () => {
    expect(submissionTitlePresentation({
      status: "failed",
      retrying: true,
      error: { code: "SUBMISSION_TITLE_MODEL_FAILED", message: "作业名称识别失败，请重试" },
    })).toEqual({
      label: "正在识别…",
      retryLabel: "正在重试…",
      showRetry: true,
      retryDisabled: true,
    });
    expect(submissionTitlePresentation({
      status: "failed",
      retrying: false,
      error: { code: "SUBMISSION_TITLE_MODEL_FAILED", message: "作业名称识别失败，请重试" },
    })).toMatchObject({
      label: "识别失败",
      retryLabel: "重试名称识别",
      showRetry: true,
      retryDisabled: false,
      error: { code: "SUBMISSION_TITLE_MODEL_FAILED" },
    });
  });
});
