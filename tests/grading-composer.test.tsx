// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GradingPage } from "../web/src/pages/GradingPage.js";

let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

async function mount(batchId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/grading?session=test-session");
  const session = {
    id: "test-session", assignmentId: "assignment", rubricVersion: 1,
    studentName: "模拟学生", studentNumber: "20260001", conversionStatus: "ready",
    gradingStatus: "needs_review", submissionTitleStatus: "ready", submissionTitle: "模拟报告",
    submission: { markdown: "# 模拟报告", locked: true }, rubric: {}, draft: null,
    confirmed: null, conversation: { messages: [] }, ...(batchId ? { owningBatchId: batchId } : {}),
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return new Promise<Response>(() => undefined);
    const value = url === "/api/grading/rubrics"
      ? [{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]
      : url.includes("sessions?") ? [session] : session;
    return { ok: true, json: async () => value } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));
  return fetchMock;
}

async function typeMessage(text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".grading-composer textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

it("shows the owning batch and prevents an impossible direct send", async () => {
  const fetchMock = await mount("batch-one");
  expect(container.textContent).toContain("此会话属于批量批改");
  const link = container.querySelector<HTMLAnchorElement>('.grading-composer a');
  expect(link?.getAttribute("href")).toBe("/grading/batches/review?batch=batch-one&session=test-session");
  expect(container.querySelector('.grading-composer textarea')).toBeNull();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("sends with Ctrl+Enter but keeps Enter and IME confirmation from sending", async () => {
  const fetchMock = await mount();
  const textarea = await typeMessage("请解释评分依据");
  expect(container.querySelector<HTMLButtonElement>('.grading-composer button')?.disabled).toBe(false);
  for (const options of [{ key: "Enter" }, { key: "Enter", ctrlKey: true, isComposing: true }]) {
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options })));
  }
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(container.textContent).toContain("Ctrl");
});
