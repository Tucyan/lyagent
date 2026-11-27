import { describe, expect, it } from "vitest";
import { consumeStudentQaStream } from "../web-student/src/lib/qa-stream.js";
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

it("distinguishes a named final frame from a stream ending after a delta", async () => {
  const body = 'event: final\ndata: {"answer":{"answer":"完成"}}\n\n';
  await expect(consumeSse(new Response(body), () => undefined)).resolves.toEqual({ terminalEvent: "final" });
  await expect(consumeSse(new Response('event: answer_delta\ndata: {"delta":"未完成"}\n\n'), () => undefined)).resolves.toEqual({});
});

it("reconciles on a transport error after receiving partial answer data", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: answer_delta\ndata: {"delta":"partial"}\n\n'));
    },
    pull(controller) {
      controller.error(new TypeError("connection reset"));
    },
  });
  const events: string[] = [];
  const saved = { message: "already persisted", quotaUsed: 1 };
  let restored: typeof saved | undefined;
  const result = await consumeStudentQaStream(new Response(body), (event) => events.push(event), async () => { restored = saved; });
  expect(events).toEqual(["answer_delta"]);
  expect(result).toEqual({});
  expect(restored).toBe(saved);
});

it("keeps a received terminal outcome if the transport then fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: final\ndata: {"answer":{"answer":"saved"}}\n\n'));
    },
    pull(controller) {
      controller.error(new TypeError("connection reset"));
    },
  });
  let recovered = false;
  const result = await consumeStudentQaStream(new Response(body), () => undefined, async () => { recovered = true; });
  expect(result.terminalEvent).toBe("final");
  expect(recovered).toBe(false);
});
