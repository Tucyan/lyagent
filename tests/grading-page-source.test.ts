import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("grading page state synchronization", () => {
  it("guards detail writes, preserves active edits, and uses serial preparation polling", async () => {
    const source = await readFile(path.resolve("web", "src", "pages", "GradingPage.tsx"), "utf8");

    expect(source).toContain("LatestRequestGate");
    expect(source).toContain("startSerialPolling");
    expect(source).toMatch(/if \(!editing\)[\s\S]*setMarkdown/);
    expect(source).toContain("lease.isCurrent()");
  });

  it("shows and disables the title retry operation immediately", async () => {
    const source = await readFile(path.resolve("web", "src", "pages", "GradingPage.tsx"), "utf8");

    expect(source).toContain("retryingTitle");
    expect(source).toContain("submissionTitlePresentation");
    expect(source).toContain("titlePresentation.retryDisabled");
    expect(source).toContain("titlePresentation.retryLabel");
    expect(source).toMatch(/setDetail\(\(current\)[\s\S]*\{ \.\.\.current, \.\.\.next \}/);
  });

  it("serializes session actions and surfaces rejected promises in the page notice", async () => {
    const source = await readFile(path.resolve("web", "src", "pages", "GradingPage.tsx"), "utf8");

    expect(source).toContain("operationKeysRef");
    expect(source).toContain("runSessionOperation");
    expect(source).toContain("isSessionOperationBusy");
    expect(source).toMatch(/runSessionOperation[\s\S]*setNotice\(\(error as Error\)\.message\)/);
    expect(source).toContain("operationBusy=");
  });

  it("does not treat an event-stream EOF as a successful grading run", async () => {
    const source = await readFile(path.resolve("web", "src", "pages", "GradingPage.tsx"), "utf8");

    expect(source).toContain("terminalEvent");
    expect(source).toContain("批改连接已中断，请重试");
  });
});
