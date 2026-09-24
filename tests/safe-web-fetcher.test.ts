import { describe, expect, it, vi } from "vitest";
import { SafeWebFetcher, type WebRequest } from "../src/services/safe-web-fetcher.js";

describe("SafeWebFetcher", () => {
  it("blocks private addresses before making a web request", async () => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request, async () => ["127.0.0.1"]);

    await expect(fetcher.fetch("https://internal.example/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("applies the overall fetch deadline while DNS resolution is pending", async () => {
    let resolutionStarted = false;
    const neverResolves = new Promise<string[]>(() => {});
    const fetcher = new SafeWebFetcher(
      vi.fn<WebRequest>(),
      () => {
        resolutionStarted = true;
        return neverResolves;
      },
      20,
    );
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const observationDeadline = new Promise<never>((_resolve, reject) => {
      observationTimer = setTimeout(() => reject(new Error("test observation deadline")), 150);
    });

    try {
      await expect(Promise.race([
        fetcher.fetch("https://slow-dns.example/page"),
        observationDeadline,
      ])).rejects.toThrow("Web request timed out");
      expect(resolutionStarted).toBe(true);
    } finally {
      if (observationTimer) clearTimeout(observationTimer);
    }
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

  it("connects only through the addresses that passed the public-address check", async () => {
    const request = vi.fn<WebRequest>().mockResolvedValue(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const fetcher = new SafeWebFetcher(request, async () => ["93.184.216.34"]);

    await fetcher.fetch("https://public.example/page");

    expect(request).toHaveBeenCalledWith(
      "https://public.example/page",
      expect.any(Object),
      ["93.184.216.34"],
    );
  });

  it("rejects a private IP literal before attempting a connection", async () => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request);

    await expect(fetcher.fetch("https://127.0.0.1/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects IPv4-mapped private IPv6 answers", async () => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request, async () => ["::ffff:127.0.0.1"]);

    await expect(fetcher.fetch("https://mapped.example/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "0:0:0:0:0:ffff:7f00:1",
    "100::1",
    "2001:2::1",
    "3fff::1",
  ])("rejects non-global IPv6 address %s", async (address) => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request, async () => [address]);

    await expect(fetcher.fetch("https://non-global.example/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("allows a global-unicast IPv6 answer", async () => {
    const request = vi.fn<WebRequest>().mockResolvedValue(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const fetcher = new SafeWebFetcher(request, async () => ["2001:4860:4860::8888"]);

    await expect(fetcher.fetch("https://public.example/ipv6")).resolves.toMatchObject({ content: "ok" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects the full IPv6 link-local range", async () => {
    const request = vi.fn<WebRequest>();
    const fetcher = new SafeWebFetcher(request, async () => ["fe90::1"]);

    await expect(fetcher.fetch("https://link-local.example/secret")).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels a redirect response body before following the new address", async () => {
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const request = vi.fn<WebRequest>()
      .mockResolvedValueOnce(new Response(redirectBody, { status: 302, headers: { location: "https://public.example/final" } }))
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const fetcher = new SafeWebFetcher(request, async () => ["93.184.216.34"]);

    await fetcher.fetch("https://public.example/start");

    expect(cancelled).toBe(true);
  });

  it("cancels an error response body before rejecting", async () => {
    let cancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const request = vi.fn<WebRequest>().mockResolvedValue(new Response(errorBody, { status: 503 }));
    const fetcher = new SafeWebFetcher(request, async () => ["93.184.216.34"]);

    await expect(fetcher.fetch("https://public.example/error")).rejects.toThrow("HTTP 503");
    expect(cancelled).toBe(true);
  });

  it.each([undefined, "1"]) ("cancels a response stream that exceeds the byte cap (content-length=%s)", async (length) => {
    let chunksRead = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new Uint8Array(40_000));
        if (chunksRead === 5) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const headers = new Headers({ "content-type": "text/plain" });
    if (length) headers.set("content-length", length);
    const request = vi.fn<WebRequest>().mockResolvedValue(new Response(body, { headers }));
    const fetcher = new SafeWebFetcher(request, async () => ["93.184.216.34"]);

    await expect(fetcher.fetch("https://public.example/large")).rejects.toThrow("too large");
    expect(chunksRead).toBeLessThan(5);
    expect(cancelled).toBe(true);
  });
});
