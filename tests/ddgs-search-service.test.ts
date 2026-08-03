import { describe, expect, it, vi } from "vitest";
import { DdgsSearchService, type DdgsRunner } from "../src/services/ddgs-search-service.js";

describe("DdgsSearchService", () => {
  it("normalizes DDGS results and bounds requested result count", async () => {
    const requests: unknown[] = [];
    const runner: DdgsRunner = async (request) => {
      requests.push(request);
      return [
        { title: "<b>Official guide</b>", href: "https://example.edu/guide", body: "A <em>useful</em> summary" },
        { title: "Second", href: "https://example.edu/second", body: "Another result" },
      ];
    };
    const service = new DdgsSearchService(runner);

    await expect(service.search({ query: " operating systems ", count: 99 })).resolves.toEqual([
      { title: "Official guide", url: "https://example.edu/guide", snippet: "A useful summary" },
      { title: "Second", url: "https://example.edu/second", snippet: "Another result" },
    ]);
    expect(requests).toEqual([{ query: "operating systems", count: 10, region: "zh-cn", safeSearch: "moderate" }]);
  });

  it("uses five DDGS results by default", async () => {
    const runner = vi.fn<DdgsRunner>(async () => []);
    const service = new DdgsSearchService(runner);

    await service.search({ query: "process" });

    expect(runner).toHaveBeenCalledWith({ query: "process", count: 5, region: "zh-cn", safeSearch: "moderate" });
  });
});
