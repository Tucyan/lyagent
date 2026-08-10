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

export interface GradingExportOptions {
  studentName: boolean;
  studentNumber: boolean;
  submissionTitle: boolean;
  itemDetails: boolean;
  itemConfidence: boolean;
  totalScore: boolean;
  overallConfidence: boolean;
}

export const defaultGradingExportOptions: GradingExportOptions = {
  studentName: true,
  studentNumber: true,
  submissionTitle: true,
  itemDetails: true,
  itemConfidence: false,
  totalScore: true,
  overallConfidence: true,
};

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
    if (seen.has(assetPath)) throw new Error("duplicate asset path");
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
        input.conversionError?.message ??
        "转换服务暂时不可用，原始作业已安全保存。",
      tone: "warning",
      canRetry: input.conversionError?.retryable === true,
      canReupload: true,
    };
  if (input.conversionStatus === "conversion_failed")
    return {
      title: "作业文件无法转换",
      message:
        input.conversionError?.message ??
        "请检查文件是否损坏、加密或不受支持。",
      tone: "danger",
      canRetry: false,
      canReupload: true,
    };
  if (input.conversionStatus === "result_rejected")
    return {
      title: "转换结果已被拒绝",
      message:
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
  rubrics: Array<{ assignmentId: string; version: number }>,
  preferredKey: string,
): string {
  if (rubrics.some((rubric) => rubricSelectionKey(rubric) === preferredKey))
    return preferredKey;
  return rubrics[0] ? rubricSelectionKey(rubrics[0]) : "";
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
}): "等待转换" | "正在识别" | "识别失败" | "已就绪" {
  if (input.conversionStatus !== "ready") return "等待转换";
  if (input.submissionTitleStatus === "failed") return "识别失败";
  if (["pending", "resolving"].includes(input.submissionTitleStatus))
    return "正在识别";
  return "已就绪";
}

export function normalizeGradingExportOptions(
  value: Partial<GradingExportOptions>,
): GradingExportOptions {
  const normalized = {
    ...defaultGradingExportOptions,
    ...Object.fromEntries(
      Object.entries(value).map(([key, selected]) => [key, selected === true]),
    ),
  } as GradingExportOptions;
  if (!normalized.itemDetails) normalized.itemConfidence = false;
  return normalized;
}

export function parseGradingExportOptions(
  value: string | null,
): GradingExportOptions {
  if (!value) return { ...defaultGradingExportOptions };
  try {
    return normalizeGradingExportOptions(
      JSON.parse(value) as Partial<GradingExportOptions>,
    );
  } catch {
    return { ...defaultGradingExportOptions };
  }
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
      content: String(data.message ?? "运行已停止。"),
      complete: true,
      collapsed: true,
    };
  return message;
}
