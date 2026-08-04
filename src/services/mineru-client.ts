import path from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { z } from "zod";

const taskIdSchema = z.string().trim().min(1).max(200);
const submitResponseSchema = z.object({ task_id: taskIdSchema, queued_ahead: z.number().int().nonnegative().optional() });
const statusResponseSchema = z.object({
  status: z.enum(["pending", "queued", "running", "completed", "failed"]),
  queued_ahead: z.number().int().nonnegative().optional(),
  error: z.string().max(2_000).optional(),
});

export class MineruError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MineruError";
  }
}

export class MineruConfigurationError extends MineruError {
  constructor(message: string) {
    super(message);
    this.name = "MineruConfigurationError";
  }
}

export class MineruTaskMissingError extends MineruError {
  constructor() {
    super("MinerU task no longer exists and may be resubmitted from the immutable original");
    this.name = "MineruTaskMissingError";
  }
}

export interface MineruTaskStatus {
  status: "queued" | "running" | "completed" | "failed";
  queuedAhead?: number;
  error?: string;
}

export class MineruClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResultBytes?: number }) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new MineruConfigurationError("MinerU base URL is invalid");
    }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]" && hostname !== "::1")) {
      throw new MineruConfigurationError("MinerU must use a loopback HTTP URL");
    }
    if (url.username || url.password || url.search || url.hash) throw new MineruConfigurationError("MinerU base URL must not contain credentials, query, or fragment");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResultBytes = options.maxResultBytes ?? 50 * 1024 * 1024;
  }

  async health(): Promise<{ protocolVersion?: string }> {
    const response = await this.request("/health");
    const payload = await response.json() as { protocol_version?: unknown };
    return { ...(typeof payload.protocol_version === "string" ? { protocolVersion: payload.protocol_version } : {}) };
  }

  async submit(input: { filename: string; bytes: Uint8Array }): Promise<{ taskId: string; queuedAhead?: number }> {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(input.bytes)]), path.basename(input.filename));
    form.append("return_md", "true");
    form.append("return_original_file", "false");
    form.append("response_format_zip", "true");
    const response = await this.request("/tasks", { method: "POST", body: form });
    const payload = submitResponseSchema.parse(await response.json());
    return { taskId: payload.task_id, ...(payload.queued_ahead === undefined ? {} : { queuedAhead: payload.queued_ahead }) };
  }

  async status(taskId: string): Promise<MineruTaskStatus> {
    const response = await this.request(`/tasks/${encodeURIComponent(taskIdSchema.parse(taskId))}`, undefined, true);
    const payload = statusResponseSchema.parse(await response.json());
    const status = payload.status === "pending" ? "queued" : payload.status;
    return {
      status,
      ...(payload.queued_ahead === undefined ? {} : { queuedAhead: payload.queued_ahead }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
    };
  }

  async result(taskId: string): Promise<Uint8Array> {
    const response = await this.request(`/tasks/${encodeURIComponent(taskIdSchema.parse(taskId))}/result`, undefined, true);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResultBytes) throw new MineruError("MinerU result response exceeds the size limit");
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.maxResultBytes) { await reader.cancel(); throw new MineruError("MinerU result response exceeds the size limit"); }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  private async request(relativePath: string, init?: RequestInit, missingIsRetryable = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relativePath}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new MineruError("MinerU request failed or timed out");
    }
    if (response.status === 404 && missingIsRetryable) throw new MineruTaskMissingError();
    if (!response.ok) throw new MineruError(`MinerU request failed with status ${response.status}`);
    return response;
  }
}

export interface ImportedMineruResult {
  markdown: string;
  assets: Array<{ path: string; bytes: Uint8Array }>;
}

