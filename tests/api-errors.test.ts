import { describe, expect, it } from "vitest";
import { apiErrorFromResponse } from "../web/src/lib/api.js";

describe("API error presentation", () => {
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
    expect(error.message).toContain("VALIDATION_ERROR");
    expect(error.message).toContain("sessionIds");
    expect(error.message).toContain("studentName");
  });
});
