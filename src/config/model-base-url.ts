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
