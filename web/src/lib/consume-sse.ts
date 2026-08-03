export async function consumeSse(response: Response, onEvent: (event: string, data: unknown) => void): Promise<void> {
  if (!response.body) throw new Error("流式响应不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return;
  }
}
