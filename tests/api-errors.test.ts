import { describe, expect, it, vi, afterEach } from "vitest";
import { apiErrorFromResponse, apiFetch, reviewReasonLabel, rubricProblemMessage } from "../web/src/lib/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("API error presentation", () => {
  it("turns network exceptions into a recovery prompt and preserves deliberate cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch SECRET")).mockRejectedValueOnce(new DOMException("cancel", "AbortError")));
    await expect(apiFetch("/api/courses")).rejects.toMatchObject({ code: "NETWORK_ERROR", message: expect.stringContaining("启动窗口") });
    await expect(apiFetch("/api/courses")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("explains every current review reason and provides a safe future-reason fallback", () => {
    for (const reason of ["LOW_CONFIDENCE", "EVIDENCE_INSUFFICIENT", "CONVERSION_WARNING", "NEAR_PASSING_BOUNDARY", "NEW_REASON"]) {
      expect(reviewReasonLabel(reason)).toContain("请");
      expect(reviewReasonLabel(reason)).not.toContain(reason);
    }
    expect(rubricProblemMessage({ code: "RANGE_GAP_OR_OVERLAP", path: "criteria.private.levels" })).toContain("0.01");
    expect(rubricProblemMessage({ code: "NEW_ERROR", path: "private.socket" })).not.toMatch(/private|socket/);
    expect(reviewReasonLabel("CONVERSION_WARNING")).toContain("具体说明");
    expect(reviewReasonLabel("CONVERSION_WARNING")).not.toContain("报告转换");
  });
  it("keeps the safe code, message, and issue paths", async () => {
    const error = await apiErrorFromResponse(new Response(JSON.stringify({
      code: "VALIDATION_ERROR",
      message: "请求参数无效",
      issues: [
        { path: "sessionIds", message: "至少选择一份作业" },
        { path: "studentName", message: "姓名与学号必须同时填写" },
      ],
    }), { status: 400, headers: { "content-type": "application/json" } }));

    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      issuePaths: ["sessionIds", "studentName"],
    });
    expect(error.message).not.toContain("VALIDATION_ERROR");
    expect(error.message).not.toContain("sessionIds");
    expect(error.message).not.toContain("studentName");
    expect(error.message).toContain("学生姓名");
    expect(error.message).toContain("请");
  });

  it.each(["INTERNAL_ERROR", "GRADING_CONFLICT", "KNOWLEDGE_ERROR", "NEW_UNKNOWN_ERROR"])("does not expose provider or filesystem details for %s", async (code) => {
    const error = await apiErrorFromResponse(new Response(JSON.stringify({ code, message: "socket ECONNRESET C:\\private\\key.txt SECRET" }), { status: 500 }));
    expect(error.message).not.toMatch(/ECONNRESET|private|SECRET|INTERNAL_ERROR|GRADING_CONFLICT/);
    expect(error.message).toContain("请");
    expect(error.code).toBe(code);
  });

  it("explains a failed rubric save instead of HTTP status or raw validation messages", async () => {
    const error = await apiErrorFromResponse(new Response(JSON.stringify({ code: "RUBRIC_VALIDATION_FAILED", errors: [{ code: "CRITERIA_TOTAL_MISMATCH", path: "criteria", message: "Criterion maxima must equal the rubric total score" }] }), { status: 422 }));
    expect(error.message).toContain("分值上限之和");
    expect(error.message).toContain("人工编辑");
    expect(error.message).not.toMatch(/criteria|Criterion|422/);
  });

  it("handles a non-JSON error response with actionable Chinese", async () => {
    const error = await apiErrorFromResponse(new Response("<html>proxy diagnostic SECRET</html>", { status: 503, statusText: "Service Unavailable" }));
    expect(error.message).toContain("请");
    expect(error.message).not.toMatch(/Unavailable|SECRET/);
  });
});
