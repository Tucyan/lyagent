import { describe, expect, it } from "vitest";
import { appendProcessText, shouldOpenProcess, visibleToolSteps } from "../web/src/lib/qa-presentation.js";

describe("QA presentation helpers", () => {
  it("keeps at most the five most recent tool calls visible until expanded", () => {
    const steps = Array.from({ length: 7 }, (_, index) => ({ id: String(index + 1) }));

    expect(visibleToolSteps(steps, false).map((step) => step.id)).toEqual(["3", "4", "5", "6", "7"]);
    expect(visibleToolSteps(steps, true).map((step) => step.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("stores streamed process text separately from the final answer", () => {
    expect(appendProcessText(undefined, "Checking sources.")).toBe("Checking sources.");
    expect(appendProcessText("Checking sources.", " Reading a result.")).toBe("Checking sources. Reading a result.");
  });

  it("collapses the process panel after the formal answer is available", () => {
    expect(shouldOpenProcess(true)).toBe(true);
    expect(shouldOpenProcess(false)).toBe(false);
  });
});
