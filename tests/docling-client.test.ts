import { describe, expect, it, vi } from "vitest";
import {
  ConversionConfigurationError,
  ConversionError,
  ConversionResultError,
  ConversionTaskMissingError,
  ConversionUnavailableError,
} from "../src/services/document-conversion-client.js";
import { DoclingClient } from "../src/services/docling-client.js";

describe("DoclingClient", () => {
  it("allows only credential-free loopback HTTP base URLs", () => {
    for (const baseUrl of [
      "https://127.0.0.1:5001",
      "http://192.168.1.10:5001",
      "http://user:secret@localhost:5001",
      "http://localhost:5001?token=secret",
      "http://localhost:5001/#fragment",
    ]) expect(() => new DoclingClient({ baseUrl })).toThrow(ConversionConfigurationError);
    for (const baseUrl of [
      "http://127.0.0.1:5001",
      "http://localhost:5001/",
      "http://[::1]:5001",
    ]) expect(() => new DoclingClient({ baseUrl })).not.toThrow();
  });

  it("checks health without making an optional version failure unhealthy", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/health")) return Response.json({ status: "ok" });
      if (String(input).endsWith("/version")) return new Response(null, { status: 404 });
      return new Response(null, { status: 500 });
    });
    const client = new DoclingClient({ baseUrl: "http://127.0.0.1:5001", fetchImpl });
    await expect(client.health()).resolves.toEqual({});
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5001/health");
  });

  it("submits the v1.28 async multipart schema with a basename", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      task_id: "task-1", task_status: "pending", task_position: 2,
      error_message: null, failure: null,
    }, { status: 202 }));
    const client = new DoclingClient({ baseUrl: "http://127.0.0.1:5001", fetchImpl });
    await expect(client.submit({ filename: "C:\\unsafe\\report.pdf", bytes: new Uint8Array([1, 2]) }))
      .resolves.toEqual({ taskId: "task-1", queuedAhead: 2 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5001/v1/convert/file/async");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect((form.get("files") as File).name).toBe("report.pdf");
    expect(form.get("to_formats")).toBe('["md"]');
    expect(form.get("image_export_mode")).toBe("referenced");
    expect(form.get("target_type")).toBe("zip");
    expect(form.get("do_ocr")).toBe("true");
    expect(form.get("force_ocr")).toBe("false");
    expect(form.get("ocr_preset")).toBe("auto");
    expect(form.has("ocr")).toBe(false);
    expect(form.has("ocr_engine")).toBe(false);
  });

  it.each([
    ["pending", "queued"], ["started", "running"],
    ["success", "completed"], ["failure", "failed"],
  ] as const)("maps Docling status %s to %s", async (external, expected) => {
    const client = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001",
      fetchImpl: async () => Response.json({
        task_id: "task/1", task_status: external, task_position: 0,
        error_message: "private provider detail", failure: null,
      }),
    });
    await expect(client.status("task/1")).resolves.toEqual({ status: expected, queuedAhead: 0 });
  });

  it("maps missing tasks, retryable statuses, and other 4xx without leaking bodies", async () => {
    const missing = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001",
      fetchImpl: async () => new Response("private missing detail", { status: 404 }),
    });
    await expect(missing.status("lost")).rejects.toBeInstanceOf(ConversionTaskMissingError);
    for (const status of [408, 425, 429, 500, 503]) {
      const client = new DoclingClient({
        baseUrl: "http://127.0.0.1:5001",
        fetchImpl: async () => new Response("private overload detail", { status }),
      });
      await expect(client.health()).rejects.toMatchObject({
        name: "ConversionUnavailableError", retryable: true, code: "CONVERTER_UNAVAILABLE",
      });
    }
    const invalid = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001",
      fetchImpl: async () => new Response("provider secret", { status: 422 }),
    });
    const error = await invalid.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversionError);
    expect(String(error)).not.toContain("provider secret");
  });

  it("classifies network failures, timeouts, and a caller abort as unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const clients = [
      new DoclingClient({
        baseUrl: "http://127.0.0.1:5001",
        fetchImpl: async () => { throw new TypeError("network private detail"); },
      }),
      new DoclingClient({
        baseUrl: "http://127.0.0.1:5001", timeoutMs: 1,
        fetchImpl: async (_input, init) => new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      }),
      new DoclingClient({
        baseUrl: "http://127.0.0.1:5001", signal: controller.signal,
        fetchImpl: async (_input, init) => {
          expect(init?.signal?.aborted).toBe(true);
          throw init?.signal?.reason;
        },
      }),
    ];
    for (const client of clients)
      await expect(client.health()).rejects.toBeInstanceOf(ConversionUnavailableError);
  });

  it("streams ZIP results with declared and actual byte limits", async () => {
    const declared = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001", maxResultBytes: 4,
      fetchImpl: async () => new Response(new Uint8Array([1]), {
        headers: { "content-type": "application/zip", "content-length": "5" },
      }),
    });
    await expect(declared.result("large")).rejects.toBeInstanceOf(ConversionResultError);
    const streamed = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001", maxResultBytes: 4,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "application/zip" },
      }),
    });
    await expect(streamed.result("large")).rejects.toBeInstanceOf(ConversionResultError);
  });

  it("returns a bounded ZIP source and normalizes a successful JSON in-body result", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const zipClient = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001",
      fetchImpl: async () => new Response(zip, { headers: { "content-type": "application/zip" } }),
    });
    await expect(zipClient.result("zip-task")).resolves.toEqual({ kind: "archive", bytes: zip });
    const jsonClient = new DoclingClient({
      baseUrl: "http://127.0.0.1:5001",
      fetchImpl: async () => Response.json({
        status: "partial_success",
        document: { filename: "report.pdf", md_content: "# Report\n" }, errors: [],
      }),
    });
    await expect(jsonClient.result("json-task")).resolves.toEqual({
      kind: "document", markdown: "# Report\n", assets: [],
    });
  });

  it("rejects failed, malformed, empty, and remotely-referenced JSON results", async () => {
    for (const payload of [
      { status: "failure", document: { md_content: "# no" } },
      { status: "success", document: {} },
      { status: "success", document: { md_content: "   " } },
      { status: "success", document: { md_content: "![remote](https://example.com/image.png)" } },
      { status: "success", document: { md_content: "![remote][img]\n\n[img]: https://example.com/image.png" } },
      { status: "success", document: { md_content: "![img]\n\n[img]: https://example.com/image.png" } },
      { status: "success", document: { md_content: "<img src=https://example.com/image.png>" } },
    ]) {
      const client = new DoclingClient({
        baseUrl: "http://127.0.0.1:5001", fetchImpl: async () => Response.json(payload),
      });
      await expect(client.result("bad")).rejects.toBeInstanceOf(ConversionResultError);
    }
  });
});
