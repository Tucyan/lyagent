// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminShell } from "../web/src/components/AdminShell.js";
import { ConfirmDialog } from "../web/src/components/ConfirmDialog.js";
import { RubricDocument, RubricEditor, type RubricValue } from "../web/src/components/RubricPreviewEditor.js";
import { ToastProvider, recoveryActionForError, useToast } from "../web/src/components/ToastProvider.js";
import { ApiError } from "../web/src/lib/api.js";
import { filterBatchReviewJobs } from "../web/src/pages/GradingBatchReviewPage.js";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function setupDom() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

describe("UX resilience and restrained feedback components", () => {
  it("focuses the safe cancel button on danger ConfirmDialog and closes on Escape", async () => {
    setupDom();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(createElement(ConfirmDialog, {
        open: true,
        title: "取消当前上传草稿？",
        description: "草稿将被清理。",
        confirmLabel: "确认取消",
        tone: "danger",
        onConfirm,
        onCancel,
      }));
    });

    const cancelButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent === "取消");
    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(0);
  });

  it("maps actionable recovery links for known ApiErrors and renders Toast with action", async () => {
    setupDom();
    const action = recoveryActionForError(new ApiError({ code: "MODEL_NOT_CONFIGURED", message: "" }));
    expect(action?.label).toBe("前往模型设置");

    function Trigger() {
      const toast = useToast();
      return createElement("button", { type: "button", onClick: () => toast.error("模型未配置", { action: { label: "前往模型设置", onClick: () => undefined } }) }, "trigger");
    }

    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(Trigger)));
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.textContent).toContain("模型未配置");
    expect(container.textContent).toContain("前往模型设置");
  });

  it("allows undoing deleted rubric criteria and displays live total score mismatch", async () => {
    setupDom();
    const initial: RubricValue = {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [
        { id: "c1", name: "核心论点", description: "论点清晰", maxScore: 60, scorePolicy: "continuous", evidenceRequired: true },
        { id: "c2", name: "数据支撑", description: "引用充分", maxScore: 30, scorePolicy: "continuous", evidenceRequired: true },
      ],
    };

    function Harness() {
      const [rubric, setRubric] = useState<RubricValue>(initial);
      return createElement(ToastProvider, null, createElement(RubricEditor, { rubric, onChange: setRubric }));
    }

    await act(async () => {
      root.render(createElement(Harness));
    });

    // Live total check shows 90 / 100 (10 points short)
    expect(container.textContent).toContain("90 / 100");
    expect(container.textContent).toContain("还差 10 分");

    // Delete first criterion, then click Undo in Toast
    const deleteButtons = Array.from(container.querySelectorAll("button")).filter((btn) => btn.textContent === "删除");
    expect(deleteButtons).toHaveLength(2);
    await act(async () => {
      deleteButtons[0]!.click();
    });
    expect(container.querySelectorAll(".rubric-editor-card")).toHaveLength(1);
    expect(container.textContent).toContain("撤销");

    const undoButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent === "撤销")!;
    await act(async () => {
      undoButton.click();
    });
    expect(container.querySelectorAll(".rubric-editor-card")).toHaveLength(2);
  });

  it("renders AdminShell without dead placeholder buttons and supports compact rail toggle", async () => {
    setupDom();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });

    await act(async () => {
      root.render(createElement(AdminShell, { active: "dashboard", children: createElement("div", null, "content") }));
    });

    expect(container.textContent).not.toContain("后续里程碑");
    expect(container.textContent).not.toContain("企业微信");
    const links = Array.from(container.querySelectorAll(".admin-nav a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/", "/knowledge", "/qa", "/rubrics", "/grading", "/grading/batches", "/grading/exports", "/settings/models"]);

    const toggle = container.querySelector<HTMLButtonElement>(".admin-compact-toggle")!;
    await act(async () => {
      toggle.click();
    });
    expect(container.querySelector(".admin-shell")?.classList.contains("nav-compact")).toBe(true);
  });

  it("filters batch review jobs by status and student search query", () => {
    const jobs = [
      { id: "1", sessionId: "s1", studentName: "张三", studentNumber: "2026001", submissionTitle: "报告A", status: "completed", attemptCount: 1, maxAttempts: 3, reviewStatus: "needs_review" as const },
      { id: "2", sessionId: "s2", studentName: "李四", studentNumber: "2026002", submissionTitle: "报告B", status: "completed", attemptCount: 1, maxAttempts: 3, reviewStatus: "confirmed" as const },
      { id: "3", sessionId: "s3", studentName: "王五", studentNumber: "2026003", submissionTitle: "报告C", status: "failed", attemptCount: 2, maxAttempts: 3 },
    ];
    expect(filterBatchReviewJobs(jobs, "needs_review", "").map((j) => j.id)).toEqual(["1"]);
    expect(filterBatchReviewJobs(jobs, "unconfirmed", "").map((j) => j.id)).toEqual(["1", "3"]);
    expect(filterBatchReviewJobs(jobs, "confirmed", "").map((j) => j.id)).toEqual(["2"]);
    expect(filterBatchReviewJobs(jobs, "attention", "").map((j) => j.id)).toEqual(["3"]);
    expect(filterBatchReviewJobs(jobs, "all", "2026002").map((j) => j.id)).toEqual(["2"]);
  });

  it("marks RubricDocument toggle row sticky only while description or levels are expanded", async () => {
    setupDom();
    await act(async () => {
      root.render(
        createElement(RubricDocument, {
          rubric: {
            schemaVersion: "2.0",
            mode: "additive",
            totalScore: 25,
            criteria: [
              {
                id: "c1",
                name: "数据清洗与异常处理",
                description: "说明缺失值和异常值的清洗步骤。",
                maxScore: 25,
                scoringType: "scored",
                step: 0.5,
                evidenceRequired: true,
                levels: [
                  { id: "c1_good", label: "优秀", minScore: 21, maxScore: 25, condition: "完整清洗" },
                  { id: "c1_fail", label: "不及格", minScore: 0, maxScore: 9.5, condition: "未清洗" },
                ],
              },
            ],
          },
        }),
      );
    });

    const toggleRow = container.querySelector<HTMLDivElement>(".rubric-card-toggle-row")!;
    const levelsBtn = container.querySelector<HTMLButtonElement>(".rubric-levels-toggle")!;
    const descBtn = container.querySelector<HTMLButtonElement>(".rubric-description-toggle")!;

    expect(toggleRow.classList.contains("is-sticky-open")).toBe(false);

    await act(async () => {
      levelsBtn.click();
    });
    expect(toggleRow.classList.contains("is-sticky-open")).toBe(true);
    expect(levelsBtn.textContent).toBe("收起评分细则");

    await act(async () => {
      descBtn.click();
      levelsBtn.click();
    });
    expect(toggleRow.classList.contains("is-sticky-open")).toBe(true);

    await act(async () => {
      descBtn.click();
    });
    expect(toggleRow.classList.contains("is-sticky-open")).toBe(false);
  });
});
