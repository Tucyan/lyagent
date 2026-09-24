import https from "node:https";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import type { WebPage } from "./web-evidence-service.js";

const MAX_REDIRECTS = 3;
const MAX_CONTENT_CHARS = 20_000;

export type WebRequest = (url: string, init: RequestInit, validatedAddresses: readonly string[]) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;
export type PinnedHttpsOptions = Pick<https.RequestOptions, "ca">;

export class SafeWebFetcher {
  constructor(
    private readonly request: WebRequest = createPinnedHttpsRequest(),
    private readonly resolveHost: HostResolver = resolvePublicHost,
    private readonly timeoutMs = 15_000,
  ) {}

  async fetch(initialUrl: string): Promise<WebPage> {
    let current = parsePublicHttpsUrl(initialUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Web request timed out")), this.timeoutMs);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const addresses = await awaitWithAbort(this.resolveHost(current.hostname), controller.signal);
        this.assertPublic(addresses);
        const response = await awaitWithAbort(this.request(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "course-agent-web-reader/0.1" },
        }, addresses), controller.signal);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            await response.body?.cancel();
            throw new Error("Web redirect did not provide a destination");
          }
          await response.body?.cancel();
          current = parsePublicHttpsUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Web page returned HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.startsWith("text/html") && !contentType.startsWith("text/plain")) {
          await response.body?.cancel();
          throw new Error("Web page has an unsupported content type");
        }
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
        if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_CONTENT_CHARS * 4) {
          await response.body?.cancel();
          throw new Error("Web page is too large");
        }
        const body = await readLimitedBody(response, MAX_CONTENT_CHARS * 4);
        const page = contentType.startsWith("text/html") ? htmlToText(body) : { title: "", content: normalize(body) };
        return { url: current.toString(), title: page.title, content: page.content.slice(0, MAX_CONTENT_CHARS) };
      }
      throw new Error("Web page redirected too many times");
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertPublic(addresses: readonly string[]): void {
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("Web target is not public");
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Web request aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Web request aborted"));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

export function createPinnedHttpsRequest(tlsOptions: PinnedHttpsOptions = {}): WebRequest {
  return (url, init, validatedAddresses) => requestPinnedHttps(url, init, validatedAddresses, tlsOptions);
}

async function requestPinnedHttps(
  url: string,
  init: RequestInit,
  validatedAddresses: readonly string[],
  tlsOptions: PinnedHttpsOptions,
): Promise<Response> {
  const address = validatedAddresses[0];
  if (!address || net.isIP(address) === 0) throw new Error("Web target is not public");
  const parsed = new URL(url);
  const signal = init.signal;
  return new Promise((resolve, reject) => {
    const family = net.isIP(address);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const request = https.request(parsed, {
      method: "GET",
      headers: init.headers as Record<string, string>,
      lookup: pinnedLookup,
      ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
      ...tlsOptions,
    }, (incoming) => {
      try {
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status > 599) throw new Error(`Web server returned invalid HTTP status ${status}`);
        if (status === 205) throw new Error("Web server returned unsupported HTTP 205 status");
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        const bodyForbidden = status === 204 || status === 304;
        const body = bodyForbidden ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(body, {
          status,
          ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
          headers,
        }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Web request aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.end();
  });
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Web page is too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

async function resolvePublicHost(hostname: string): Promise<string[]> {
  const normalizedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(normalizedHostname)) return [normalizedHostname];
  const addresses = await lookup(normalizedHostname, { all: true });
  return addresses.map((address) => address.address);
}

function parsePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Web URL is invalid");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("Web URL must use HTTPS");
  return url;
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [first = -1, second = -1] = address.split(".").map(Number);
    const third = Number(address.split(".")[2] ?? -1);
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 ||
      first === 172 && second >= 16 && second <= 31 || first === 192 && (second === 168 || second === 0 || second === 88 && third === 99) ||
      first === 198 && (second === 18 || second === 19 || second === 51 && third === 100) ||
      first === 203 && second === 0 && third === 113 || first === 100 && second >= 64 && second <= 127 || first >= 224;
  }
  if (version === 6) {
    const value = parseIpv6(address);
    const mappedPrefix = 0xffffn;
    if (value >> 32n === mappedPrefix) {
      const ipv4 = Number(value & 0xffffffffn);
      return isPrivateAddress(`${ipv4 >>> 24}.${ipv4 >>> 16 & 0xff}.${ipv4 >>> 8 & 0xff}.${ipv4 & 0xff}`);
    }
    if (!hasIpv6Prefix(value, 0x20000000000000000000000000000000n, 3)) return true;
    return hasIpv6Prefix(value, 0x20010000000000000000000000000000n, 23) ||
      hasIpv6Prefix(value, 0x20010002000000000000000000000000n, 48) ||
      hasIpv6Prefix(value, 0x20010db8000000000000000000000000n, 32) ||
      hasIpv6Prefix(value, 0x3fff0000000000000000000000000000n, 20) ||
      hasIpv6Prefix(value, 0x20020000000000000000000000000000n, 16);
  }
  return true;
}

function parseIpv6(address: string): bigint {
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const octets = value.slice(lastColon + 1).split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const [left = "", right = ""] = value.split("::");
  const leftSegments = left ? left.split(":") : [];
  const rightSegments = right ? right.split(":") : [];
  const zeroCount = 8 - leftSegments.length - rightSegments.length;
  const segments = [...leftSegments, ...Array.from({ length: Math.max(0, zeroCount) }, () => "0"), ...rightSegments];
  return segments.reduce((result, segment) => (result << 16n) | BigInt(`0x${segment || "0"}`), 0n);
}

function hasIpv6Prefix(address: bigint, prefix: bigint, prefixLength: number): boolean {
  const shift = BigInt(128 - prefixLength);
  return address >> shift === prefix >> shift;
}

function htmlToText(html: string): { title: string; content: string } {
  const title = normalize((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]+>/g, ""));
  const content = normalize(html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?(?:p|div|h[1-6]|li|br|tr|article|section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, ""));
  return { title, content };
}

function normalize(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
