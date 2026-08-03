import { describe, expect, it, vi } from "vitest";
import { createDdgsRunner, type DdgsProcessExecutor } from "../src/services/ddgs-process-runner.js";

describe("DDGS process runner", () => {
  it("passes structured input over stdin and parses structured results", async () => {
    const execute = vi.fn<DdgsProcessExecutor>(async () => JSON.stringify([{ title: "Result", href: "https://example.edu", body: "Summary" }]));
    const runner = createDdgsRunner(execute, "python-test");

    await expect(runner({ query: "process", count: 5, region: "zh-cn", safeSearch: "moderate" })).resolves.toEqual([
      { title: "Result", href: "https://example.edu", body: "Summary" },
    ]);
    expect(execute).toHaveBeenCalledWith("python-test", expect.arrayContaining([expect.stringContaining("ddgs_search.py")]), JSON.stringify({ query: "process", count: 5, region: "zh-cn", safeSearch: "moderate" }), 30_000);
  });

  it("rejects invalid JSON from the helper instead of treating it as a search result", async () => {
    const runner = createDdgsRunner(async () => "not-json");

    await expect(runner({ query: "process", count: 5, region: "zh-cn", safeSearch: "moderate" })).rejects.toThrow("DDGS helper returned invalid JSON");
  });
});
