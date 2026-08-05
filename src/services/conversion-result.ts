import path from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import {
  ConversionResultError,
  type DocumentConversionResult,
  type ImportedConversionResult,
} from "./document-conversion-client.js";

export interface ConversionImportOptions {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const markdownExtensions = new Set([".md", ".mdown", ".markdown"]);

export function importConversionResult(
  source: DocumentConversionResult,
  options: ConversionImportOptions = {},
): ImportedConversionResult {
  if (source.kind === "document") return normalizeDocument(source.markdown, source.assets);
  const maxEntryBytes = options.maxEntryBytes ?? 20 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 500;
  const maxDepth = options.maxDepth ?? 8;
  let entries: Map<string, Uint8Array>;
  try {
    entries = unzipWithLimits(
      source.bytes, maxEntryBytes, maxTotalBytes, maxEntries, maxDepth,
    );
  } catch (error: unknown) {
    if (error instanceof ConversionResultError) throw error;
    throw new ConversionResultError("Conversion result is not a valid ZIP archive");
  }

  const markdownEntries: Array<{ path: string; bytes: Uint8Array }> = [];
  const images: Array<{ sourcePath: string; path: string; bytes: Uint8Array }> = [];
  const assetNames = new Set<string>();
  for (const [entryPath, bytes] of entries) {
    const extension = path.posix.extname(entryPath).toLowerCase();
    if (markdownExtensions.has(extension)) {
      markdownEntries.push({ path: entryPath, bytes });
      continue;
    }
    if (imageExtensions.has(extension)) {
      if (!isImageContent(extension, bytes))
        throw new ConversionResultError("Conversion image content does not match its extension");
      const basename = path.posix.basename(entryPath);
      const collisionKey = basename.toLocaleLowerCase("en-US");
      if (assetNames.has(collisionKey))
        throw new ConversionResultError("Conversion archive contains duplicate asset names");
      assetNames.add(collisionKey);
      images.push({ sourcePath: entryPath, path: `assets/${basename}`, bytes });
      continue;
    }
    if (extension !== ".json" && extension !== ".txt")
      throw new ConversionResultError("Conversion archive contains an unsupported file type");
  }
  if (markdownEntries.length !== 1)
    throw new ConversionResultError("Conversion result must contain exactly one Markdown document");
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(markdownEntries[0]!.bytes);
  } catch {
    throw new ConversionResultError("Conversion Markdown is not valid UTF-8");
  }
  if (!markdown.trim()) throw new ConversionResultError("Conversion Markdown result is empty");

  const markdownPath = markdownEntries[0]!.path;
  const mappings = new Map<string, string>();
  for (const image of images) mappings.set(image.sourcePath, image.path);
  markdown = rewriteMarkdownImages(markdown, markdownPath, mappings);
  return {
    markdown,
    assets: images.map(({ path: assetPath, bytes }) => ({ path: assetPath, bytes })),
  };
}

function normalizeDocument(
  markdown: string,
  assets: Array<{ path: string; bytes: Uint8Array }>,
): ImportedConversionResult {
  if (!markdown.trim()) throw new ConversionResultError("Conversion Markdown result is empty");
  const mappings = new Map<string, string>();
  const names = new Set<string>();
  for (const asset of assets) {
    const normalized = asset.path.replaceAll("\\", "/");
    if (!normalized.startsWith("assets/") || isUnsafeArchivePath(normalized))
      throw new ConversionResultError("Conversion result contains an unsafe asset path");
    const extension = path.posix.extname(normalized).toLowerCase();
    if (!imageExtensions.has(extension) || !isImageContent(extension, asset.bytes))
      throw new ConversionResultError("Conversion result contains an invalid image asset");
    const basename = path.posix.basename(normalized);
    const key = basename.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new ConversionResultError("Conversion result contains duplicate asset names");
    names.add(key);
    mappings.set(normalized, `assets/${basename}`);
  }
  return {
    markdown: rewriteMarkdownImages(markdown, "document.md", mappings),
    assets: assets.map((asset) => ({
      path: `assets/${path.posix.basename(asset.path.replaceAll("\\", "/"))}`,
      bytes: asset.bytes,
    })),
  };
}

