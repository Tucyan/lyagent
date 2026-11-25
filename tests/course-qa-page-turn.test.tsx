// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CourseQaPage } from "../web/src/pages/CourseQaPage.js";
import { userErrorMessage } from "../src/schemas/user-feedback.js";

const sessionUrl = "/api/courses/course-one/qa/sessions/session-one";
const streamUrl = `${sessionUrl}/messages/stream`;
const previousTurn = [
  { role: "user", content: "已有问题" },
  { role: "assistant", content: "已有答案" },
];
let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function sse(runId: string) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } });
  return {
    response: new Response(body, { headers: { "x-agent-run-id": runId } }),
    finish(type: string, payload: Record<string, unknown> = {}) {
      stream.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
      stream.close();
    },
  };
}

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((complete) => { resolve = complete; });
  return { response, resolve };
}

async function mount(options: {
  getStream(): Promise<Response> | Response;
  onCancel?: (init: RequestInit) => Promise<Response> | Response;
  refreshSessions?: () => Promise<Response>;
  readFirstSession?: () => Promise<Response> | Response;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/qa?course=course-one&session=session-one");
  let sessionListRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/courses") return Response.json([{ id: "course-one", name: "合成课程" }]);
    if (url === "/api/system/model") return Response.json({ configured: true });
    if (url === "/api/courses/course-one/qa/active") return Response.json({ releaseId: "active", documents: [] });
    if (url === "/api/courses/course-one/qa/sessions") {
      if (sessionListRequests++ > 0 && options.refreshSessions) return options.refreshSessions();
      return Response.json([{ id: "session-one", summary: "已有会话" }, { id: "session-two", summary: "另一会话" }]);
    }
    if (url === sessionUrl) return options.readFirstSession?.() ?? Response.json({ id: "session-one", releaseId: "active", messages: previousTurn });
    if (url === "/api/courses/course-one/qa/sessions/session-two") return Response.json({ id: "session-two", releaseId: "active", messages: [] });
    if (url === streamUrl && init?.method === "POST") return options.getStream();
    if (url.startsWith("/api/agent-runs/") && init?.method === "POST" && options.onCancel) return options.onCancel(init);
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(CourseQaPage)));
  return fetchMock;
}

const input = () => container.querySelector<HTMLTextAreaElement>("textarea[aria-label='课程问题']")!;
const notice = () => container.querySelector(".qa-header small")?.textContent;
const conversation = () => container.querySelector(".message-list")?.textContent;

async function typeQuestion(question: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), question);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function button(text: string) {
  const target = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  expect(target).toBeDefined();
  await act(async () => target!.click());
}

it("stops the backend after its run ID arrives and restores the unsubmitted question without a disconnection error", async () => {
  const headers = pendingResponse();
  const stream = sse("run-one");
  const fetchMock = await mount({
    getStream: () => headers.response,
    onCancel: () => {
      stream.finish("cancelled");
      return Response.json({ cancelled: true });
    },
  });
  await typeQuestion("需要停止的问题");
  await button("发送");
  await button("停止生成");
  const request = fetchMock.mock.calls.find(([url]) => url === streamUrl)?.[1];
  expect(request?.signal?.aborted).toBe(false);
  expect(fetchMock).not.toHaveBeenCalledWith("/api/agent-runs/run-one/cancel", expect.anything());

  await act(async () => headers.resolve(stream.response));
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-runs/run-one/cancel", expect.objectContaining({ method: "POST" }));
  expect(notice()).toContain("已停止，未保存本轮回答");
  expect(notice()).not.toContain("连接已中断");
  expect(input().value).toBe("需要停止的问题");
  expect(conversation()).toContain("已有答案");
  expect(conversation()).not.toContain("需要停止的问题");
});

it("restores the question after a real service error and preserves existing conversation history", async () => {
  const stream = sse("run-one");
  await mount({ getStream: () => stream.response });
  await typeQuestion("需要重試的問題");
  await button("发送");
  await act(async () => stream.finish("error", { code: "AGENT_TIMEOUT", message: "local provider private detail" }));

  expect(notice()).toBe(userErrorMessage("AGENT_TIMEOUT"));
  expect(input().value).toBe("需要重試的問題");
  expect(conversation()).toContain("已有问题");
  expect(conversation()).toContain("已有答案");
  expect(conversation()).not.toContain("需要重試的問題");
});

it("disconnects the old browser stream on session switch without sending a backend stop or changing the new input", async () => {
  const headers = pendingResponse();
  const stream = sse("run-one");
  const fetchMock = await mount({ getStream: () => headers.response });
  await typeQuestion("旧会话的问题");
  await button("发送");
  await button("另一会话");
  await typeQuestion("新会话中编辑的内容");
  await act(async () => {
    headers.resolve(stream.response);
    stream.finish("error", { code: "QA_FAILED" });
  });

  const request = fetchMock.mock.calls.find(([url]) => url === streamUrl)?.[1];
  expect(request?.signal?.aborted).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/cancel"))).toBe(false);
  expect(input().value).toBe("新会话中编辑的内容");
  expect(conversation()).not.toContain("旧会话的问题");
});

