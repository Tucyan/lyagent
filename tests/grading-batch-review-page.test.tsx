// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingBatchReviewPage } from "../web/src/pages/GradingBatchReviewPage.js";

function makeBatch() {
  return {
    id: "batch-1",
    assignmentId: "assignment-1",
    rubricVersion: 1,
    title: "实验报告批次",
    status: "completed",
    counts: { total: 2, pending: 0, running: 0, waitingForTeacher: 0, completed: 2, failed: 0, cancelled: 0, needsReview: 1, confirmed: 0 },
    jobs: [
      {
        id: "job-1",
        sessionId: "session-1",
        studentName: "张三",
        studentNumber: "2026001",
        submissionTitle: "报告一",
        status: "completed",
        attemptCount: 1,
        maxAttempts: 3,
        resultVersion: 1,
        score: { earned: 16, possible: 20 },
        confidence: { overall: 0.82, minimum: 0.65, lowCount: 1 },
        reviewStatus: "needs_review" as const,
        reviewReasons: ["LOW_CONFIDENCE"],
      },
      {
        id: "job-2",
        sessionId: "session-2",
        studentName: "李四",
        studentNumber: "2026002",
        submissionTitle: "报告二",
        status: "completed",
        attemptCount: 1,
        maxAttempts: 3,
        resultVersion: 1,
        score: { earned: 19, possible: 20 },
        confidence: { overall: 0.96, minimum: 0.94, lowCount: 0 },
        reviewStatus: "needs_review" as const,
        reviewReasons: [],
      },
    ],
  };
}

function makeSession1() {
  return {
    id: "session-1",
    studentName: "张三",
    studentNumber: "2026001",
    submissionTitle: "报告一",
    submission: { markdown: "# 张三报告正文\n实现了核心流程。", locked: true },
    rubric: {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 20,
      partialCreditAllowed: true,
      criteria: [
        { id: "c1", name: "实验过程", description: "步骤完整", maxScore: 10, scorePolicy: "continuous", evidenceRequired: true },
        { id: "c2", name: "结论分析", description: "分析深刻", maxScore: 10, scorePolicy: "continuous", evidenceRequired: false },
      ],
    },
    confirmed: null,
    draft: {
      version: 1,
      result: {
        score: { earned: 16, possible: 20 },
        confidence: { overall: 0.82, minimum: 0.65, lowCount: 1 },
        review: { requiresReview: true, reasons: ["LOW_CONFIDENCE"] },
        decisions: {
          criteria: [
            {
              criterionId: "c1",
              score: 9,
              confidence: 0.95,
              reason: "实验步骤完整且可复现",
              evidence: [
                { kind: "text", path: "submission.md", heading: "正文", startLine: 2, endLine: 2, quote: "实现了核心流程。" },
                { kind: "analysis", observation: "步骤清晰", rubricBasis: "满足实验过程要求", scoreJustification: "给出 9 分" },
              ],
            },
            {
              criterionId: "c2",
              score: 7,
              confidence: 0.65,
              reason: "结论部分分析偏简略",
              evidence: [
                { kind: "analysis", observation: "仅两句总结", rubricBasis: "缺少对比讨论", scoreJustification: "酌情给 7 分" },
              ],
            },
          ],
          strengths: [],
          improvements: [],
          warnings: [],
        },
      },
    },
  };
}

