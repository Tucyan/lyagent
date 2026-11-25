// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GradingPage } from "../web/src/pages/GradingPage.js";

function session(id: string, score: number, reason: string, version = 1) {
  return {
    id, title: id, assignmentId: "assignment", rubricVersion: 1,
    studentName: id, studentNumber: id, conversionStatus: "ready", gradingStatus: "needs_review",
    submissionTitleStatus: "ready", submissionTitle: "模拟报告",
    submission: { markdown: "# 模拟作业正文", locked: true },
    rubric: { criteria: [{ id: "criteria-one", name: "实验过程" }] },
    confirmed: null, conversation: { messages: [] },
    draft: {
      version,
      result: {
        score: { earned: score, possible: 10 },
        confidence: { overall: 0.9, minimum: 0.9, lowConfidenceCount: 0 },
        review: { requiresReview: true, reasons: [] },
        decisions: { criteria: [{
          criterionId: "criteria-one", score, reason, confidence: 0.9,
          evidence: [{ kind: "analysis", observation: "保留了实验过程", rubricBasis: "过程完整", scoreJustification: "保留两分改进空间" }],
        }] },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function mount(options: { confirmFirst?: Promise<Response>; revisedState?: "draft" | "confirmed" } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/grading?session=first");
  let first = options.revisedState ? session("first", 6, "教师核对后调整为六分", 2) : session("first", 8, "原评分理由");
  const second = session("second", 9, "另一份报告的理由");
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") {
      return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    }
    if (url.startsWith("/api/grading/sessions?")) return Response.json([first, second]);
    if (url === "/api/grading/sessions/first") {
      return Response.json(options.revisedState === "confirmed" ? {
        ...first, gradingStatus: "confirmed", confirmed: { ...first.draft, resultHash: "a".repeat(64) },
      } : first);
    }
    if (url === "/api/grading/sessions/second") return Response.json(second);
    if (url === "/api/grading/sessions/first/confirm" && init?.method === "POST" && options.confirmFirst) return options.confirmFirst;
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));
  return {
    fetchMock,
    refreshFirstAsNewVersion: async () => {
      first = session("first", 6, "新版本理由", 2);
      await act(async () => {
        window.history.pushState(null, "", "/grading?session=first&rubric=assignment%3A1");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    },
  };
}

async function clickButton(text: string) {
  const button = [...container.querySelectorAll("button")]
    .find((item) => item.textContent?.trim() === text && !item.closest("[hidden]"));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function editorFields() {
  return {
    score: container.querySelector<HTMLInputElement>(".decision-editor input[type='number']"),
    reason: container.querySelector<HTMLTextAreaElement>(".decision-editor textarea"),
    note: container.querySelector<HTMLTextAreaElement>(".confirm-panel textarea"),
  };
}

async function typeValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function editDraft() {
  await clickButton("人工修订评分项");
  const fields = editorFields();
  for (const [field, value] of [[fields.score, "7"], [fields.reason, "人工修订理由"], [fields.note, "人工修订备注"]] as const) {
    await typeValue(field!, value);
  }
  expect(editorFields().score?.value).toBe("7");
  expect(editorFields().reason?.value).toBe("人工修订理由");
  expect(editorFields().note?.value).toBe("人工修订备注");
}

it("keeps the open editor and unsaved score, reason, and note across preview tabs", async () => {
  await mount();
  await editDraft();
  await clickButton("学生作业");
  expect(container.querySelector(".submission-document")?.textContent).toContain("模拟作业正文");
  expect([...container.querySelectorAll("button")].some((button) =>
    button.textContent?.trim() === "保存结构化修订" && !button.closest("[hidden]"),
  )).toBe(false);

  await clickButton("评分结果");
  expect(editorFields().score?.value).toBe("7");
  expect(editorFields().reason?.value).toBe("人工修订理由");
  expect(editorFields().note?.value).toBe("人工修订备注");
});

it("discards explicitly cancelled edits even after preview tab changes", async () => {
  await mount();
  await editDraft();
  await clickButton("取消修订");
  await clickButton("学生作业");
  await clickButton("评分结果");
  await clickButton("人工修订评分项");
  expect(editorFields().score?.value).toBe("8");
  expect(editorFields().reason?.value).toBe("原评分理由");
  expect(editorFields().note?.value).toBe("");
});

it("starts from the new session's saved decisions even when its draft version matches", async () => {
  await mount();
  await editDraft();
  await act(async () => container.querySelector<HTMLAnchorElement>("a[href='/grading?session=second']")!.click());
  await clickButton("人工修订评分项");
  expect(editorFields().score?.value).toBe("9");
  expect(editorFields().reason?.value).toBe("另一份报告的理由");
  expect(editorFields().note?.value).toBe("");
});

it("starts over from a new saved draft version in the same session", async () => {
  const { refreshFirstAsNewVersion } = await mount();
  await editDraft();
  await refreshFirstAsNewVersion();
  await clickButton("人工修订评分项");
  expect(editorFields().score?.value).toBe("6");
  expect(editorFields().reason?.value).toBe("新版本理由");
  expect(editorFields().note?.value).toBe("");
});

it("isolates confirmation notes while an earlier session's confirmation request is pending", async () => {
  let resolveFirst!: (response: Response) => void;
  const pendingConfirm = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const { fetchMock } = await mount({ confirmFirst: pendingConfirm });
  const firstNote = "第一份作业的复核备注";
  await typeValue(editorFields().note!, firstNote);
  await clickButton("确认并发布正式结果");
  expect(fetchMock).toHaveBeenCalledWith("/api/grading/sessions/first/confirm", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ expectedVersion: 1, reviewNote: firstNote, acknowledgedReasons: [] }),
  }));

  await act(async () => container.querySelector<HTMLAnchorElement>("a[href='/grading?session=second']")!.click());
  expect(editorFields().note?.value).toBe("");
  const secondNote = "第二份作业的复核备注";
  await typeValue(editorFields().note!, secondNote);
  await act(async () => resolveFirst(Response.json({})));
  expect(editorFields().note?.value).toBe(secondNote);
});

it.each(["draft", "confirmed"] as const)("distinguishes a %s revision reason from the draft analysis", async (revisedState) => {
  await mount({ revisedState });
  const decision = container.querySelector(".decision-list article");
  expect(decision?.textContent).toContain("6 分");
  expect(decision?.textContent).toContain("当前评分理由：教师核对后调整为六分");
  expect(decision?.querySelector("summary")?.textContent).toContain("评分草稿分析");
  expect(decision?.querySelector("details")?.textContent).toContain("草稿分值理由：保留两分改进空间");
});
