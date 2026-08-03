import { describe, expect, it } from "vitest";
import { createDeepSeekCourseQaAgentFactory } from "../src/agents/course-qa/deepseek.js";

describe("course QA DeepSeek integration", () => {
  it("exposes a QA factory only when a local API key is configured", () => {
    expect(createDeepSeekCourseQaAgentFactory()).toMatchObject({ status: { provider: "deepseek", model: "deepseek-v4-flash", configured: false }, factory: undefined });
    expect(createDeepSeekCourseQaAgentFactory("test-key")).toMatchObject({ status: { provider: "deepseek", model: "deepseek-v4-flash", configured: true } });
  });
});
