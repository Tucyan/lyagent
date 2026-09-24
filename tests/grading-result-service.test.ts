import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { GradingDraft } from "../src/schemas/grading.js";
import { GradingResultService, GradingReviewRequiredError } from "../src/services/grading-result-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-result-service-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "报告", totalScore: 100, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [],
    rules: [
      { id: "missing", name: "缺失内容", condition: "内容缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
      { id: "weak", name: "质量一般", condition: "质量一般", deduction: 5, maxDeduction: 5, occurrence: "once", evidenceRequired: true },
    ],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.md");
  await writeFile(source, "# 报告\n\n背景内容\n\n实现过程\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics, { now: () => "2026-08-04T11:00:00.000Z" });
  const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false });
  await sessions.lockSubmissionForGrading(session.id);
  const results = new GradingResultService(root, sessions, rubrics, { now: () => "2026-08-04T11:01:00.000Z" });
  return { root, rubrics, sessions, results, session };
}

function draft(confidence = 0.6, deduction = 20): GradingDraft {
  const evidence = [
    { kind: "analysis" as const, observation: "报告缺少关键背景说明。", rubricBasis: "评分规则要求完整说明背景。", scoreJustification: "缺失直接影响任务完整性，因此扣20分。" },
    { kind: "text" as const, path: "submission-v1.md", heading: "报告", startLine: 1, endLine: 3, quote: "背景内容" },
  ];
  return {
    schemaVersion: "1.0", mode: "deductive",
    deductions: [
      { ruleId: "missing", triggered: deduction > 0, deduction, reason: deduction > 0 ? "关键内容缺失" : "内容完整", evidence, confidence },
      { ruleId: "weak", triggered: false, deduction: 0, reason: "质量可接受", evidence, confidence: 0.9 },
    ],
    strengths: ["结构清晰"], improvements: ["补充细节"], warnings: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GradingResultService", () => {
  it("validates and versions Agent drafts while calculating score and review automatically", async () => {
    const { sessions, results, session } = await setup();
    const saved = await results.submitDraft(session.id, 0, draft(), { type: "agent", id: "run-1" });
    expect(saved).toMatchObject({ version: 1, result: { score: { earned: 80, possible: 100 }, review: { requiresReview: true } } });
    expect((await sessions.getSession(session.id)).gradingStatus).toBe("needs_review");
    await expect(results.submitDraft(session.id, 0, draft(), { type: "agent", id: "run-1" })).rejects.toThrow(/version/i);
    sessions.close();
  });

  it("records teacher patches with before/after hashes and recomputes totals", async () => {
    const { root, sessions, results, session } = await setup();
    const first = await results.submitDraft(session.id, 0, draft(), { type: "agent", id: "run-1" });
    const patched = await results.submitDraft(session.id, first.version, draft(0.85, 0), { type: "teacher", id: "teacher-local", note: "已核对原文" });
    expect(patched).toMatchObject({ version: 2, result: { score: { earned: 100 }, review: { requiresReview: false } } });
    const audit = await readFile(path.join(root, "assignments", session.assignmentId, "results", session.batchId, "audit", `${session.studentKey}.jsonl`), "utf8");
    expect(JSON.parse(audit.trim())).toMatchObject({ actor: { type: "teacher", id: "teacher-local" }, note: "已核对原文" });
    expect(JSON.parse(audit.trim()).beforeHash).not.toBe(JSON.parse(audit.trim()).afterHash);
    sessions.close();
  });

  it("requires review acknowledgement and note, then publishes immutable JSON and Markdown idempotently", async () => {
    const { root, sessions, results, session } = await setup();
    const saved = await results.submitDraft(session.id, 0, draft(), { type: "agent", id: "run-1" });
    await expect(results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "", acknowledgedReasons: [] })).rejects.toBeInstanceOf(GradingReviewRequiredError);
    const confirmed = await results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "已人工复核低置信度项", acknowledgedReasons: ["LOW_CONFIDENCE"] });
    await expect(results.readConfirmedResult(session.id)).resolves.toEqual(confirmed);
    const repeated = await results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "重复请求", acknowledgedReasons: ["LOW_CONFIDENCE"] });
    expect(repeated).toEqual(confirmed);
    expect(confirmed).toMatchObject({ reviewStatus: "confirmed", resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await sessions.getSession(session.id)).gradingStatus).toBe("confirmed");
    const jsonPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, `${session.studentKey}.json`);
    const markdownPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, `${session.studentKey}.md`);
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toMatchObject({ result: { score: { earned: 80 } } });
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("80/100");
    expect(markdown).toContain("评分分析依据");
    expect(markdown).toContain("缺失直接影响任务完整性，因此扣20分");
    expect(markdown).not.toContain("置信度");
    await expect(results.submitDraft(session.id, saved.version, draft(0.9, 0), { type: "teacher", id: "teacher-local" })).rejects.toThrow(/confirmed/i);
    sessions.close();
  });

  it("rejects a confirmed score changed without updating its content hash", async () => {
    const { root, sessions, results, session } = await setup();
    const saved = await results.submitDraft(session.id, 0, draft(), { type: "agent", id: "run-1" });
    await results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "已人工复核", acknowledgedReasons: ["LOW_CONFIDENCE"] });
    const jsonPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, `${session.studentKey}.json`);
    const confirmed = JSON.parse(await readFile(jsonPath, "utf8")) as { result: { score: { earned: number } } };
    confirmed.result.score.earned = 100;
    await writeFile(jsonPath, JSON.stringify(confirmed), "utf8");

    await expect(results.readConfirmedResult(session.id)).rejects.toThrow(/hash|invalid|corrupt/i);
    sessions.close();
  });

  it("finishes an interrupted confirmation when the confirmed JSON already exists", async () => {
    const { root, sessions, results, session } = await setup();
    const saved = await results.submitDraft(session.id, 0, draft(0.9), { type: "agent", id: "run-1" });
    const confirmed = await results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "", acknowledgedReasons: [] });
    const markdownPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, `${session.studentKey}.md`);
    const auditPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, "audit", `${session.studentKey}.jsonl`);
    await rm(markdownPath);
    await rm(auditPath);
    const database = new Database(path.join(root, "grading.sqlite"));
    database.prepare("UPDATE grading_sessions SET grading_status = 'needs_review' WHERE id = ?").run(session.id);
    database.close();

    const recovered = await results.confirm(session.id, { expectedVersion: saved.version, reviewNote: "ignored retry", acknowledgedReasons: [] });

    expect(recovered).toEqual(confirmed);
    expect(await readFile(markdownPath, "utf8")).toContain("80/100");
    expect(JSON.parse((await readFile(auditPath, "utf8")).trim())).toMatchObject({ action: "confirm", resultHash: confirmed.resultHash });
    expect((await sessions.getSession(session.id)).gradingStatus).toBe("confirmed");
    sessions.close();
  });

  it("serializes same-version draft updates so only one writer succeeds", async () => {
    const { sessions, results, session } = await setup();
    const attempts = await Promise.allSettled([
      results.submitDraft(session.id, 0, draft(0.9), { type: "teacher", id: "teacher-a", note: "A" }),
      results.submitDraft(session.id, 0, draft(0.8), { type: "teacher", id: "teacher-b", note: "B" }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    sessions.close();
  });
});
