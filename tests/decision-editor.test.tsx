// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyRubricLike } from "../src/schemas/rubric-engine.js";
import { DecisionEditor } from "../web/src/components/grading/DecisionPanels.js";

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

describe("DecisionEditor rubric-aware controls", () => {
  it("syncs selectedLevelId on cross-band score edits and previews live total", async () => {
    setupDom();
    const rubric: AnyRubricLike = {
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 20,
      partialCreditAllowed: true,
      criteria: [
        {
          id: "analysis",
          name: "核心分析",
          description: "分析质量",
          maxScore: 20,
          scorePolicy: "range",
          evidenceRequired: false,
          levels: [
            { id: "low", minScore: 0, maxScore: 9.99, condition: "较弱" },
            { id: "high", minScore: 10, maxScore: 20, condition: "良好" },
          ],
        },
      ],
    };

    let latest: Record<string, unknown> = {
      schemaVersion: "1.0",
      mode: "additive",
      criteria: [{ criterionId: "analysis", selectedLevelId: "low", score: 8, reason: "基础分析", evidence: [], confidence: 0.9 }],
      strengths: [],
      improvements: [],
      warnings: [],
    };

    function Harness() {
      const [decisions, setDecisions] = useState(latest);
      return createElement(DecisionEditor, {
        decisions,
        rubric,
        baselineScore: 8,
        onChange: (next) => {
          latest = next;
          setDecisions(next);
        },
      });
    }

    await act(async () => {
      root.render(createElement(Harness));
    });

    expect(container.textContent).toContain("预计总分：8 / 20");
    // Click high level chip (maxScore 20)
    const highButton = Array.from(container.querySelectorAll("button")).find((btn) => btn.textContent?.includes("10–20"));
    expect(highButton).toBeTruthy();
    await act(async () => {
      highButton!.click();
    });

    expect(container.textContent).toContain("预计总分：20 / 20");
    expect(container.textContent).toContain("+12 分");
    const updatedCriterion = (latest.criteria as Array<Record<string, unknown>>)[0]!;
    expect(updatedCriterion.score).toBe(20);
    expect(updatedCriterion.selectedLevelId).toBe("high");
  });

  it("links fixed and per-occurrence deduction controls with triggered checkbox and occurrence stepper", async () => {
    setupDom();
    const rubric: AnyRubricLike = {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 20,
      rules: [
        { id: "missing", name: "缺少结论", condition: "无结论", amountPolicy: "fixed", deduction: 5, maxDeduction: 5, occurrence: "once", evidenceRequired: false },
        { id: "typo", name: "格式错误", condition: "每处格式错误", amountPolicy: "per-occurrence", deduction: 2, maxDeduction: 6, occurrence: "per-occurrence", evidenceRequired: false },
      ],
      overlapGroups: [],
    };

    let latest: Record<string, unknown> = {
      schemaVersion: "1.0",
      mode: "deductive",
      deductions: [
        { ruleId: "missing", triggered: false, deduction: 0, reason: "有结论", evidence: [], confidence: 0.95 },
        { ruleId: "typo", triggered: false, deduction: 0, reason: "无格式错误", evidence: [], confidence: 0.95 },
      ],
      strengths: [],
      improvements: [],
      warnings: [],
    };

    function Harness() {
      const [decisions, setDecisions] = useState(latest);
      return createElement(DecisionEditor, {
        decisions,
        rubric,
        baselineScore: 20,
        onChange: (next) => {
          latest = next;
          setDecisions(next);
        },
      });
    }

    await act(async () => {
      root.render(createElement(Harness));
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);

    // Trigger fixed deduction -> auto-fills 5
    await act(async () => {
      checkboxes[0]!.click();
    });
    expect((latest.deductions as Array<Record<string, unknown>>)[0]!.deduction).toBe(5);
    expect(container.textContent).toContain("预计总分：15 / 20");

    // Trigger per-occurrence -> auto-fills 1 * 2 = 2, then increment to 2 * 2 = 4
    await act(async () => {
      checkboxes[1]!.click();
    });
    expect((latest.deductions as Array<Record<string, unknown>>)[1]!.deduction).toBe(2);
    expect((latest.deductions as Array<Record<string, unknown>>)[1]!.occurrences).toBe(1);

    const plusBtn = container.querySelector<HTMLButtonElement>('button[aria-label="增加次数"]');
    expect(plusBtn).toBeTruthy();
    await act(async () => {
      plusBtn!.click();
    });
    expect((latest.deductions as Array<Record<string, unknown>>)[1]!.deduction).toBe(4);
    expect((latest.deductions as Array<Record<string, unknown>>)[1]!.occurrences).toBe(2);
    expect(container.textContent).toContain("预计总分：11 / 20");

    // Untrigger fixed deduction -> resets to 0
    await act(async () => {
      checkboxes[0]!.click();
    });
    expect((latest.deductions as Array<Record<string, unknown>>)[0]!.deduction).toBe(0);
    expect(container.textContent).toContain("预计总分：16 / 20");
  });
});
