import { inputIssueMessage, rubricProblemMessage, userErrorMessage } from "../../../src/schemas/user-feedback.js";
export { rubricProblemMessage, reviewReasonLabel, userErrorMessage } from "../../../src/schemas/user-feedback.js";

export async function apiFetch(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError({ code: "NETWORK_ERROR", message: "" });
  }
}

export function withJsonHeaders(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return { ...init, headers };
}

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly issues: ApiIssue[];
  readonly issuePaths: string[];

  constructor(input: { code: string; message: string; issues?: ApiIssue[] }) {
    const issues = input.issues ?? [];
    const details = issues.map((issue) => inputIssueMessage(issue.path));
    super([userErrorMessage(input.code), ...new Set(details)].join("\n"));
    this.name = "ApiError";
    this.code = input.code;
    this.issues = issues;
    this.issuePaths = [...new Set(issues.map((issue) => issue.path).filter(Boolean))];
  }
}

export async function apiErrorFromResponse(
  response: Response,
  fallbackMessage = "请求失败",
): Promise<ApiError> {
  const payload = await response.json().catch(() => undefined) as {
    code?: unknown;
    message?: unknown;
    issues?: unknown;
    errors?: Array<{ code: string; path?: string }>;
  } | undefined;
  const issues = Array.isArray(payload?.issues)
    ? payload.issues.flatMap((issue) => {
        if (!issue || typeof issue !== "object") return [];
        const value = issue as { path?: unknown; message?: unknown };
        if (typeof value.path !== "string" || typeof value.message !== "string") return [];
        return [{ path: value.path, message: value.message }];
      })
    : [];
  const result = new ApiError({
    code: typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`,
    message: typeof payload?.message === "string" && payload.message.trim()
      ? payload.message
      : fallbackMessage,
    issues,
  });
  if (result.code === "RUBRIC_VALIDATION_FAILED" && Array.isArray(payload?.errors)) {
    const details = payload.errors.filter((item) => item && typeof item.code === "string").map((item) => rubricProblemMessage(item));
    result.message = [result.message, ...new Set(details)].join("\n");
  }
  return result;
}
