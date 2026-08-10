import path from "node:path";
import { z } from "zod";
import {
  ConversionConfigurationError,
  ConversionError,
  ConversionResultError,
  ConversionTaskFailedError,
  ConversionTaskMissingError,
  ConversionUnavailableError,
  type ConversionTaskStatus,
  type DocumentConversionClient,
  type DocumentConversionResult,
} from "./document-conversion-client.js";
import { importConversionResult } from "./conversion-result.js";

const taskIdSchema = z.string().trim().min(1).max(200);
const publicFailureInfoSchema = z.object({
  category: z.enum([
    "policy", "capacity", "source_unavailable", "target_unavailable",
    "timeout", "internal", "backend_failure", "inference_failure", "unknown",
  ]),
  message: z.string().max(20_000),
  retryable: z.boolean(),
  phase: z.enum(["admission", "source_enumeration", "execution", "orchestration"]),
  details: z.record(z.string(), z.string()).default({}),
});
const taskResponseSchema = z.object({
  task_id: taskIdSchema,
  task_status: z.enum(["pending", "started", "success", "failure"]),
  task_position: z.number().int().nonnegative().nullable().optional(),
  error_message: z.unknown().optional(),
  failure: publicFailureInfoSchema.nullable().optional(),
});
const taskFailureResultSchema = z.object({
  kind: z.literal("TaskFailureResult"),
  failure: publicFailureInfoSchema,
}).passthrough();
const inlineResultSchema = z.object({
  status: z.enum(["success", "partial_success"]),
  document: z.object({
    md_content: z.string().refine((value) => value.trim().length > 0),
  }).passthrough(),
}).passthrough();