export function importMineruResult(zipBytes: Uint8Array, options: { maxEntryBytes?: number; maxTotalBytes?: number; maxEntries?: number; maxDepth?: number } = {}): ImportedMineruResult {
  const maxEntryBytes = options.maxEntryBytes ?? 20 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 500;
  const maxDepth = options.maxDepth ?? 8;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipWithLimits(zipBytes, maxEntryBytes, maxTotalBytes, maxEntries, maxDepth);
  } catch (error: unknown) {
    if (error instanceof MineruError) throw error;
    throw new MineruError("MinerU result is not a valid ZIP archive");
  }
  const markdownEntries: Array<{ path: string; bytes: Uint8Array }> = [];
  const imageEntries: Array<{ sourcePath: string; path: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  const usedAssetNames = new Set<string>();
  for (const [rawPath, bytes] of Object.entries(entries)) {
    const normalized = rawPath.replaceAll("\\", "/");
    if (isUnsafeArchivePath(normalized)) throw new MineruError("MinerU archive contains an unsafe path");
    if (bytes.byteLength > maxEntryBytes) throw new MineruError("MinerU archive entry exceeds the size limit");
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotalBytes) throw new MineruError("MinerU archive exceeds the total size limit");
    const extension = path.posix.extname(normalized).toLowerCase();
    if (extension === ".md" || extension === ".markdown") markdownEntries.push({ path: normalized, bytes });
    else if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
      if (!isImageContent(extension, bytes)) throw new MineruError("MinerU image content does not match its filename extension");
      const basename = path.posix.basename(normalized);
      if (usedAssetNames.has(basename)) throw new MineruError("MinerU archive contains duplicate asset names");
      usedAssetNames.add(basename);
      imageEntries.push({ sourcePath: normalized, path: `assets/${basename}`, bytes });
    } else if (extension !== ".json" && extension !== ".txt") {
      throw new MineruError("MinerU archive contains an unsupported file type");
    }
  }
  if (markdownEntries.length !== 1) throw new MineruError("MinerU result must contain exactly one Markdown document");
  let markdown = new TextDecoder("utf-8", { fatal: true }).decode(markdownEntries[0]!.bytes);
  if (!markdown.trim()) throw new MineruError("MinerU Markdown result is empty");
  for (const asset of imageEntries) {
    const relativeFromMarkdown = path.posix.relative(path.posix.dirname(markdownEntries[0]!.path), asset.sourcePath);
    markdown = markdown.replaceAll(relativeFromMarkdown, asset.path).replaceAll(asset.sourcePath, asset.path);
  }
  return { markdown, assets: imageEntries.map(({ path: assetPath, bytes }) => ({ path: assetPath, bytes })) };
}

function isImageContent(extension: string, bytes: Uint8Array): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (extension === ".png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (extension === ".jpg" || extension === ".jpeg") return starts(0xff, 0xd8, 0xff);
  if (extension === ".gif") return starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  if (extension === ".webp") return new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP";
  return false;
}

function unzipWithLimits(zipBytes: Uint8Array, maxEntryBytes: number, maxTotalBytes: number, maxEntries: number, maxDepth: number): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  let entryCount = 0;
  const unzipper = new Unzip((file) => {
    const normalized = file.name.replaceAll("\\", "/");
    entryCount += 1;
    if (entryCount > maxEntries) throw new MineruError("MinerU archive contains too many entries");
    if (normalized.split("/").filter(Boolean).length > maxDepth + 1) throw new MineruError("MinerU archive path is too deeply nested");
    if (isUnsafeArchivePath(normalized)) throw new MineruError("MinerU archive contains an unsafe path");
    if (file.originalSize !== undefined && file.originalSize > maxEntryBytes) throw new MineruError("MinerU archive entry exceeds the size limit");
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      entryBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (entryBytes > maxEntryBytes) throw new MineruError("MinerU archive entry exceeds the size limit");
      if (totalBytes > maxTotalBytes) throw new MineruError("MinerU archive exceeds the total size limit");
      if (data.byteLength > 0) chunks.push(data);
      if (final) {
        const merged = new Uint8Array(entryBytes);
        let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        entries[normalized] = merged;
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
  return !value || value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value) || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"));
}
