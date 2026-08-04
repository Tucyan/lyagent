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

export function clampGradingPreviewPercent(value: number): number {
  return Math.min(62, Math.max(28, value));
}

export function initialLiveMessage(runId: string): LiveGradingMessage {
  return { runId, content: "", process: "", tools: [], complete: false, collapsed: false };
}

export function applyGradingEvent(message: LiveGradingMessage, type: string, data: Record<string, unknown>): LiveGradingMessage {
  if (type === "process_delta" && typeof data.delta === "string") return { ...message, process: message.process + data.delta };
  if (type === "reply_delta" && typeof data.delta === "string") return { ...message, content: message.content + data.delta };
  if (type === "tool_start" && typeof data.id === "string") return {
    ...message,
    tools: [...message.tools.filter(({ id }) => id !== data.id), { id: data.id, name: String(data.name ?? ""), label: String(data.label ?? data.name ?? "工具调用"), summary: String(data.summary ?? ""), status: "running" }],
  };
  if (type === "tool_end" && typeof data.id === "string") return {
    ...message,
    tools: message.tools.map((tool) => tool.id === data.id ? { ...tool, label: String(data.label ?? tool.label), summary: String(data.summary ?? tool.summary), status: data.status === "failed" ? "failed" : "completed" } : tool),
  };
  if (type === "final") return {
    ...message,
    content: message.content || String(data.message ?? "批改运行已完成。"),
    complete: true,
    collapsed: true,
    ...(Array.isArray(data.options) ? { options: data.options.map(String) } : {}),
  };
  if (type === "error" || type === "cancelled") return { ...message, content: String(data.message ?? "运行已停止。"), complete: true, collapsed: true };
  return message;
}
