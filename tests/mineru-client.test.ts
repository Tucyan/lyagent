import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  MineruClient,
  MineruConfigurationError,
  MineruUnavailableError,
  MineruTaskMissingError,
  importMineruResult,
} from "../src/services/mineru-client.js";

describe("MineruClient", () => {
  it("allows only loopback MinerU URLs", () => {
    expect(
      () => new MineruClient({ baseUrl: "http://192.168.1.50:8000" }),
    ).toThrow(MineruConfigurationError);
    expect(() => new MineruClient({ baseUrl: "https://example.com" })).toThrow(
      MineruConfigurationError,
    );
    expect(
      () => new MineruClient({ baseUrl: "http://127.0.0.1:8000" }),
    ).not.toThrow();
    expect(
      () => new MineruClient({ baseUrl: "http://[::1]:8000" }),
    ).not.toThrow();
  });

  it("checks health, submits multipart work, polls status, and downloads the result", async () => {
    const resultZip = zipSync({
      "report/report.md": strToU8("# Converted\n"),
      "report/images/chart.png": new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]),
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return Response.json({ protocol_version: "1", task_stats: {} });
      if (url.endsWith("/tasks") && init?.method === "POST")
        return Response.json(
          { task_id: "task-1", queued_ahead: 2 },
          { status: 202 },
        );
      if (url.endsWith("/tasks/task-1"))
        return Response.json({
          task_id: "task-1",
          status: "running",
          queued_ahead: 0,
        });
      if (url.endsWith("/tasks/task-1/result"))
        return new Response(resultZip, {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      return new Response(null, { status: 404 });
    });
    const client = new MineruClient({
      baseUrl: "http://127.0.0.1:8000",
      backend: "hybrid-engine",
      fetchImpl,
    });

    await expect(client.health()).resolves.toMatchObject({
      protocolVersion: "1",
    });
    await expect(
      client.submit({ filename: "report.docx", bytes: new Uint8Array([4, 5]) }),
    ).resolves.toEqual({ taskId: "task-1", queuedAhead: 2 });
    await expect(client.status("task-1")).resolves.toEqual({
      status: "running",
      queuedAhead: 0,
    });
    await expect(client.result("task-1")).resolves.toEqual(resultZip);
    const submitInit = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith("/tasks"),
    )![1]!;
    expect(submitInit.body).toBeInstanceOf(FormData);
    expect((submitInit.body as FormData).get("return_md")).toBe("true");
    expect((submitInit.body as FormData).get("return_original_file")).toBe(
      "false",
    );
    expect((submitInit.body as FormData).get("return_images")).toBe("true");
    expect((submitInit.body as FormData).get("backend")).toBe("hybrid-engine");
  });

  it("maps a missing task to a retryable error", async () => {
    const client = new MineruClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    await expect(client.status("lost")).rejects.toBeInstanceOf(
      MineruTaskMissingError,
    );
  });

  it("classifies connection failures and server errors as converter unavailability", async () => {
    const disconnected = new MineruClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(disconnected.health()).rejects.toMatchObject({
      name: "MineruUnavailableError",
      code: "CONVERTER_UNAVAILABLE",
      retryable: true,
    });
    await expect(disconnected.health()).rejects.toBeInstanceOf(
      MineruUnavailableError,
    );

    const overloaded = new MineruClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    await expect(overloaded.health()).rejects.toMatchObject({
      name: "MineruUnavailableError",
      retryable: true,
    });
  });

  it("rejects an oversized result response before buffering it", async () => {
    const client = new MineruClient({
      baseUrl: "http://127.0.0.1:8000",
      maxResultBytes: 4,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
    });
    await expect(client.result("large")).rejects.toThrow(/size limit/i);
  });
});

describe("safe MinerU result import", () => {
  it("selects one Markdown file and controlled image assets", () => {
    const imported = importMineruResult(
      zipSync({
        "result/report.md": strToU8("# Report\n\n![Chart](images/chart.png)\n"),
        "result/images/chart.png": new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]),
        "result/layout.json": strToU8("{}"),
      }),
    );
    expect(imported.markdown).toContain("# Report");
    expect(imported.assets).toEqual([
      {
        path: "assets/chart.png",
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
    ]);
    expect(imported.markdown).toContain("assets/chart.png");
  });

  it("rejects traversal, unsupported files, multiple Markdown roots, and oversized entries", () => {
    expect(() =>
      importMineruResult(zipSync({ "../evil.md": strToU8("bad") })),
    ).toThrow(/unsafe/i);
    expect(() =>
      importMineruResult(
        zipSync({
          "result/report.md": strToU8("ok"),
          "result/payload.exe": strToU8("bad"),
        }),
      ),
    ).toThrow(/unsupported/i);
    expect(() =>
      importMineruResult(
        zipSync({ "one.md": strToU8("one"), "two.md": strToU8("two") }),
      ),
    ).toThrow(/exactly one Markdown/i);
    expect(() =>
      importMineruResult(zipSync({ "report.md": strToU8("x".repeat(100)) }), {
        maxEntryBytes: 20,
      }),
    ).toThrow(/size/i);
    expect(() =>
      importMineruResult(
        zipSync({
          "report.md": strToU8("ok"),
          "fake.png": strToU8("not an image"),
        }),
      ),
    ).toThrow(/does not match/i);
    expect(() =>
      importMineruResult(
        zipSync({ "report.md": strToU8("ok"), "extra.txt": strToU8("") }),
        { maxEntries: 1 },
      ),
    ).toThrow(/too many entries/i);
    expect(() =>
      importMineruResult(zipSync({ "a/b/c/report.md": strToU8("ok") }), {
        maxDepth: 1,
      }),
    ).toThrow(/deeply nested/i);
  });
});
