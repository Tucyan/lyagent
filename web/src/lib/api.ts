export function withJsonHeaders(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return { ...init, headers };
}
