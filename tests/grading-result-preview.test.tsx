// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GradingPage } from "../web/src/pages/GradingPage.js";
import { AnnotatedSubmissionViewer } from "../web/src/components/grading/AnnotatedSubmissionViewer.js";

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

it.each(["draft", "confirmed"] as const)("progressively discloses breakdown, citation/analysis layers, and distinguishes a %s revision reason", async (revisedState) => {
  await mount({ revisedState });
  const resultPane = container.querySelector(".grading-result");
  expect(resultPane).toBeTruthy();
  expect(resultPane!.textContent).toContain("6/10");
  expect(resultPane!.textContent).toContain("90%");

  const breakdown = resultPane!.querySelector<HTMLDetailsElement>("details.grading-breakdown-disclosure");
  expect(breakdown).toBeTruthy();
  expect(breakdown!.open).toBe(false);

  await act(async () => {
    breakdown!.querySelector("summary")!.click();
  });
  expect(breakdown!.open).toBe(true);

  const decision = breakdown!.querySelector(".decision-list article");
  expect(decision?.textContent).toContain("6 分");

  const itemDetails = decision?.querySelector<HTMLDetailsElement>("details.decision-item-details");
  expect(itemDetails).toBeTruthy();
  expect(itemDetails!.open).toBe(false);

  await act(async () => {
    itemDetails!.querySelector("summary")!.click();
  });
  expect(itemDetails!.open).toBe(true);
  expect(itemDetails?.textContent).toContain("当前评分理由：教师核对后调整为六分");

  const analysisDetails = itemDetails!.querySelector<HTMLDetailsElement>("details.decision-sub-details");
  expect(analysisDetails).toBeTruthy();
  expect(analysisDetails!.open).toBe(false);
  expect(analysisDetails!.querySelector("summary")?.textContent).toContain("Agent 分析");

  await act(async () => {
    analysisDetails!.querySelector("summary")!.click();
  });
  expect(analysisDetails!.open).toBe(true);
  expect(analysisDetails!.textContent).toContain("草稿分值理由：保留两分改进空间");
});

it("collapses optional review note by default when requiresReview is false while keeping confirm primary action visible", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/grading?session=first");
  const cleanSession = session("first", 10, "全部达标");
  cleanSession.draft.result.review = { requiresReview: false, reasons: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    if (url.startsWith("/api/grading/sessions?")) return Response.json([cleanSession]);
    if (url === "/api/grading/sessions/first") return Response.json(cleanSession);
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));

  expect(container.querySelector(".confirm-panel textarea")).toBeNull();
  const confirmButton = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "确认并发布正式结果");
  expect(confirmButton).toBeDefined();
  expect(confirmButton!.disabled).toBe(false);

  const toggleNoteBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("添加复核备注（可选）"));
  expect(toggleNoteBtn).toBeDefined();
  await act(async () => toggleNoteBtn!.click());
  expect(container.querySelector(".confirm-panel textarea")).toBeTruthy();
});

it("shows student submission and grading result side by side in dual-pane fullscreen while preserving edits", async () => {
  await mount();
  await editDraft();

  const fullscreenBtn = [...container.querySelectorAll("button")]
    .find((btn) => btn.textContent?.trim() === "双栏全屏" || btn.textContent?.trim() === "全屏");
  expect(fullscreenBtn).toBeDefined();
  await act(async () => fullscreenBtn!.click());

  const preview = container.querySelector(".grading-preview.fullscreen");
  expect(preview).toBeTruthy();
  const split = preview!.querySelector(".grading-fullscreen-split");
  expect(split).toBeTruthy();
  expect(split!.querySelector(".submission-document")?.textContent).toContain("模拟作业正文");
  const resultContainer = split!.querySelector(".grading-result")?.closest("[hidden]");
  expect(resultContainer).toBeNull();
  expect(editorFields().score?.value).toBe("7");
  expect(editorFields().note?.value).toBe("人工修订备注");

  await clickButton("退出全屏");
  expect(container.querySelector(".grading-preview.fullscreen")).toBeNull();
  expect(editorFields().score?.value).toBe("7");
  expect(editorFields().note?.value).toBe("人工修订备注");
});

it("supports annotation mode where clicking evidence on the right jumps and highlights lines on the left", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  window.history.replaceState(null, "", "/grading?session=first");
  const annotatedSession = session("first", 8, "实验过程描述清晰");
  annotatedSession.submission = { markdown: "# 模拟作业正文\n\n第一段引言\n\n这里**完成了对照组实验**并记录了数据。", locked: true };
  annotatedSession.draft.result.decisions.criteria[0]!.evidence = [
    { kind: "text", path: "submission.md", heading: "实验", startLine: 5, endLine: 5, quote: "完成了对照组实验" } as never,
    { kind: "analysis", observation: "保留了实验过程", rubricBasis: "过程完整", scoreJustification: "给出八分" },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/courses") return Response.json([]);
    if (url === "/api/grading/rubrics") return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
    if (url.startsWith("/api/grading/sessions?")) return Response.json([annotatedSession]);
    if (url === "/api/grading/sessions/first") return Response.json(annotatedSession);
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));

  await clickButton("批注模式");
  expect(container.querySelector(".grading-preview.fullscreen")).toBeTruthy();
  const viewer = container.querySelector(".annotated-submission");
  expect(viewer).toBeTruthy();
  expect(viewer!.querySelector("h1")?.textContent).toBe("模拟作业正文");
  expect(viewer!.querySelector("strong")?.textContent).toBe("完成了对照组实验");

  const targetBlock = viewer!.querySelector<HTMLElement>("[data-line='5']");
  expect(targetBlock).toBeTruthy();
  const scrollSpy = vi.fn();
  targetBlock!.scrollIntoView = scrollSpy;

  const evidenceBtn = container.querySelector<HTMLButtonElement>("button.grading-evidence.is-clickable");
  expect(evidenceBtn).toBeTruthy();
  expect(evidenceBtn!.textContent).toContain("完成了对照组实验");

  await act(async () => evidenceBtn!.click());
  expect(targetBlock!.classList.contains("is-highlighted")).toBe(true);
  expect(viewer!.querySelector("[data-line='3']")?.classList.contains("is-highlighted")).toBe(false);
  expect(scrollSpy).toHaveBeenCalled();
});

