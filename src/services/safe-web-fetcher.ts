import { lookup } from "node:dns/promises";
import net from "node:net";
import type { WebPage } from "./web-evidence-service.js";

const MAX_REDIRECTS = 3;
const MAX_CONTENT_CHARS = 20_000;

export type WebRequest = (url: string, init: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;

export class SafeWebFetcher {
  constructor(private readonly request: WebRequest = fetch, private readonly resolveHost: HostResolver = resolvePublicHost) {}

  async fetch(initialUrl: string): Promise<WebPage> {
    let current = parsePublicHttpsUrl(initialUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.assertPublic(current.hostname);
      const response = await this.request(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "course-agent-web-reader/0.1" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Web redirect did not provide a destination");
        current = parsePublicHttpsUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Web page returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html") && !contentType.startsWith("text/plain")) throw new Error("Web page has an unsupported content type");
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_CHARS * 4) throw new Error("Web page is too large");
      const body = (await response.text()).slice(0, MAX_CONTENT_CHARS * 4);
      const page = contentType.startsWith("text/html") ? htmlToText(body) : { title: "", content: normalize(body) };
      return { url: current.toString(), title: page.title, content: page.content.slice(0, MAX_CONTENT_CHARS) };
    }
    throw new Error("Web page redirected too many times");
  }

  private async assertPublic(hostname: string): Promise<void> {
    const addresses = await this.resolveHost(hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("Web target is not public");
  }
}

async function resolvePublicHost(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true });
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
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return true;
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
