import { describe, expect, it } from "vitest";
import { WebEvidenceService, type WebPageFetcher } from "../src/services/web-evidence-service.js";
import type { DdgsSearchService } from "../src/services/ddgs-search-service.js";

describe("WebEvidenceService", () => {
  it("reads only a result found in this answer and records its cited lines", async () => {
    const search: Pick<DdgsSearchService, "search"> = {
      search: async () => [{ title: "Official document", url: "https://example.edu/doc", snippet: "A summary" }],
    };
    const fetch = async (url: string) => ({ url, title: "Official document", content: "First line\nSecond line\nThird line" });
    const evidence = new WebEvidenceService(search, fetch);

    const [result] = await evidence.search({ query: "process" });
    expect(result).toMatchObject({ resultId: "web-1", title: "Official document", url: "https://example.edu/doc" });
    if (!result) throw new Error("Expected a search result");
    await expect(evidence.read("unknown")).rejects.toThrow("Web result was not found");

    await expect(evidence.read(result.resultId)).resolves.toEqual({
      sourceId: "web-1",
      title: "Official document",
      url: "https://example.edu/doc",
      startLine: 1,
      endLine: 3,
      content: "First line\nSecond line\nThird line",
    });
    expect(evidence.hasRead({ sourceId: "web-1", startLine: 2, endLine: 3 })).toBe(true);
    expect(evidence.hasRead({ sourceId: "web-1", startLine: 4, endLine: 4 })).toBe(false);
  });

  it("does not let one result ID fetch a different URL", async () => {
    const search: Pick<DdgsSearchService, "search"> = { search: async () => [] };
    const fetch = async () => ({ url: "https://example.edu", title: "", content: "" });
    const evidence = new WebEvidenceService(search, fetch as WebPageFetcher);

    await expect(evidence.read("https://127.0.0.1/secret")).rejects.toThrow("Web result was not found");
  });
});
