import { describe, expect, it } from "vitest";
import { appendRubricProcess, appendRubricReply, assertRubricStreamSucceeded, assignmentIdFromSearch, clampPreviewPercent, loadRubricSession, rubricCompletionNotice, rubricDeleteWarning, rubricPreviewSections, shouldFollowRubricStream } from "../web/src/pages/rubric-page-model.js";

describe("rubric page selection", () => {
  it("reads the selected assignment ID from the session link", () => {
    expect(assignmentIdFromSearch("?assignment=8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1")).toBe("8f3d57c5-3e91-4a17-8a62-31a3dfa0ddf1");
  });

  it("shows a new session before a slow recommendation is ready", async () => {
    let resolveRecommendation: ((value: { options: string[] }) => void) | undefined;
    const recommendation = new Promise<{ options: string[] }>((resolve) => { resolveRecommendation = resolve; });
    const calls: string[] = [];
    const loaded = loadRubricSession({
      assignment: () => Promise.resolve({ id: "assignment" }),
      draft: () => Promise.resolve(null),
      session: () => Promise.resolve(null),
      recommendations: () => recommendation,
      onCore: (_assignment, _draft, session) => calls.push(session ? "existing" : "core"),
      onRecommendations: () => calls.push("recommendations"),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["core"]);
    resolveRecommendation?.({ options: [] });
    await loaded;
    expect(calls).toEqual(["core", "recommendations"]);
  });

  it("restores a selected scoring mode and history without requesting recommendations", async () => {
    const calls: string[] = [];

    await loadRubricSession({
      assignment: () => Promise.resolve({ id: "assignment" }),
      draft: () => Promise.resolve({ version: 1 }),
      session: () => Promise.resolve({ selectedMode: "deductive", messages: [{ role: "user", content: "History" }] }),
      recommendations: () => { calls.push("recommendations"); return Promise.resolve({ options: [] }); },
      onCore: (_assignment, _draft, session) => calls.push(session?.selectedMode ?? "missing"),
      onRecommendations: () => calls.push("recommendation-result"),
    });

    expect(calls).toEqual(["deductive"]);
  });

  it("clamps the draggable preview to keep both chat and preview usable", () => {
    expect(clampPreviewPercent(10)).toBe(28);
    expect(clampPreviewPercent(46)).toBe(46);
    expect(clampPreviewPercent(90)).toBe(72);
  });

  it("does not report a rubric stream as complete after an SSE error", () => {
    expect(() => assertRubricStreamSucceeded("The rubric design request could not be completed")).toThrow("The rubric design request could not be completed");
    expect(() => assertRubricStreamSucceeded()).not.toThrow();
  });

  it("bounds the visible model processing summary", () => {
    expect(appendRubricProcess("a".repeat(11_999), "bc")).toHaveLength(12_000);
    expect(appendRubricProcess("a".repeat(12_000), "ignored")).toBe("a".repeat(12_000));
  });

  it("assembles streamed rubric replies incrementally", () => {
    expect(appendRubricReply("建议补充", "评分等级")).toBe("建议补充评分等级");
  });

  it("follows a stream only while the teacher remains near the latest message", () => {
    expect(shouldFollowRubricStream(40)).toBe(true);
    expect(shouldFollowRubricStream(180)).toBe(false);
  });

  it("makes non-mutating conversational replies explicit", () => {
    expect(rubricCompletionNotice("reply")).toContain("未修改评分表草稿");
    expect(rubricCompletionNotice("draft")).toContain("草稿");
    expect(rubricCompletionNotice("question")).toContain("等待");
  });

  it("warns teachers that deleting a rubric session removes every related artifact", () => {
    const warning = rubricDeleteWarning("报告评分表");

    expect(warning).toContain("报告评分表");
    expect(warning).toContain("参考资料");
    expect(warning).toContain("聊天记录");
    expect(warning).toContain("当前草稿");
    expect(warning).toContain("全部冻结正式版本");
    expect(warning).toContain("无法恢复");
  });

  it("builds a teacher-readable additive preview model", () => {
    expect(rubricPreviewSections({
      schemaVersion: "1.0",
      mode: "additive",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: [{ id: "analysis", name: "分析质量", description: "论证完整且有证据。", maxScore: 100, scorePolicy: "continuous", evidenceRequired: true }],
    })).toEqual([
      { title: "评分项目", rows: [{ title: "分析质量", score: "100 分", description: "论证完整且有证据。", detail: "连续评分 · 需要评分分析依据" }] },
    ]);
  });

  it("describes mixed deduction amount policies", () => {
    const sections = rubricPreviewSections({
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [
        { name: "Fixed", condition: "Missing", amountPolicy: "fixed", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
        { name: "Repeated", condition: "Each error", amountPolicy: "per-occurrence", deduction: 2, maxDeduction: 10, occurrence: "per-occurrence", evidenceRequired: true },
        { name: "Severity", condition: "Weak quality", amountPolicy: "range", maxDeduction: 20, occurrence: "once", evidenceRequired: true },
      ],
      overlapGroups: [],
    });

    expect(sections[0]!.rows.map((row) => row.score)).toEqual([
      "−20 分（固定一次）",
      "−2 分/次（上限 10）",
      "−1–20 分（整数区间）",
    ]);
  });
});
