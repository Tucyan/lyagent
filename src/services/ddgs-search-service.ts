import { z } from "zod";
import PQueue from "p-queue";

const requestSchema = z.object({
  query: z.string().trim().min(1).max(400),
  count: z.number().int().min(1).optional(),
  region: z.string().trim().min(2).max(20).optional(),
  safeSearch: z.enum(["on", "moderate", "off"]).optional(),
  timeLimit: z.enum(["d", "w", "m", "y"]).optional(),
});

const rawResultSchema = z.object({
  title: z.string().optional(),
  href: z.string().url().optional(),
  body: z.string().optional(),
});

export interface DdgsSearchRequest {
  query: string;
  count: number;
  region: string;
  safeSearch: "on" | "moderate" | "off";
  timeLimit?: "d" | "w" | "m" | "y";
}

export interface DdgsSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type DdgsRunner = (request: DdgsSearchRequest) => Promise<unknown>;

export class DdgsSearchService {
  private readonly queue = new PQueue({ concurrency: 1 });

  constructor(private readonly runner: DdgsRunner, private readonly defaults: { maxResults: number } = { maxResults: 5 }) {}

  async search(input: z.input<typeof requestSchema>): Promise<DdgsSearchResult[]> {
    const parsed = requestSchema.parse(input);
    const request: DdgsSearchRequest = {
      query: parsed.query,
      count: Math.min(parsed.count ?? this.defaults.maxResults, 10),
      region: parsed.region ?? "zh-cn",
      safeSearch: parsed.safeSearch ?? "moderate",
      ...(parsed.timeLimit ? { timeLimit: parsed.timeLimit } : {}),
    };
    const raw = await this.queue.add(() => this.runner(request));
    return z.array(rawResultSchema).parse(raw)
      .filter((result): result is { title?: string; href: string; body?: string } => Boolean(result.href))
      .map((result) => ({
        title: normalize(result.title ?? "Untitled result"),
        url: result.href,
        snippet: normalize(result.body ?? ""),
      }));
  }
}

function normalize(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