export class DoclingClient implements DocumentConversionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxResultBytes?: number;
    signal?: AbortSignal;
  }) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new ConversionConfigurationError();
    }
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)
    ) throw new ConversionConfigurationError("Document converter must use a loopback HTTP URL");
    if (url.username || url.password || url.search || url.hash)
      throw new ConversionConfigurationError(
        "Document converter URL must not contain credentials, query, or fragment",
      );
    if (!Number.isFinite(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) <= 0)
      throw new ConversionConfigurationError();
    if (!Number.isSafeInteger(options.maxResultBytes ?? 50 * 1024 * 1024) ||
        (options.maxResultBytes ?? 50 * 1024 * 1024) <= 0)
      throw new ConversionConfigurationError();
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResultBytes = options.maxResultBytes ?? 50 * 1024 * 1024;
    this.signal = options.signal;
  }

  async health(signal?: AbortSignal): Promise<{ version?: string }> {
    await this.request("/health", undefined, this.operationSignal(signal));
    try {
      const operationSignal = this.operationSignal(signal);
      const response = await this.request("/version", undefined, operationSignal);
      const payload = await this.readJson(
        response, operationSignal, "Document converter returned an invalid version response",
      ) as Record<string, unknown>;
      const version = [payload.version, payload.docling_serve, payload["docling-serve"]]
        .find((value): value is string => typeof value === "string" && value.length > 0);
      return version ? { version } : {};
    } catch {
      return {};
    }
  }

  async submit(
    input: { filename: string; bytes: Uint8Array },
    signal?: AbortSignal,
  ): Promise<{ taskId: string; queuedAhead?: number }> {
    const form = new FormData();
    const basename = path.posix.basename(input.filename.replaceAll("\\", "/"));
    form.append("files", new Blob([new Uint8Array(input.bytes)]), basename);
    // Docling Serve 1.28 exposes this list enum as repeated multipart fields.
    // Sending JSON here is accepted by some mocks but is parsed as characters
    // by FastAPI and rejected with 422 by the real service.
    form.append("to_formats", "md");
    form.append("image_export_mode", "referenced");
    form.append("target_type", "zip");
    form.append("do_ocr", "true");
    form.append("force_ocr", "false");
    form.append("ocr_preset", "auto");
    form.append("table_mode", "accurate");
    form.append("pdf_backend", "pypdfium2");
    const operationSignal = this.operationSignal(signal);
    const response = await this.request(
      "/v1/convert/file/async",
      { method: "POST", body: form },
      operationSignal,
    );
    let payload: z.infer<typeof taskResponseSchema>;
    const rawPayload = await this.readJson(
      response, operationSignal, "Document converter returned an invalid submit response",
    );
    try { payload = taskResponseSchema.parse(rawPayload); }
    catch { throw new ConversionError("Document converter returned an invalid submit response"); }
    return {
      taskId: payload.task_id,
      ...(payload.task_position === null || payload.task_position === undefined
        ? {} : { queuedAhead: payload.task_position }),
    };
  }

  async status(taskId: string, signal?: AbortSignal): Promise<ConversionTaskStatus> {
    const safeTaskId = encodeURIComponent(parseTaskId(taskId));
    const operationSignal = this.operationSignal(signal);
    const response = await this.request(
      `/v1/status/poll/${safeTaskId}`, undefined, operationSignal, true,
    );
    let payload: z.infer<typeof taskResponseSchema>;
    const rawPayload = await this.readJson(
      response, operationSignal, "Document converter returned an invalid status response",
    );
    try { payload = taskResponseSchema.parse(rawPayload); }
    catch { throw new ConversionError("Document converter returned an invalid status response"); }
    const statuses = {
      pending: "queued", started: "running", success: "completed", failure: "failed",
    } as const;
    return {
      status: statuses[payload.task_status],
      ...(payload.task_position === null || payload.task_position === undefined
        ? {} : { queuedAhead: payload.task_position }),
      ...(payload.task_status === "failure" && payload.failure
        ? { failure: payload.failure } : {}),
    };
  }

  async result(taskId: string, signal?: AbortSignal): Promise<DocumentConversionResult> {
    const safeTaskId = encodeURIComponent(parseTaskId(taskId));
    const operationSignal = this.operationSignal(signal);
    const response = await this.request(
      `/v1/result/${safeTaskId}`, undefined, operationSignal, true,
    );
    const bytes = await this.readBounded(response, operationSignal);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("json")) {
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new ConversionResultError("Document converter returned an invalid in-body result");
      }
      const taskFailure = taskFailureResultSchema.safeParse(rawPayload);
      if (taskFailure.success)
        throw new ConversionTaskFailedError(taskFailure.data.failure);
      let payload: z.infer<typeof inlineResultSchema>;
      try {
        payload = inlineResultSchema.parse(rawPayload);
      } catch {
        throw new ConversionResultError("Document converter returned an invalid in-body result");
      }
      const markdown = payload.document.md_content;
      return {
        kind: "document",
        ...importConversionResult({ kind: "document", markdown, assets: [] }),
      };
    }
    return { kind: "archive", bytes };
  }

  private async readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const declaredLength = Number(rawLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > this.maxResultBytes)
        throw new ConversionResultError("Document conversion result exceeds the size limit");
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      let chunk;
      try { chunk = await waitWithSignal(reader.read(), signal); }
      catch {
        void reader.cancel().catch(() => undefined);
        throw new ConversionUnavailableError();
      }
      if (chunk.done) break;
      const value = chunk.value;
      size += value.byteLength;
      if (size > this.maxResultBytes) {
        await reader.cancel();
        throw new ConversionResultError("Document conversion result exceeds the size limit");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  private async request(
    relativePath: string,
    init: RequestInit | undefined,
    signal: AbortSignal,
    missingTask = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relativePath}`, {
        ...init,
        signal,
      });
    } catch {
      throw new ConversionUnavailableError();
    }
    if (missingTask && response.status === 404) throw new ConversionTaskMissingError();
    if ([408, 425, 429].includes(response.status) || response.status >= 500)
      throw new ConversionUnavailableError();
    if (!response.ok) throw new ConversionError(`Document converter request failed with status ${response.status}`);
    return response;
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    const signals = [this.signal, signal, AbortSignal.timeout(this.timeoutMs)]
      .filter((candidate): candidate is AbortSignal => candidate !== undefined);
    return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  }

  private async readJson(
    response: Response,
    signal: AbortSignal,
    invalidResponseMessage: string,
  ): Promise<unknown> {
    try { return await waitWithSignal(response.json(), signal); }
    catch (error: unknown) {
      if (error instanceof SyntaxError)
        throw new ConversionError(invalidResponseMessage);
      throw new ConversionUnavailableError();
    }
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function parseTaskId(taskId: string): string {
  try { return taskIdSchema.parse(taskId); }
  catch { throw new ConversionError("Document conversion task ID is invalid"); }
}
