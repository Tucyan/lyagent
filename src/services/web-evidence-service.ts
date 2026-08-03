import type { DdgsSearchService, DdgsSearchResult } from "./ddgs-search-service.js";

export interface WebPage {
  url: string;
  title: string;
  content: string;
}

export type WebPageFetcher = (url: string) => Promise<WebPage>;

export interface WebSearchItem extends DdgsSearchResult {
  resultId: string;
}

export interface WebEvidence extends WebPage {
  sourceId: string;
  startLine: number;
  endLine: number;
}

export interface WebCitationRange {
  sourceId: string;
  startLine: number;
  endLine: number;
}

export class WebEvidenceService {
  private readonly results = new Map<string, WebSearchItem>();
  private readonly readRanges = new Map<string, Array<{ startLine: number; endLine: number }>>();
  private readonly pages = new Map<string, WebEvidence>();
  private nextId = 1;

  constructor(private readonly searchService: Pick<DdgsSearchService, "search">, private readonly fetchPage: WebPageFetcher) {}

  async search(input: Parameters<DdgsSearchService["search"]>[0]): Promise<WebSearchItem[]> {
    const results = await this.searchService.search(input);
    return results.map((result) => {
      const item = { ...result, resultId: `web-${this.nextId++}` };
      this.results.set(item.resultId, item);
      return item;
    });
  }

  async read(resultId: string): Promise<WebEvidence> {
    const result = this.results.get(resultId);
    if (!result) throw new Error("Web result was not found");
    const cached = this.pages.get(resultId);
    if (cached) return cached;
    const page = await this.fetchPage(result.url);
    const lines = page.content.split("\n");
    const evidence: WebEvidence = {
      sourceId: resultId,
      title: page.title || result.title,
      url: page.url,
      content: page.content,
      startLine: 1,
      endLine: Math.max(lines.length, 1),
    };
    this.pages.set(resultId, evidence);
    this.readRanges.set(resultId, [{ startLine: evidence.startLine, endLine: evidence.endLine }]);
    return evidence;
  }

  hasRead(citation: WebCitationRange): boolean {
    return (this.readRanges.get(citation.sourceId) ?? []).some((range) => citation.startLine >= range.startLine && citation.endLine <= range.endLine);
  }

  citation(citation: WebCitationRange): WebEvidence | undefined {
    if (!this.hasRead(citation)) return undefined;
    return this.pages.get(citation.sourceId);
  }
}
