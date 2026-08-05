import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { CourseKnowledgeService } from "../../services/knowledge-service.js";
import type { StoredGradingDraft, GradingResultService } from "../../services/grading-result-service.js";
import type { GradingSessionService } from "../../services/grading-session-service.js";
import type { WebEvidenceService } from "../../services/web-evidence-service.js";
import { createCourseQaTools } from "../knowledge/index.js";

export type GradingToolName =
  | "list_submission_files" | "search_submission" | "read_submission_lines" | "read_submission_image"
  | "read_grading_draft" | "submit_grading_draft"
  | "get_knowledge_root" | "list_knowledge_directory" | "search_knowledge" | "read_knowledge_lines"
  | "web_search" | "read_web_result" | "ask_grading_question"
  | "set_submission_title";

export interface GradingQuestion {
  question: string;
  options?: string[];
}

export interface AssignmentGraderTools {
  tools: AgentTool<any>[];
  capturedQuestion(): GradingQuestion | undefined;
  capturedTitle(): string | undefined;
  updatedDraft(): StoredGradingDraft | undefined;
}

const approvedKnowledgeNames = new Set<GradingToolName>([
  "get_knowledge_root", "list_knowledge_directory", "search_knowledge", "read_knowledge_lines", "web_search", "read_web_result",
]);

const knowledgeLabels: Partial<Record<GradingToolName, string>> = {
  get_knowledge_root: "查看课程资料范围",
  list_knowledge_directory: "浏览课程资料",
  search_knowledge: "搜索课程资料",
  read_knowledge_lines: "阅读课程资料",
  web_search: "搜索互联网",
  read_web_result: "阅读网页内容",
};

export function createAssignmentGraderTools(options: {
  sessions: GradingSessionService;
  results: GradingResultService;
  sessionId: string;
  runId: string;
  knowledge: CourseKnowledgeService;
  web?: WebEvidenceService;
  purpose?: "grading" | "naming";
  visionAvailable?: boolean;
}): AssignmentGraderTools {
  let question: GradingQuestion | undefined;
  let capturedTitle: string | undefined;
  let updatedDraft: StoredGradingDraft | undefined;
  const emptySchema = Type.Object({}, { additionalProperties: false });

  const listSubmissionFiles: AgentTool<typeof emptySchema> = {
    name: "list_submission_files",
    label: "浏览作业文件",
    description: "List the current locked submission Markdown document and its controlled assets. Paths are relative identifiers, not local filesystem paths.",
    parameters: emptySchema,
    executionMode: "sequential",
    execute: async () => {
      const submission = await options.sessions.getLockedSubmission(options.sessionId);
      const originalFilename = await options.sessions.getOriginalFilename(options.sessionId);
      return { content: [{ type: "text", text: JSON.stringify([{ path: submission.path, type: "markdown", originalFilename }, ...(submission.assetPaths ?? []).map((path) => ({ path, type: "image" }))]) }], details: {} };
    },
  };

  const searchSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false });
  const searchSubmission: AgentTool<typeof searchSchema> = {
    name: "search_submission",
    label: "搜索学生作业",
    description: "Search the current locked Markdown submission and return bounded matching lines.",
    parameters: searchSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      const submission = await options.sessions.getLockedSubmission(options.sessionId);
      const lines = (await options.sessions.readSubmission(options.sessionId)).split(/\r?\n/);
      const query = parameters.query.toLocaleLowerCase();
      const results = lines.flatMap((line, index) => line.toLocaleLowerCase().includes(query) ? [{ path: submission.path, startLine: index + 1, endLine: index + 1, excerpt: line.slice(0, 300) }] : []);
      return { content: [{ type: "text", text: JSON.stringify(results.slice(0, parameters.maxResults ?? 10)) }], details: {} };
    },
  };

  const readLinesSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const readSubmissionLines: AgentTool<typeof readLinesSchema> = {
    name: "read_submission_lines",
    label: "阅读作业内容",
    description: "Read at most 200 lines from the current locked Markdown submission.",
    parameters: readLinesSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      const submission = await options.sessions.getLockedSubmission(options.sessionId);
      if (parameters.path !== submission.path) throw new Error("Requested path is not the current submission");
      if (parameters.endLine < parameters.startLine || parameters.endLine - parameters.startLine + 1 > 200 || parameters.startLine > submission.lineCount) throw new Error("Requested line range is invalid");
      const lines = (await options.sessions.readSubmission(options.sessionId)).split(/\r?\n/);
      const endLine = Math.min(parameters.endLine, lines.length);
      return { content: [{ type: "text", text: JSON.stringify({ path: submission.path, startLine: parameters.startLine, endLine, content: `${lines.slice(parameters.startLine - 1, endLine).join("\n")}\n` }) }], details: {} };
    },
  };

  const readImageSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false });
  const readSubmissionImage: AgentTool<typeof readImageSchema> = {
    name: "read_submission_image",
    label: "查看作业图片",
    description: "Read one controlled image from the current submission for visual grading evidence.",
    parameters: readImageSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      if (!options.visionAvailable) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ code: "VISION_MODEL_NOT_CONFIGURED" }) }], details: {} };
      }
      const submission = await options.sessions.getLockedSubmission(options.sessionId);
      if (!(submission.assetPaths ?? []).includes(parameters.path)) throw new Error("Requested image is not part of the current submission");
      const bytes = await options.sessions.readSubmissionAsset(options.sessionId, parameters.path);
      return { content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: imageMime(parameters.path) }], details: {} };
    },
  };

  const readGradingDraft: AgentTool<typeof emptySchema> = {
    name: "read_grading_draft",
    label: "读取批改草稿",
    description: "Read the current program-validated grading draft and optimistic version, or null if none exists.",
    parameters: emptySchema,
    executionMode: "sequential",
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify((await options.results.readDraft(options.sessionId)) ?? null) }], details: {} }),
  };

  const submitSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }), draft: Type.Any() }, { additionalProperties: false });
  const submitGradingDraft: AgentTool<typeof submitSchema> = {
    name: "submit_grading_draft",
    label: "更新批改草稿",
    description: "Submit all per-item judgments, structured grading arguments explaining each exact score, optional source references, confidence, and evidence-insufficient flags. Program code validates and recalculates the score.",
    parameters: submitSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      if (updatedDraft) throw new Error("A grading draft has already been submitted in this turn");
      updatedDraft = await options.results.submitDraft(options.sessionId, parameters.expectedVersion, parameters.draft, { type: "agent", id: options.runId });
      return { content: [{ type: "text", text: JSON.stringify({ version: updatedDraft.version, score: updatedDraft.result.score, review: updatedDraft.result.review }) }], details: {}, terminate: true };
    },
  };

  const knowledgeTools = createCourseQaTools(options.knowledge, options.web).tools
    .filter((tool) => approvedKnowledgeNames.has(tool.name as GradingToolName))
    .map((tool) => ({ ...tool, label: knowledgeLabels[tool.name as GradingToolName] ?? tool.label }));

  const askSchema = Type.Object({ question: Type.String({ minLength: 1, maxLength: 2_000 }), options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 6 })) }, { additionalProperties: false });
  const askGradingQuestion: AgentTool<typeof askSchema> = {
    name: "ask_grading_question",
    label: "向教师确认",
    description: "Ask one structured question only when a material rubric ambiguity or missing submission material prevents a reliable judgment.",
    parameters: askSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      if (question) throw new Error("A grading question has already been captured");
      question = { question: parameters.question, ...(parameters.options ? { options: parameters.options } : {}) };
      await options.sessions.setGradingStatus(options.sessionId, "waiting_for_teacher", options.runId);
      return { content: [{ type: "text", text: "Question captured." }], details: {}, terminate: true };
    },
  };

  const titleSchema = Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
  const setSubmissionTitle: AgentTool<typeof titleSchema> = {
    name: "set_submission_title",
    label: "命名学生作业",
    description: "Save the current student's report title after checking both the document body and original filename. Prefer the title found in the body when they conflict. This is the required terminal action for naming.",
    parameters: titleSchema,
    executionMode: "sequential",
    execute: async (_id, parameters) => {
      if (capturedTitle) throw new Error("A submission title has already been set in this turn");
      const resolved = await options.sessions.resolveSubmissionTitle(options.sessionId, parameters.title);
      capturedTitle = resolved.submissionTitle;
      return { content: [{ type: "text", text: JSON.stringify({ title: capturedTitle }) }], details: {}, terminate: true };
    },
  };

  const tools = options.purpose === "naming"
    ? [listSubmissionFiles, searchSubmission, readSubmissionLines, setSubmissionTitle]
    : [listSubmissionFiles, searchSubmission, readSubmissionLines, readSubmissionImage, readGradingDraft, submitGradingDraft, ...knowledgeTools, askGradingQuestion];

  return {
    tools,
    capturedQuestion: () => question,
    capturedTitle: () => capturedTitle,
    updatedDraft: () => updatedDraft,
  };
}

