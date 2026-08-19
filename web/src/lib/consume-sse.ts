export interface SseConsumptionResult {
  terminalEvent?: "final" | "error" | "cancelled";
}

const terminalEvents = new Set(["final", "error", "cancelled"]);

export async function consumeSse(response: Response, onEvent: (event: string, data: unknown) => void): Promise<SseConsumptionResult> {
  if (!response.body) throw new Error("流式响应不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEvent: SseConsumptionResult["terminalEvent"];
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (event && data) {
        const parsed = JSON.parse(data) as unknown;
        const dataType = typeof parsed === "object" && parsed !== null &&
          typeof (parsed as { type?: unknown }).type === "string"
          ? (parsed as { type: string }).type
          : undefined;
        const terminal = terminalEvents.has(event)
          ? event
          : dataType && terminalEvents.has(dataType)
            ? dataType
            : undefined;
        if (terminal) terminalEvent = terminal as SseConsumptionResult["terminalEvent"];
        onEvent(event, parsed);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return { ...(terminalEvent ? { terminalEvent } : {}) };
  }
}