it("allows another stop attempt after a bounded cancellation timeout without interrupting the answer stream", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = sse("run-one");
  let cancelAttempts = 0;
  const fetchMock = await mount({
    getStream: () => stream.response,
    onCancel: (init) => {
      if (++cancelAttempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
        });
      }
      stream.finish("cancelled");
      return Response.json({ cancelled: true });
    },
  });
  await typeQuestion("等待停止的原问题");
  await button("发送");
  await button("停止生成");
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

  expect(notice()).toContain("停止请求超时");
  expect(fetchMock.mock.calls.find(([url]) => url === streamUrl)?.[1]?.signal?.aborted).toBe(false);
  await button("停止生成");
  expect(cancelAttempts).toBe(2);
  expect(notice()).toContain("已停止，未保存本轮回答");
  expect(input().value).toBe("等待停止的原问题");
});

it.each([404, 503])("ignores a late cancel response %s after the final answer while the sidebar is pending", async (status) => {
  const stream = sse("run-one");
  const cancelling = pendingResponse();
  const sidebar = pendingResponse();
  await mount({ getStream: () => stream.response, onCancel: () => cancelling.response, refreshSessions: () => sidebar.response });
  await typeQuestion("即将完成的问题");
  await button("发送");
  await button("停止生成");
  await act(async () => stream.finish("final", { answer: "已正常完成的回答" }));
  const finalNotice = notice();
  expect(conversation()).toContain("已正常完成的回答");

  await act(async () => cancelling.resolve(Response.json({ cancelled: false }, { status })));
  expect(notice()).toBe(finalNotice);
  expect(input().value).toBe("");
  await act(async () => sidebar.resolve(Response.json([])));
});

it("recovers a running answer after returning to its conversation and stops polling once the full turn is saved", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const firstStream = pendingResponse();
  let answerInProgress = false;
  const completedTurn = [{ role: "user", content: "后台继续的问题" }, { role: "assistant", content: "后台已保存回答" }];
  let savedMessages = previousTurn;
  const fetchMock = await mount({
    getStream: () => firstStream.response,
    readFirstSession: () => Response.json({ id: "session-one", releaseId: "active", answerInProgress, messages: savedMessages }),
  });
  await typeQuestion("后台继续的问题");
  await button("发送");
  answerInProgress = true;
  await button("另一会话");
  await typeQuestion("未提交的新问题草稿");
  await button("已有会话");
  expect(notice()).toContain("后台仍在生成");
  expect(input().disabled).toBe(true);
  await button("发送");
  expect(fetchMock.mock.calls.filter(([url]) => url === streamUrl)).toHaveLength(1);

  savedMessages = [...previousTurn, ...completedTurn];
  answerInProgress = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(conversation()).toContain("已有答案");
  expect(conversation()).toContain("后台已保存回答");
  expect(input().disabled).toBe(false);
  expect(input().value).toBe("未提交的新问题草稿");
  const reads = fetchMock.mock.calls.filter(([url]) => url === sessionUrl).length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(fetchMock.mock.calls.filter(([url]) => url === sessionUrl)).toHaveLength(reads);
});

it("ignores a pending recovery response when the learner switches conversations", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const recovering = pendingResponse();
  let reads = 0;
  await mount({
    getStream: () => { throw new Error("Recovery must not send a question"); },
    readFirstSession: () => ++reads === 1
      ? Response.json({ id: "session-one", releaseId: "active", answerInProgress: true, messages: previousTurn })
      : recovering.response,
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(reads).toBe(2);
  await button("另一会话");
  await typeQuestion("新会话的草稿");
  await act(async () => recovering.resolve(Response.json({
    id: "session-one", releaseId: "active", answerInProgress: true, messages: previousTurn,
  })));

  expect(input().disabled).toBe(false);
  expect(input().value).toBe("新会话的草稿");
  expect(conversation()).not.toContain("已有答案");
  expect(notice()).not.toContain("后台仍在生成");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(reads).toBe(2);
});

it("stops recovery and exits a conversation deleted elsewhere", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let reads = 0;
  await mount({
    getStream: () => { throw new Error("Recovery must not send a question"); },
    readFirstSession: () => ++reads === 1
      ? Response.json({ id: "session-one", releaseId: "active", answerInProgress: true, messages: previousTurn })
      : Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 }),
  });
  expect(notice()).toContain("后台仍在生成");
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(notice()).toContain("答疑会话已不存在");
  expect(input().disabled).toBe(false);
  expect(new URLSearchParams(window.location.search).get("session")).toBeNull();
  expect(conversation()).not.toContain("已有答案");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(reads).toBe(2);
});

it("recovers from a temporary history read error without retaining the retry error after success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let reads = 0;
  await mount({
    getStream: () => { throw new Error("Recovery must not send a question"); },
    readFirstSession: () => {
      reads += 1;
      if (reads === 2) return Response.json({}, { status: 503 });
      return Response.json({ id: "session-one", releaseId: "active", answerInProgress: reads === 1, messages: previousTurn });
    },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(notice()).toContain("后台仍在生成");
  expect(input().disabled).toBe(true);

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(reads).toBe(3);
  expect(notice()).toContain("课程资料优先");
  expect(conversation()).toContain("已有答案");
  expect(input().disabled).toBe(false);
});
