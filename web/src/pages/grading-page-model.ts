import { userErrorMessage } from "../../../src/schemas/user-feedback.js";

type NamedGradingRules = {
  criteria?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  rules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  deductionRules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  bonusRules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  scoreCaps?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
};
export function gradingItemLabel(rubric: NamedGradingRules | undefined, id: string, index: number): string {
  const items = [...(rubric?.criteria ?? []), ...(rubric?.rules ?? []), ...(rubric?.deductionRules ?? []), ...(rubric?.bonusRules ?? []), ...(rubric?.scoreCaps ?? [])];
  return items.find(item => item.id === id)?.name.trim() || `评分项目 ${index + 1}`;
}

export function gradingConversationRequest(status: string, message: string): string {
  return status === "waiting_for_teacher"
    ? `这是对待确认评分问题的教师回答：${message}\n请依据此答复继续批改并提交评分草稿；仍缺少必要信息时请明确提问。`
    : message;
}

export function canAnswerGradingQuestion(status: string, runInProgress: boolean, messageIndex: number, lastMessageIndex: number): boolean {
  return status === "waiting_for_teacher" && !runInProgress && messageIndex === lastMessageIndex;
}

export interface GradingToolStep {
  id: string;
  name: string;
  label: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

export interface LiveGradingMessage {
  runId: string;
  content: string;
  process: string;
  tools: GradingToolStep[];
  complete: boolean;
  collapsed: boolean;
  options?: string[];
}

export {
  buildSingleGradingExportHref,
  defaultGradingExportOptions,
  exportPresetOptions,
  filterCsvPreviewRows,
  normalizeGradingExportOptions,
  parseCsvPreview,
  parseGradingExportOptions,
  serializeCsvTable,
  type CsvPreviewFilter,
  type CsvPreviewTable,
  type GradingExportOptions,
  type GradingExportPreset,
} from "./grading-export-page-model.js";

export function buildAssetManifest(
  files: Array<{ name: string; webkitRelativePath?: string }>,
): string[] {
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const seen = new Set<string>();
  for (const assetPath of paths) {
    const segments = assetPath.split("/");
    if (
      assetPath.includes("\\") ||
      segments.length < 2 ||
      segments[0] !== "assets" ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) throw new Error("请选择名为 assets 的附件目录");
    if (seen.has(assetPath)) throw new Error("附件存在重复路径，请保留每个附件的一份文件后重新选择目录。");
    seen.add(assetPath);
  }
  return paths;
}

export interface ConversionPresentationInput {
  conversionStatus: string;
  conversionError?: {
    code: string;
    message: string;
    retryable: boolean;
    nextRetryAt?: string;
  };
}

export interface ConversionPresentation {
  title: string;
  message: string;
  tone: "neutral" | "warning" | "danger";
  canRetry: boolean;
  canReupload: boolean;
}

export function conversionPresentation(
  input: ConversionPresentationInput,
): ConversionPresentation | undefined {
  if (input.conversionStatus === "ready") return undefined;
  if (input.conversionStatus === "waiting_for_converter")
    return {
      title: "等待转换服务",
      message:
        (input.conversionError?.code ? userErrorMessage(input.conversionError.code) : undefined) ??
        input.conversionError?.message ??
        "转换服务暂时不可用，原始作业已安全保存。",
      tone: "warning",
      canRetry: input.conversionError?.retryable === true,
      canReupload: true,
    };
  if (input.conversionStatus === "conversion_failed")
    return {
      title: input.conversionError?.retryable ? "转换已停止" : "作业文件无法转换",
      message:
        (input.conversionError?.code ? userErrorMessage(input.conversionError.code) : undefined) ??
        input.conversionError?.message ??
        "请检查文件是否损坏、加密或不受支持。",
      tone: "danger",
      canRetry: input.conversionError?.retryable === true,
      canReupload: true,
    };
  if (input.conversionStatus === "result_rejected")
    return {
      title: "转换结果已被拒绝",
      message:
        (input.conversionError?.code ? userErrorMessage(input.conversionError.code) : undefined) ??
        input.conversionError?.message ?? "转换结果未通过安全或格式校验。",
      tone: "danger",
      canRetry: false,
      canReupload: true,
    };
  return {
    title:
      input.conversionStatus === "queued" ? "等待开始转换" : "正在转换作业",
    message: "原始作业已安全保存，转换完成前不会开始评分。",
    tone: "neutral",
    canRetry: false,
    canReupload: false,
  };
}


export function gradingStatusLabel(status: string): string {
  const map: Record<string, string> = {
    not_started: "未开始批改",
    queued: "排队批改",
    running: "批改中",
    waiting_for_teacher: "待教师回答",
    draft_ready: "已有草稿",
    needs_review: "待复核",
    confirmed: "成绩已确认",
    failed: "批改未完成",
    cancelled: "批改已停止",
    idle: "待批改",
    completed: "已完成",
    draft: "已有草稿",
  };
  return map[status] ?? status;
}

export function gradingSessionWorkflowSummary(input: {
  conversionStatus: string;
  gradingStatus: string;
}): string {
  const convMap: Record<string, string> = {
    ready: "转换完成",
    queued: "排队转换",
    running: "正在转换",
    converting: "正在转换",
    waiting_for_converter: "等待转换",
    conversion_failed: "转换失败",
    result_rejected: "转换被拒",
  };
  const cText = convMap[input.conversionStatus] ?? input.conversionStatus;
  const gText = gradingStatusLabel(input.gradingStatus);
  return `${cText} · ${gText}`;
}
export function shouldPollConversion(
  input: ConversionPresentationInput,
): boolean {
  return (
    input.conversionStatus === "queued" ||
    input.conversionStatus === "running" ||
    (input.conversionStatus === "waiting_for_converter" &&
      Boolean(input.conversionError?.nextRetryAt))
  );
}

export function rubricSelectionKey(rubric: {
  assignmentId: string;
  version: number;
}): string {
  return `${rubric.assignmentId}:${rubric.version}`;
}

export function resolveGradingRubricKey(
  rubrics: Array<{
    assignmentId: string;
    version: number;
    sessionCount?: number;
    confirmedCount?: number;
  }>,
  preferredKey: string,
): string {
  if (rubrics.some((rubric) => rubricSelectionKey(rubric) === preferredKey))
    return preferredKey;
  const preferred =
    rubrics.find((rubric) => (rubric.confirmedCount ?? 0) > 0) ??
    rubrics.find((rubric) => (rubric.sessionCount ?? 0) > 0) ??
    rubrics[0];
  return preferred ? rubricSelectionKey(preferred) : "";
}

export function resolveGradingSessionScope(
  currentSession: { assignmentId: string; rubricVersion: number } | undefined,
  rubrics: Array<{ assignmentId: string; version: number }>,
  selectedRubricKey: string,
): { assignmentId: string; version: number } | undefined {
  if (currentSession)
    return {
      assignmentId: currentSession.assignmentId,
      version: currentSession.rubricVersion,
    };
  return rubrics.find(
    (rubric) => rubricSelectionKey(rubric) === selectedRubricKey,
  );
}

export function shouldPollSessionPreparation(
  input: ConversionPresentationInput & { submissionTitleStatus: string },
): boolean {
  return (
    shouldPollConversion(input) ||
    (input.conversionStatus === "ready" &&
      ["pending", "resolving"].includes(input.submissionTitleStatus))
  );
}

export function gradingSessionStatusLabel(input: {
  conversionStatus: string;
  submissionTitleStatus: string;
}): "等待转换" | "正在转换" | "正在识别" | "识别失败" | "已就绪" {
  if (input.conversionStatus === "running" || input.conversionStatus === "converting") return "正在转换";
  if (input.conversionStatus !== "ready") return "等待转换";
  if (input.submissionTitleStatus === "failed") return "识别失败";
  if (["pending", "resolving"].includes(input.submissionTitleStatus))
    return "正在识别";
  return "已就绪";
}

export function submissionTitlePresentation(input: {
  status: string;
  retrying: boolean;
  title?: string;
  error?: { code: string; message: string };
}): {
  label: string;
  retryLabel: string;
  showRetry: boolean;
  retryDisabled: boolean;
  error?: { code: string; message: string };
} {
  if (input.title)
    return {
      label: input.title,
      retryLabel: "重试名称识别",
      showRetry: false,
      retryDisabled: false,
    };
  if (input.retrying)
    return {
      label: "正在识别…",
      retryLabel: "正在重试…",
      showRetry: true,
      retryDisabled: true,
    };
  const failed = input.status === "failed";
  return {
    label: failed ? "识别失败" : "正在识别…",
    retryLabel: "重试名称识别",
    showRetry: failed,
    retryDisabled: false,
    ...(failed && input.error ? { error: input.error } : {}),
  };
}

export function clampGradingPreviewPercent(value: number): number {
  return Math.min(62, Math.max(28, value));
}

export function initialLiveMessage(runId: string): LiveGradingMessage {
  return {
    runId,
    content: "",
    process: "",
    tools: [],
    complete: false,
    collapsed: false,
  };
}

export function applyGradingEvent(
  message: LiveGradingMessage,
  type: string,
  data: Record<string, unknown>,
): LiveGradingMessage {
  if (type === "process_delta" && typeof data.delta === "string")
    return { ...message, process: message.process + data.delta };
  if (type === "model_switch" && data.capability === "vision")
    return { ...message, process: `${message.process}${message.process ? "\n" : ""}已切换至视觉模型` };
  if (type === "reply_delta" && typeof data.delta === "string")
    return { ...message, content: message.content + data.delta };
  if (type === "tool_start" && typeof data.id === "string")
    return {
      ...message,
      tools: [
        ...message.tools.filter(({ id }) => id !== data.id),
        {
          id: data.id,
          name: String(data.name ?? ""),
          label: String(data.label ?? data.name ?? "工具调用"),
          summary: String(data.summary ?? ""),
          status: "running",
        },
      ],
    };
  if (type === "tool_end" && typeof data.id === "string")
    return {
      ...message,
      tools: message.tools.map((tool) =>
        tool.id === data.id
          ? {
              ...tool,
              label: String(data.label ?? tool.label),
              summary: String(data.summary ?? tool.summary),
              status: data.status === "failed" ? "failed" : "completed",
            }
          : tool,
      ),
    };
  if (type === "final")
    return {
      ...message,
      content: message.content || String(data.message ?? "批改运行已完成。"),
      complete: true,
      collapsed: true,
      ...(Array.isArray(data.options)
        ? { options: data.options.map(String) }
        : {}),
    };
  if (type === "error" || type === "cancelled")
    return {
      ...message,
      content: type === "cancelled" ? "运行已停止。请核对已保存的草稿，再决定是否重新批改。" : userErrorMessage(typeof data.code === "string" ? data.code : "GRADING_RUN_FAILED"),
      complete: true,
      collapsed: true,
    };
  return message;
}


export type GradingSessionFilterStatus = "all" | "pending" | "confirmed" | "attention";

export function countGradingSessionsByStatus<
  T extends {
    conversionStatus: string;
    gradingStatus: string;
  },
>(sessions: T[]): Record<GradingSessionFilterStatus, number> {
  const counts: Record<GradingSessionFilterStatus, number> = {
    all: sessions.length,
    pending: 0,
    confirmed: 0,
    attention: 0,
  };
  for (const session of sessions) {
    const isAttention =
      session.conversionStatus === "conversion_failed" ||
      session.gradingStatus === "failed";
    if (isAttention) counts.attention += 1;
    else if (session.gradingStatus === "confirmed") counts.confirmed += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function formatGradingSessionDisplayTitle(session: {
  title: string;
  studentName: string;
  studentNumber: string;
}): string {
  const raw = (session.title ?? "").trim();
  if (!raw) return `${session.studentName} · ${session.studentNumber}`;
  const escapedParts = [session.studentNumber, session.studentName]
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escapedParts.length === 0) return raw;
  const tokenPattern = new RegExp(`^(?:${escapedParts.join("|")})(?:[\\s·•/_:-]+|$)`, "u");
  let stripped = raw;
  for (let i = 0; i < 3; i += 1) {
    const next = stripped.replace(tokenPattern, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  return stripped || raw;
}

export function filterGradingSessions<
  T extends {
    studentName: string;
    studentNumber: string;
    title: string;
    conversionStatus: string;
    gradingStatus: string;
  },
>(sessions: T[], status: GradingSessionFilterStatus, query: string): T[] {
  const normalized = query.trim().toLowerCase();
  return sessions.filter((session) => {
    const isAttention =
      session.conversionStatus === "conversion_failed" ||
      session.gradingStatus === "failed";
    const isConfirmed = session.gradingStatus === "confirmed";
    if (status === "confirmed" && !isConfirmed) return false;
    if (status === "attention" && !isAttention) return false;
    if (status === "pending" && (isConfirmed || isAttention)) return false;
    if (!normalized) return true;
    return `${session.studentName} ${session.studentNumber} ${session.title}`
      .toLowerCase()
      .includes(normalized);
  });
}