function rewriteMarkdownImages(
  markdown: string,
  markdownPath: string,
  mappings: Map<string, string>,
): string {
  const rewrite = (rawTarget: string): string => {
    const target = rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1) : rawTarget;
    if (isUnsafeImageReference(target))
      throw new ConversionResultError("Conversion Markdown contains an unsafe image reference");
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(markdownPath), target.replaceAll("\\", "/")),
    );
    const replacement = mappings.get(resolved);
    if (!replacement)
      throw new ConversionResultError("Conversion Markdown references a missing image asset");
    return replacement;
  };

  let result = markdown.replace(
    /(!\[[^\]]*\]\(\s*)(?:<([^>\r\n]+)>|([^\s)>]+))([^)]*\))/g,
    (_match, prefix: string, angledTarget: string | undefined,
      bareTarget: string | undefined, suffix: string) =>
      `${prefix}${rewrite(angledTarget ?? bareTarget ?? "")}${suffix}`,
  );
  result = result.replace(
    /(<(?:img|source)\b[^>]*\bsrcset\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
    (_match, prefix: string, candidates: string, suffix: string) =>
      `${prefix}${rewriteSrcset(candidates, rewrite)}${suffix}`,
  );
  result = result.replace(
    /(<(?:img|source)\b[^>]*\bsrcset\s*=\s*)([^"'\s>]+)([^>]*>)/gi,
    (_match, prefix: string, target: string, suffix: string) =>
      `${prefix}${rewrite(target)}${suffix}`,
  );
  result = result.replace(
    /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
    (_match, prefix: string, target: string, suffix: string) =>
      `${prefix}${rewrite(target)}${suffix}`,
  );
  result = result.replace(
    /(<img\b[^>]*\bsrc\s*=\s*)([^"'\s>][^\s>]*)([^>]*>)/gi,
    (_match, prefix: string, target: string, suffix: string) =>
      `${prefix}${rewrite(target)}${suffix}`,
  );

  const referencedLabels = markdownImageReferenceLabels(result);
  if (referencedLabels.size > 0) {
    result = result.replace(
      /^(\s*\[([^\]]+)\]:\s*)(<?\S+>?)(.*)$/gm,
      (match, prefix: string, label: string, target: string, suffix: string) =>
        referencedLabels.has(label.trim().toLowerCase())
          ? `${prefix}${rewrite(target)}${suffix}` : match,
    );
  }
  return result;
}

function rewriteSrcset(
  value: string,
  rewrite: (target: string) => string,
): string {
  return value.split(",").map((candidate) => {
    const leading = candidate.match(/^\s*/)?.[0] ?? "";
    const trailing = candidate.match(/\s*$/)?.[0] ?? "";
    const content = candidate.trim();
    const separator = content.search(/\s/);
    const target = separator < 0 ? content : content.slice(0, separator);
    const descriptor = separator < 0 ? "" : content.slice(separator);
    return `${leading}${rewrite(target)}${descriptor}${trailing}`;
  }).join(",");
}

function markdownImageReferenceLabels(markdown: string): Set<string> {
  const labels = new Set<string>();
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const label = (match[2]!.trim() || match[1]!.trim()).toLowerCase();
    if (label) labels.add(label);
  }
  for (const match of markdown.matchAll(/!\[([^\]]+)\](?![\[(])/g)) {
    const label = match[1]!.trim().toLowerCase();
    if (label) labels.add(label);
  }
  return labels;
}

function isUnsafeImageReference(value: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(value).replaceAll("\\", "/"); }
  catch { return true; }
  if (
    !decoded || decoded.startsWith("/") || decoded.startsWith("//") ||
    /^[A-Za-z]:/.test(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded) ||
    decoded.includes("?") || decoded.includes("#")
  ) return true;
  return decoded.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function unzipWithLimits(
  zipBytes: Uint8Array,
  maxEntryBytes: number,
  maxTotalBytes: number,
  maxEntries: number,
  maxDepth: number,
): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let entryCount = 0;
  const unzipper = new Unzip((file) => {
    const normalized = file.name.replaceAll("\\", "/");
    entryCount += 1;
    if (entryCount > maxEntries)
      throw new ConversionResultError("Conversion archive contains too many entries");
    const directory = normalized.endsWith("/");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length > maxDepth + 1)
      throw new ConversionResultError("Conversion archive path is too deeply nested");
    if ((!directory && isUnsafeArchivePath(normalized)) || (directory && isUnsafeDirectoryPath(normalized)))
      throw new ConversionResultError("Conversion archive contains an unsafe path");
    if (file.originalSize !== undefined && file.originalSize > maxEntryBytes)
      throw new ConversionResultError("Conversion archive entry exceeds the size limit");
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      entryBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (entryBytes > maxEntryBytes)
        throw new ConversionResultError("Conversion archive entry exceeds the size limit");
      if (totalBytes > maxTotalBytes)
        throw new ConversionResultError("Conversion archive exceeds the total size limit");
      if (data.byteLength > 0) chunks.push(data);
      if (final && !directory) {
        if (entries.has(normalized))
          throw new ConversionResultError("Conversion archive contains duplicate paths");
        const merged = new Uint8Array(entryBytes);
        let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        entries.set(normalized, merged);
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  unzipper.push(zipBytes, true);
  return entries;
}

function isUnsafeArchivePath(value: string): boolean {
  return !value || value.startsWith("/") || value.startsWith("//") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"));
}

function isUnsafeDirectoryPath(value: string): boolean {
  const withoutSlash = value.replace(/\/+$/, "");
  return isUnsafeArchivePath(withoutSlash);
}

function isImageContent(extension: string, bytes: Uint8Array): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (extension === ".png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (extension === ".jpg" || extension === ".jpeg") return starts(0xff, 0xd8, 0xff);
  if (extension === ".gif")
    return starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  if (extension === ".webp")
    return new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP";
  return false;
}