function makeSession2() {
  return {
    id: "session-2",
    studentName: "李四",
    studentNumber: "2026002",
    submissionTitle: "报告二",
    submission: { markdown: "# 李四报告正文", locked: true },
    rubric: makeSession1().rubric,
    confirmed: null,
    draft: {
      version: 1,
      result: {
        score: { earned: 19, possible: 20 },
        confidence: { overall: 0.96, minimum: 0.94, lowCount: 0 },
        review: { requiresReview: false, reasons: [] },
        decisions: {
          criteria: [
            { criterionId: "c1", score: 10, confidence: 0.98, reason: "满分过程", evidence: [] },
            { criterionId: "c2", score: 9, confidence: 0.94, reason: "分析全面", evidence: [] },
          ],
          strengths: [],
          improvements: [],
          warnings: [],
        },
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

async function mountBatchReview() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/grading/batches/review?batch=batch-1&session=session-1");
  const batch = makeBatch();
  const s1 = makeSession1();
  const s2 = makeSession2();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/grading/batches/batch-1") return Response.json(batch);
    if (url === "/api/grading/sessions/session-1") return Response.json(s1);
    if (url === "/api/grading/sessions/session-2") return Response.json(s2);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(GradingBatchReviewPage)));
  return { fetchMock };
}

describe("GradingBatchReviewPage progressive disclosure", () => {
  it("shows summary, review checklist, required note, and confirm actions by default while collapsing breakdown details", async () => {
    await mountBatchReview();
    const resultPane = container.querySelector(".batch-review-result");
    expect(resultPane).toBeTruthy();
    expect(resultPane!.textContent).toContain("16/20");
    expect(resultPane!.textContent).toContain("82%");
    expect(resultPane!.textContent).toContain("需要教师复核并逐项确认");
    expect(resultPane!.textContent).toContain("修改评分结果");
    expect(resultPane!.textContent).toContain("确认并继续下一份");

    // Required note appears immediately inside review action block before breakdown
    const noteField = resultPane!.querySelector<HTMLTextAreaElement>(".batch-review-note textarea");
    expect(noteField).toBeTruthy();

    // Breakdown is collapsed by default
    const breakdown = resultPane!.querySelector<HTMLDetailsElement>("details.grading-breakdown-disclosure");
    expect(breakdown).toBeTruthy();
    expect(breakdown!.open).toBe(false);

    // Expand breakdown -> shows per-item score & confidence, while item reasons/evidence/analysis stay collapsed
    await act(async () => {
      breakdown!.querySelector("summary")!.click();
    });
    expect(breakdown!.open).toBe(true);
    const articles = [...breakdown!.querySelectorAll(".decision-list article")];
    expect(articles).toHaveLength(2);
    expect(articles[0]!.textContent).toContain("实验过程");
    expect(articles[0]!.textContent).toContain("9 分");

    const itemDetails = articles[0]!.querySelector<HTMLDetailsElement>("details.decision-item-details");
    expect(itemDetails).toBeTruthy();
    expect(itemDetails!.open).toBe(false);

    // Expand item 1 -> reveals reason and independent citation + agent analysis sub-disclosures
    await act(async () => {
      itemDetails!.querySelector("summary")!.click();
    });
    expect(itemDetails!.open).toBe(true);
    expect(itemDetails!.textContent).toContain("当前评分理由：实验步骤完整且可复现");

    const subDisclosures = [...itemDetails!.querySelectorAll<HTMLDetailsElement>("details.decision-sub-details")];
    expect(subDisclosures).toHaveLength(2);
    expect(subDisclosures[0]!.open).toBe(false);
    expect(subDisclosures[1]!.open).toBe(false);
    expect(subDisclosures[0]!.querySelector("summary")!.textContent).toContain("引用证据");
    expect(subDisclosures[1]!.querySelector("summary")!.textContent).toContain("Agent 分析");

    // Expand citation and analysis independently
    await act(async () => {
      subDisclosures[0]!.querySelector("summary")!.click();
    });
    expect(subDisclosures[0]!.open).toBe(true);
    expect(subDisclosures[1]!.open).toBe(false);
    expect(subDisclosures[0]!.textContent).toContain("实现了核心流程。");

    await act(async () => {
      subDisclosures[1]!.querySelector("summary")!.click();
    });
    expect(subDisclosures[1]!.open).toBe(true);
    expect(subDisclosures[1]!.textContent).toContain("满足实验过程要求");
  });

  it("opens DecisionEditor when editing and resets disclosure state when switching students", async () => {
    await mountBatchReview();

    const breakdown = container.querySelector<HTMLDetailsElement>("details.grading-breakdown-disclosure")!;
    await act(async () => {
      breakdown.querySelector("summary")!.click();
    });
    expect(breakdown.open).toBe(true);

    // Click 修改评分结果 -> enters edit mode with DecisionEditor visible
    const editBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "修改评分结果");
    expect(editBtn).toBeDefined();
    await act(async () => editBtn!.click());
    expect(container.querySelector(".decision-editor")).toBeTruthy();

    // Cancel edit -> returns cleanly
    const cancelBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "取消修改");
    await act(async () => cancelBtn!.click());
    expect(container.querySelector(".decision-editor")).toBeNull();

    // Switch to session-2 (requiresReview: false) -> optional note collapsed, breakdown reset to closed
    const secondStudentBtn = [...container.querySelectorAll<HTMLButtonElement>(".batch-review-sidebar nav button")].find((btn) => btn.textContent?.includes("李四"));
    expect(secondStudentBtn).toBeDefined();
    await act(async () => secondStudentBtn!.click());

    const resultPane = container.querySelector(".batch-review-result")!;
    expect(resultPane.textContent).toContain("19/20");
    expect(resultPane.textContent).toContain("96%");
    expect(resultPane.querySelector(".batch-review-note textarea")).toBeNull();
    expect(resultPane.textContent).toContain("添加复核备注（可选）");

    const nextBreakdown = resultPane.querySelector<HTMLDetailsElement>("details.grading-breakdown-disclosure");
    expect(nextBreakdown?.open).toBe(false);
  });

  it("switches left report to annotation mode and highlights cited line when clicking evidence", async () => {
    await mountBatchReview();

    const modeBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.trim() === "批注模式");
    expect(modeBtn).toBeDefined();
    await act(async () => modeBtn!.click());

    const viewer = container.querySelector(".annotated-submission");
    expect(viewer).toBeTruthy();
    expect(viewer!.querySelector("h1")?.textContent).toBe("张三报告正文");
    const targetLine = viewer!.querySelector<HTMLElement>("[data-line='2']");
    expect(targetLine).toBeTruthy();
    const scrollSpy = vi.fn();
    targetLine!.scrollIntoView = scrollSpy;

    const evidenceBtn = container.querySelector<HTMLButtonElement>("button.grading-evidence.is-clickable");
    expect(evidenceBtn).toBeTruthy();
    await act(async () => evidenceBtn!.click());

    expect(targetLine!.classList.contains("is-highlighted")).toBe(true);
    expect(viewer!.querySelector("[data-line='1']")?.classList.contains("is-highlighted")).toBe(false);
    expect(scrollSpy).toHaveBeenCalled();

    // Stepping control is visible in annotation banner
    expect(container.querySelector(".annotated-jump-banner")?.textContent).toContain("1/1");
  });

  it("shows batch review progress summary and supports quick-fill review note chips", async () => {
    await mountBatchReview();

    expect(container.querySelector(".batch-review-progress")?.textContent).toContain("已确认 0/2");
    const chip = container.querySelector<HTMLButtonElement>(".grading-quick-note-chips button");
    expect(chip).toBeTruthy();
    await act(async () => chip!.click());
    expect(container.querySelector<HTMLTextAreaElement>(".batch-review-note textarea")?.value.trim().length).toBeGreaterThan(0);
  });

  it("displays distinct auto-confirmed pill and badge styling for auto-confirmed batch jobs", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/grading/batches/review?batch=batch-1&session=session-2");
    const baseBatch = makeBatch();
    const batch = {
      ...baseBatch,
      jobs: baseBatch.jobs.map((job, index) =>
        index === 1
          ? {
              ...job,
              reviewStatus: "confirmed" as const,
              confirmationMode: "auto" as const,
            }
          : job,
      ),
    };
    const s1 = makeSession1();
    const s2 = {
      ...makeSession2(),
      confirmed: {
        ...makeSession2().draft,
        resultHash: "auto-hash-123",
        confirmationMode: "auto" as const,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/grading/batches/batch-1") return Response.json(batch);
        if (url === "/api/grading/sessions/session-1") return Response.json(s1);
        if (url === "/api/grading/sessions/session-2") return Response.json(s2);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(GradingBatchReviewPage)));

    const sidebarAutoBadge = container.querySelector(".batch-review-mini-badge.is-auto-confirmed");
    expect(sidebarAutoBadge?.textContent).toBe("已自动确认");
    expect(container.querySelector(".grading-status-pill.is-auto-confirmed")?.textContent).toBe("已自动确认");
    expect(container.querySelector(".confirmed-badge.is-auto-confirmed")?.textContent).toContain("成绩已自动确认");
  });
});
