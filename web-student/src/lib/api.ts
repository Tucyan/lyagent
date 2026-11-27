export interface StudentApiErrorBody {
  code?: string;
  message?: string;
}

export class StudentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StudentApiError";
  }
}

export async function studentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    credentials: "same-origin",
    ...init,
  });
}

export async function studentJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await studentFetch(url, { ...init, headers });
  if (!response.ok) {
    let body: StudentApiErrorBody = {};
    try {
      body = (await response.json()) as StudentApiErrorBody;
    } catch {
      // ignore non-json error body
    }
    throw new StudentApiError(response.status, body.code ?? "HTTP_ERROR", body.message ?? `请求失败 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function navigateStudent(path: string, replace = false): void {
  if (window.location.pathname + window.location.search === path) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
