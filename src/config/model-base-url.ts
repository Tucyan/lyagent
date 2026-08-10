import { z } from "zod";

export const modelBaseUrlSchema = z.string().url().refine(isSafeModelBaseUrl, "Model base URL must use HTTPS, or loopback HTTP without credentials, query, or fragment");

export function isSafeModelBaseUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || value.includes("?") || value.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
}

export function assertSafeModelBaseUrl(value: string): string {
  if (!isSafeModelBaseUrl(value)) throw new Error("Unsafe model base URL");
  return value;
}

/**
 * Accept both an OpenAI-compatible API root and a full Chat Completions URL.
 * pi-ai appends the protocol path itself, so a full endpoint must be reduced
 * to its parent path before constructing a runtime model.
 */
export function normalizeModelBaseUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (/\/chat\/completions$/iu.test(pathname)) {
    url.pathname = pathname.replace(/\/chat\/completions$/iu, "") || "/";
  }
  return url.toString().replace(/\/$/u, "");
}

export function modelApiProtocol(value: string, providerId: string): "openai-completions" | "openai-responses" {
  // Legacy/custom and Qwen-compatible registrations use Chat Completions.
  // The explicit `openai` provider is the only Responses-capable registration.
  if (providerId !== "openai") return "openai-completions";
  return /\/chat\/completions\/?$/iu.test(new URL(value).pathname) ? "openai-completions" : "openai-responses";
}
