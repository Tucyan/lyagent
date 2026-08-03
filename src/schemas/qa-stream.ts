export interface KnowledgeCitation {
  type: "knowledge";
  path: string;
  startLine: number;
  endLine: number;
}

export interface WebCitation {
  type: "web";
  sourceId: string;
  title: string;
  url: string;
  startLine: number;
  endLine: number;
}

export type CourseCitation = KnowledgeCitation | WebCitation;

export interface CourseAnswer {
  answer: string;
  citations: CourseCitation[];
  insufficient: boolean;
}

export type CourseQaEvent =
  | { type: "status"; phase: "thinking" | "answering" }
  | { type: "tool_start"; id: string; name: QaToolName; label: string; summary: string }
  | { type: "tool_end"; id: string; name: QaToolName; label: string; summary: string; status: "completed" | "failed" }
  | { type: "answer_delta"; delta: string }
  | { type: "final"; answer: string; citations: CourseCitation[]; insufficient: boolean; releaseId: string; sessionId: string }
  | { type: "error"; code: string; message: string };

export type QaToolName = "get_knowledge_root" | "list_knowledge_directory" | "search_knowledge" | "read_knowledge_lines" | "web_search" | "read_web_result";
