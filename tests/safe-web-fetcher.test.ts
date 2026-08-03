import { describe, expect, it, vi } from "vitest";
import { SafeWebFetcher, type WebRequest } from "../src/services/safe-web-fetcher.js";

describe("SafeWebFetcher", () => {
  it("blocks private addresses before making a web request", async () => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request, async () => ["127.0.0.1"]);

    await expect(fetcher.fetch("https://internal.example/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("rechecks redirect destinations and extracts bounded readable text", async () => {
    const request = vi.fn<WebRequest>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://public.example/final" } }))
      .mockResolvedValueOnce(new Response("<html><head><title>Guide</title></head><body><h1>Process</h1><p>A running program.</p></body></html>", { headers: { "content-type": "text/html" } }));
    const fetcher = new SafeWebFetcher(request, async () => ["93.184.216.34"]);

    await expect(fetcher.fetch("https://public.example/start")).resolves.toEqual({
      url: "https://public.example/final",
      title: "Guide",
      content: "Process\nA running program.",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
