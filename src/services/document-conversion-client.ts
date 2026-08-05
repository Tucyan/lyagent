export type ConversionStatus = "queued" | "running" | "completed" | "failed";

export type ConversionFailureCategory =
  | "policy"
  | "capacity"
  | "source_unavailable"
  | "target_unavailable"
  | "timeout"
  | "internal"
  | "backend_failure"
  | "inference_failure"
  | "unknown";
export type ConversionFailurePhase =
  | "admission"
  | "source_enumeration"
  | "execution"
  | "orchestration";

export interface PublicFailureInfo {
  category: ConversionFailureCategory;
  message: string;
  retryable: boolean;
  phase: ConversionFailurePhase;
  details: Record<string, string>;
}

export interface ConversionTaskStatus {
  status: ConversionStatus;
  queuedAhead?: number;
  error?: string;
  failure?: PublicFailureInfo;
}

export interface ImportedConversionResult {
  markdown: string;
  assets: Array<{ path: string; bytes: Uint8Array }>;
}

export type DocumentConversionResult =
  | { kind: "archive"; bytes: Uint8Array }
  | ({ kind: "document" } & ImportedConversionResult);

export interface DocumentConversionClient {
  health(signal?: AbortSignal): Promise<{ version?: string }>;
  submit(
    input: { filename: string; bytes: Uint8Array },
    signal?: AbortSignal,
  ): Promise<{ taskId: string; queuedAhead?: number }>;
  status(taskId: string, signal?: AbortSignal): Promise<ConversionTaskStatus>;
  result(taskId: string, signal?: AbortSignal): Promise<DocumentConversionResult>;
}

export class ConversionError extends Error {
  constructor(message = "Document conversion request failed") {
    super(message);
    this.name = "ConversionError";
  }
}

export class ConversionUnavailableError extends ConversionError {
  public readonly code = "CONVERTER_UNAVAILABLE";
  public readonly retryable = true;

  constructor(message = "Document converter is unavailable or timed out") {
    super(message);
    this.name = "ConversionUnavailableError";
  }
}

export class ConversionTaskMissingError extends ConversionError {
  constructor() {
    super("Document conversion task no longer exists");
    this.name = "ConversionTaskMissingError";
  }
}

export class ConversionTaskFailedError extends ConversionError {
  public readonly code = "CONVERSION_TASK_FAILED";
  public readonly retryable: boolean;
  public readonly category: ConversionFailureCategory;
  public readonly phase: ConversionFailurePhase;

  constructor(failure: PublicFailureInfo) {
    super("Document conversion task failed");
    this.name = "ConversionTaskFailedError";
    this.retryable = failure.retryable;
    this.category = failure.category;
    this.phase = failure.phase;
  }
}

export class ConversionConfigurationError extends ConversionError {
  constructor(message = "Document converter configuration is invalid") {
    super(message);
    this.name = "ConversionConfigurationError";
  }
}

export class ConversionResultError extends ConversionError {
  constructor(message = "Document conversion result is invalid") {
    super(message);
    this.name = "ConversionResultError";
  }
}