it.each(["assets/图表.png", "assets/图表%20.png"])("renders and highlights the original image asset %s", async (assetPath) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(AnnotatedSubmissionViewer, {
    sessionId: "first",
    markdown: `![评分插图](${assetPath})`,
    activeTarget: { kind: "image", path: assetPath, itemLabel: "实验数据", key: "chart", explanation: "对照组", nonce: 1 },
  })));

  const img = container.querySelector("img");
  expect(img?.getAttribute("src")).toBe(`/api/grading/sessions/first/assets/${encodeURIComponent(assetPath.slice("assets/".length))}`);
  expect(img?.classList.contains("is-highlighted")).toBe(true);
});

it("supports quick-fill review notes and jump-to-edit on a specific decision item", async () => {
  await mount();

  // Quick-fill review note chip fills the required review note
  const noteChip = container.querySelector<HTMLButtonElement>(".grading-quick-note-chips button");
  expect(noteChip).toBeTruthy();
  await act(async () => noteChip!.click());
  expect(editorFields().note?.value.trim().length).toBeGreaterThan(0);

  // Open breakdown and click 调整此项 -> opens DecisionEditor focused on that item
  const breakdown = container.querySelector<HTMLDetailsElement>("details.grading-breakdown-disclosure")!;
  await act(async () => breakdown.querySelector("summary")!.click());
  const quickEditBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "调整此项");
  expect(quickEditBtn).toBeDefined();
  await act(async () => quickEditBtn!.click());

  expect(container.querySelector(".decision-editor article.is-jump-focused")).toBeTruthy();
});

it("distinguishes auto-confirmed from manually confirmed grading results and uses SVG icon actions on session cards", async () => {
  await mount({ revisedState: "confirmed" });
  const badge = container.querySelector(".confirmed-badge");
  expect(container.querySelector(".grading-status-pill")?.textContent).toBe("已人工确认");
  expect(badge?.textContent).toContain("成绩已人工确认并归档");
  expect(badge?.textContent).not.toContain("结果哈希");

  const renameBtn = container.querySelector<HTMLButtonElement>(".grading-session-actions button[aria-label='重命名']");
  const deleteBtn = container.querySelector<HTMLButtonElement>(".grading-session-actions button[aria-label='删除']");
  expect(renameBtn?.querySelector("svg")).toBeTruthy();
  expect(deleteBtn?.querySelector("svg")).toBeTruthy();
});

it("displays auto-confirmed pill, badge, and sidebar label and renders the NewSessionPanel auto-confirm checkbox", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>([["grading-auto-confirm", "true"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  window.history.replaceState(null, "", "/grading?session=first");
  const autoSession = {
    ...session("first", 10, "高置信达标"),
    gradingStatus: "confirmed",
    autoConfirmHighConfidence: true,
    confirmationMode: "auto" as const,
    confirmed: {
      ...session("first", 10, "高置信达标").draft,
      resultHash: "b".repeat(64),
      confirmationMode: "auto" as const,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/courses") return Response.json([]);
      if (url === "/api/grading/rubrics") {
        return Response.json([{ assignmentId: "assignment", title: "模拟评分表", version: 1 }]);
      }
      if (url.startsWith("/api/grading/sessions?")) return Response.json([autoSession]);
      if (url === "/api/grading/sessions/first") return Response.json(autoSession);
      throw new Error(`Unexpected API request: ${url}`);
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingPage)));

  expect(container.querySelector(".grading-status-pill.is-auto-confirmed")?.textContent).toBe("已自动确认");
  expect(container.querySelector(".confirmed-badge.is-auto-confirmed")?.textContent).toContain("成绩已自动确认并归档");
  expect(container.querySelector(".grading-workflow-tag.is-auto-confirmed")?.textContent).toContain("已自动确认");

  await clickButton("＋ 上传作业");
  const checkbox = container.querySelector<HTMLInputElement>("input[name='autoConfirmHighConfidence']");
  expect(checkbox).toBeTruthy();
  expect(checkbox!.checked).toBe(true);
  expect(container.textContent).toContain("高置信度结果自动复核确认");
  expect(container.textContent).toContain("整体置信度 ≥ 85%");
});
