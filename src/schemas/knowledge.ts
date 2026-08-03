import { z } from "zod";

export const knowledgePathSchema = z.string().max(240).refine((value) => value === "" || (
  !value.includes("\\")
  && !value.startsWith("/")
  && !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))
), "Invalid knowledge path");

export const searchQuerySchema = z.string().trim().min(1).max(120);
export const paginationSchema = z.object({ offset: z.number().int().min(0).max(10_000), maxResults: z.number().int().min(1).max(10) });
export const lineRangeSchema = z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).refine((range) => range.endLine >= range.startLine, "Invalid line range");

export interface KnowledgeDocument {
  path: string;
  title: string;
}

export interface KnowledgeSearchResult extends KnowledgeDocument {
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface KnowledgeLineRange {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}