export function isGradingToolName(value: string): value is GradingToolName {
  return ["list_submission_files", "search_submission", "read_submission_lines", "read_submission_image", "read_grading_draft", "submit_grading_draft", "get_knowledge_root", "list_knowledge_directory", "search_knowledge", "read_knowledge_lines", "web_search", "read_web_result", "ask_grading_question", "set_submission_title"].includes(value);
}

export function gradingToolActivity(name: GradingToolName, args: Record<string, unknown>): { label: string; summary: string } {
  const fixed: Record<GradingToolName, { label: string; summary: string }> = {
    list_submission_files: { label: "浏览作业文件", summary: "查看当前作业的受控文件清单" },
    search_submission: { label: "搜索学生作业", summary: "在当前学生作业中搜索相关内容" },
    read_submission_lines: { label: "阅读作业内容", summary: typeof args.startLine === "number" && typeof args.endLine === "number" ? `读取当前作业正文片段 · L${args.startLine}-L${args.endLine}` : "读取当前作业正文片段" },
    read_submission_image: { label: "查看作业图片", summary: "查看当前作业中的受控图片" },
    read_grading_draft: { label: "读取批改草稿", summary: "查看当前批改草稿及版本" },
    submit_grading_draft: { label: "更新批改草稿", summary: "提交结构化评分判断并由程序校验" },
    get_knowledge_root: { label: "查看课程资料范围", summary: "确认当前课程已发布资料范围" },
    list_knowledge_directory: { label: "浏览课程资料", summary: "浏览当前课程资料目录" },
    search_knowledge: { label: "搜索课程资料", summary: "搜索相关课程资料" },
    read_knowledge_lines: { label: "阅读课程资料", summary: "读取课程资料片段" },
    web_search: { label: "搜索互联网", summary: "搜索公开网络资料" },
    read_web_result: { label: "阅读网页内容", summary: "阅读本轮已搜索的网页" },
    ask_grading_question: { label: "向教师确认", summary: "请求教师确认关键评分歧义" },
    set_submission_title: { label: "命名学生作业", summary: "保存当前作业的识别名称" },
  };
  return fixed[name];
}

function imageMime(assetPath: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  const extension = assetPath.toLowerCase().split(".").at(-1);
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}
