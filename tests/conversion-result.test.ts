import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ConversionResultError } from "../src/services/document-conversion-client.js";
import { importConversionResult } from "../src/services/conversion-result.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("conversion result import", () => {
  it("imports one md/mdown document, metadata, and flattened image assets", () => {
    const imported = importConversionResult({
      kind: "archive",
      bytes: zipSync({
        "result/report.mdown": strToU8("# Report\n\n![Chart](images/nested/chart.png)\n"),
        "result/images/nested/chart.png": png,
        "result/metadata.json": strToU8("{}"),
        "result/diagnostics.txt": strToU8("ok"),
      }),
    });
    expect(imported.markdown).toContain("assets/chart.png");
    expect(imported.assets).toEqual([{ path: "assets/chart.png", bytes: png }]);
  });

  it("imports a normalized in-body document through the same interface", () => {
    expect(importConversionResult({
      kind: "document", markdown: "# Report\n", assets: [],
    })).toEqual({ markdown: "# Report\n", assets: [] });
  });

  it.each([
    ["zip slip", { "../evil.md": strToU8("bad") }],
    ["absolute path", { "/evil.md": strToU8("bad") }],
    ["drive path", { "C:/evil.md": strToU8("bad") }],
    ["unsupported file", { "report.md": strToU8("ok"), "x.exe": strToU8("bad") }],
    ["two markdown files", { "one.md": strToU8("one"), "two.mdown": strToU8("two") }],
    ["empty markdown", { "report.md": strToU8("  ") }],
    ["forged image", { "report.md": strToU8("ok"), "fake.png": strToU8("bad") }],
    ["duplicate flattened asset", {
      "report.md": strToU8("![a](one/chart.png)\n![b](two/chart.png)"),
      "one/chart.png": png, "two/chart.png": png,
    }],
  ])("rejects %s", (_label, entries) => {
    expect(() => importConversionResult({ kind: "archive", bytes: zipSync(entries) }))
      .toThrow(ConversionResultError);
  });

  it.each([
    "![remote](https://example.com/image.png)",
    "![remote](//example.com/image.png)",
    "![absolute](/images/image.png)",
    "![drive](C:/images/image.png)",
    "![escape](../image.png)",
    '<img src="https://example.com/image.png">',
    "![img]\n\n[img]: https://example.com/image.png",
    "<img src=https://example.com/image.png>",
  ])("rejects unsafe Markdown image reference %s", (markdown) => {
    expect(() => importConversionResult({
      kind: "archive", bytes: zipSync({ "result/report.md": strToU8(markdown) }),
    })).toThrow(ConversionResultError);
  });

  it("enforces entry, total, count, and depth limits", () => {
    expect(() => importConversionResult(
      { kind: "archive", bytes: zipSync({ "report.md": strToU8("x".repeat(30)) }) },
      { maxEntryBytes: 20 },
    )).toThrow(/size/i);
    expect(() => importConversionResult(
      { kind: "archive", bytes: zipSync({
        "report.md": strToU8("12345"), "meta.txt": strToU8("12345"),
      }) }, { maxTotalBytes: 8 },
    )).toThrow(/size/i);
    expect(() => importConversionResult(
      { kind: "archive", bytes: zipSync({
        "report.md": strToU8("ok"), "meta.txt": strToU8("ok"),
      }) }, { maxEntries: 1 },
    )).toThrow(/entries/i);
    expect(() => importConversionResult(
      { kind: "archive", bytes: zipSync({ "a/b/c/report.md": strToU8("ok") }) },
      { maxDepth: 1 },
    )).toThrow(/deep/i);
  });

  it("uses supplier-neutral error messages", () => {
    let error: unknown;
    try { importConversionResult({ kind: "archive", bytes: new Uint8Array([1]) }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ConversionResultError);
    expect(String(error)).not.toMatch(/MinerU/i);
  });
});
