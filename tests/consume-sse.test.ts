import { describe, expect, it } from "vitest";
import { consumeSse } from "../web/src/lib/consume-sse.js";

describe("consumeSse", () => {
  it("buffers split SSE frames and forwards parsed events in order", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: tool_start\ndata: {\"type\":\"tool_start\",\"label\":\"搜索课程"));
        controller.enqueue(encoder.encode("资料\"}\n\nevent: answer_delta\ndata: {\"type\":\"answer_delta\",\"delta\":\"你好\"}\n\n"));
        controller.close();
      },
    });
    const events: Array<{ event: string; data: { type: string; label?: string; delta?: string } }> = [];

    const result = await consumeSse(new Response(body), (event, data) => events.push({ event, data: data as { type: string; label?: string; delta?: string } }));

    expect(events).toEqual([
      { event: "tool_start", data: { type: "tool_start", label: "搜索课程资料" } },
      { event: "answer_delta", data: { type: "answer_delta", delta: "你好" } },
    ]);
    expect(result.terminalEvent).toBeUndefined();
  });

  it("reports a terminal event carried by the SSE data type", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message\ndata: {"type":"final","answer":"完成"}\n\n'));
        controller.close();
      },
    });

    const result = await consumeSse(new Response(body), () => undefined);

    expect(result.terminalEvent).toBe("final");
  });
});
