import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { registerGradingApi } from "../src/api/grading-routes.js";
import {
  AUTO_CONFIRM_HIGH_CONFIDENCE_THRESHOLD,
  isHighConfidenceAutoConfirmEligible,
  type GradingDraft,
  type GradingResult,
} from "../src/schemas/grading.js";
import { GradingResultService, GradingReviewRequiredError } from "../src/services/grading-result-service.js";
import { GradingBatchService } from "../src/services/grading-batch-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { GradingRunService } from "../src/services/grading-run-service.js";
import { RubricService } from "../src/services/rubric-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)));
});

async function setupEnv(options: { autoConfirmHighConfidence?: boolean; lockSubmission?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-auto-confirm-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({
    courseId: "11111111-1111-4111-8111-111111111111",
    title: "实验报告",
    totalScore: 100,
    requirements: "评分",
    sources: [],
  });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0",
    mode: "deductive",
    totalScore: 100,
    overlapGroups: [],
    rules: [
      { id: "missing", name: "缺失内容", condition: "内容缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
    ],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.md");
  await writeFile(source, "# 报告\n\n背景内容\n\n实现过程\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics, { now: () => "2026-08-04T11:00:00.000Z" });
  const session = await sessions.createSession({
    assignmentId: assignment.id,
    rubricVersion: frozen.version,
    studentName: "张晓明",
    studentNumber: "20260001",
    submissionTitle: "实验报告",
    originalPath: source,
    originalFilename: "report.md",
    autoStartAfterConversion: false,
    autoConfirmHighConfidence: options.autoConfirmHighConfidence ?? false,
  });
  if (options.lockSubmission !== false) await sessions.lockSubmissionForGrading(session.id);
  const results = new GradingResultService(root, sessions, rubrics, { now: () => "2026-08-04T11:01:00.000Z" });
  return { root, rubrics, sessions, results, session };
}

function makeDraft(confidence: number, warnings: string[] = []): Extract<GradingDraft, { mode: "deductive" }> {
  return {
    schemaVersion: "1.0",
    mode: "deductive",
    deductions: [
      {
        ruleId: "missing",
        triggered: false,
        deduction: 0,
        reason: "内容完整",
        evidence: [
          { kind: "analysis", observation: "完整", rubricBasis: "达标", scoreJustification: "不扣分" },
        ],
        confidence,
      },
    ],
    strengths: ["清晰"],
    improvements: [],
    warnings,
  };
}

async function setupApi(autoConfirmHighConfidence: boolean) {
  const env = await setupEnv({ autoConfirmHighConfidence, lockSubmission: false });
  const app = Fastify();
  const control = registerGradingApi(app, {
    workspaceRoot: env.root,
    rubrics: env.rubrics,
    gradingAgentFactory(sessionId, runId, { results }) {
      return {
        async run() {
          const draft = await results.submitDraft(sessionId, 0, makeDraft(0.95), { type: "agent", id: runId });
          return { kind: "draft", draft };
        },
      };
    },
  });
  app.addHook("onClose", () => {
    control.close();
    env.sessions.close();
  });
  const resultDir = path.join(env.root, "assignments", env.session.assignmentId, "results", env.session.batchId);
  const startBatch = async (enabled: boolean) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/grading/batches",
      payload: {
        title: "批改回归测试",
        assignmentId: env.session.assignmentId,
        rubricVersion: 1,
        concurrency: 1,
        autoConfirmHighConfidence: enabled,
        sessionIds: [env.session.id],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const url = `/api/grading/batches/${created.json().id}`;
    const started = await app.inject({ method: "POST", url: `${url}/start` });
    expect(started.statusCode, started.body).toBe(202);
    return url;
  };
  return { ...env, app, resultDir, startBatch };
}

describe("High-confidence auto-confirm", () => {
  it.each([true, false])("uses the batch opt-in (%s) for an existing session with the opposite setting", async (enabled) => {
    const { app, startBatch } = await setupApi(!enabled);
    try {
      const url = await startBatch(enabled);
      await expect.poll(async () => {
        const batch = (await app.inject({ method: "GET", url })).json();
        return batch.jobs[0];
      }).toMatchObject(enabled
        ? { status: "completed", reviewStatus: "confirmed", confirmationMode: "auto" }
        : { status: "needs_review", reviewStatus: "needs_review" });
    } finally {
      await app.close();
    }
  });

  it.each([
    { blocked: "confirm-commit.json", status: "needs_review", reviewStatus: "needs_review" },
    { blocked: "md", status: "completed", reviewStatus: "confirmed" },
  ])("settles a batch independently of failures writing $blocked", async ({ blocked, status, reviewStatus }) => {
    const { app, root, session, sessions, resultDir, startBatch } = await setupApi(true);
    const blockedPath = path.join(resultDir, `${session.studentKey}.${blocked}`);
    try {
      await mkdir(blockedPath, { recursive: true });
      const url = await startBatch(true);
      await expect.poll(async () => {
        const response = await app.inject({ method: "GET", url });
        return response.json().jobs?.[0];
      }).toMatchObject({ status, reviewStatus });

      const db = new Database(path.join(root, "grading.sqlite"), { readonly: true });
      try {
        expect(db.prepare("SELECT status FROM agent_runs WHERE session_id = ?").get(session.id)).toEqual({ status: "completed" });
      } finally {
        db.close();
      }
      expect((await sessions.getSession(session.id)).gradingStatus)
        .toBe(reviewStatus === "confirmed" ? "confirmed" : "draft_ready");
      await rmdir(blockedPath);

      if (reviewStatus === "confirmed") {
        const csv = await app.inject({ method: "GET", url: `${url}/export.csv?scope=confirmed` });
        expect(csv.body).toContain(session.studentNumber);
        expect(await readFile(blockedPath, "utf8")).toContain("100/100");
      } else {
        const batch = (await app.inject({ url })).json();
        const confirmed = await app.inject({
          method: "POST",
          url: `${url}/jobs/${batch.jobs[0].id}/confirm`,
          payload: { expectedVersion: 1, reviewNote: "", acknowledgedReasons: [] },
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        expect(confirmed.json()).toMatchObject({ confirmationMode: "manual" });
      }
    } finally {
      await app.close();
    }
  });

  it("lists the confirmation mode without updating timestamps or recreating feedback", async () => {
    const { app, session, sessions, resultDir, startBatch } = await setupApi(true);
    try {
      const url = await startBatch(true);
      await expect.poll(async () => {
        const response = await app.inject({ url });
        return response.json().jobs[0]?.status;
      }).toBe("completed");
      const markdown = path.join(resultDir, `${session.studentKey}.md`);
      await rm(markdown);
      const before = await sessions.getSession(session.id);
      const response = await app.inject({ url: "/api/grading/sessions" });
      expect(response.json()).toEqual([expect.objectContaining({ id: session.id, confirmationMode: "auto" })]);
      expect((await sessions.getSession(session.id)).updatedAt).toBe(before.updatedAt);
      await expect(stat(markdown)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it("evaluates high-confidence eligibility strictly using threshold 0.85 and review/warning checks", () => {
    expect(AUTO_CONFIRM_HIGH_CONFIDENCE_THRESHOLD).toBe(0.85);
    const baseResult: GradingResult = {
      schemaVersion: "1.0",
      mode: "deductive",
      submissionHash: "a".repeat(64),
      score: { earned: 100, possible: 100 },
      confidence: { overall: 0.85, minimum: 0.85, lowCount: 0 },
      review: { requiresReview: false, reasons: [] },
      decisions: makeDraft(0.85),
    };

    expect(isHighConfidenceAutoConfirmEligible(baseResult)).toBe(true);
    expect(isHighConfidenceAutoConfirmEligible({
      ...baseResult,
      confidence: { overall: 0.84, minimum: 0.84, lowCount: 0 },
    })).toBe(false);
    expect(isHighConfidenceAutoConfirmEligible({
      ...baseResult,
      review: { requiresReview: true, reasons: ["NEAR_PASSING_BOUNDARY"] },
    })).toBe(false);
    expect(isHighConfidenceAutoConfirmEligible({
      ...baseResult,
      decisions: makeDraft(0.9, ["存在格式警告"]),
    })).toBe(false);
    expect(isHighConfidenceAutoConfirmEligible(baseResult, { gradingStatus: "waiting_for_teacher" })).toBe(false);
  });

  it("records confirmationMode auto vs manual and blocks ineligible auto-confirm", async () => {
    const { root, sessions, results, session } = await setupEnv({ autoConfirmHighConfidence: true });
    try {
      expect(session.autoConfirmHighConfidence).toBe(true);

      const lowSaved = await results.submitDraft(session.id, 0, makeDraft(0.82), { type: "agent", id: "run-1" });
      await expect(results.tryAutoConfirm(session.id, lowSaved.version)).resolves.toBeUndefined();
      await expect(
        results.confirm(session.id, {
          expectedVersion: lowSaved.version,
          reviewNote: "",
          acknowledgedReasons: [],
          confirmationMode: "auto",
        }),
      ).rejects.toBeInstanceOf(GradingReviewRequiredError);

      const highSaved = await results.submitDraft(session.id, lowSaved.version, makeDraft(0.92), { type: "agent", id: "run-2" });
      const autoConfirmed = await results.tryAutoConfirm(session.id, highSaved.version);
      expect(autoConfirmed).toBeDefined();
      expect(autoConfirmed?.confirmationMode).toBe("auto");
      expect((await sessions.getSession(session.id)).gradingStatus).toBe("confirmed");

      const auditPath = path.join(root, "assignments", session.assignmentId, "results", session.batchId, "audit", `${session.studentKey}.jsonl`);
      const auditEvents = (await readFile(auditPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(auditEvents.at(-1)).toMatchObject({
        action: "confirm",
        confirmationMode: "auto",
        actor: { type: "system", id: "auto-high-confidence" },
      });
    } finally {
      sessions.close();
    }
  });

  it("auto-confirms on draft run completion only when enabled and not waiting_for_teacher", async () => {
    const envAuto = await setupEnv({ autoConfirmHighConfidence: true });
    const envManual = await setupEnv({ autoConfirmHighConfidence: false });
    try {
      const runAuto = new GradingRunService(
        envAuto.root,
        envAuto.sessions,
        (sessionId, runId) => ({
          async run() {
            const draft = await envAuto.results.submitDraft(sessionId, 0, makeDraft(0.95), { type: "agent", id: runId });
            return { kind: "draft", draft };
          },
        }),
        {
          onDraftOutcome: async (sessionId, draftVersion) => {
            const s = await envAuto.sessions.getSession(sessionId);
            if (s.autoConfirmHighConfidence) {
              await envAuto.results.tryAutoConfirm(sessionId, draftVersion);
            }
          },
        },
      );

      try {
        const started = await runAuto.start(envAuto.session.id, { kind: "grade", message: "请批改" });
        await runAuto.waitForTerminal(started.id);
        const confirmed = await envAuto.results.readConfirmedResult(envAuto.session.id);
        expect(confirmed?.confirmationMode).toBe("auto");
        expect((await envAuto.sessions.getSession(envAuto.session.id)).gradingStatus).toBe("confirmed");
      } finally {
        runAuto.close();
      }

      const runManual = new GradingRunService(
        envManual.root,
        envManual.sessions,
        (sessionId, runId) => ({
          async run() {
            const draft = await envManual.results.submitDraft(sessionId, 0, makeDraft(0.95), { type: "agent", id: runId });
            return { kind: "draft", draft };
          },
        }),
        {
          onDraftOutcome: async (sessionId, draftVersion) => {
            const s = await envManual.sessions.getSession(sessionId);
            if (s.autoConfirmHighConfidence) {
              await envManual.results.tryAutoConfirm(sessionId, draftVersion);
            }
          },
        },
      );
      try {
        const startedManual = await runManual.start(envManual.session.id, { kind: "grade", message: "请批改" });
        await runManual.waitForTerminal(startedManual.id);
        expect(await envManual.results.readConfirmedResult(envManual.session.id)).toBeUndefined();
        expect((await envManual.sessions.getSession(envManual.session.id)).gradingStatus).toBe("draft_ready");
      } finally {
        runManual.close();
      }
    } finally {
      envAuto.sessions.close();
      envManual.sessions.close();
    }
  });

  it("propagates autoConfirmHighConfidence in batch grading and marks auto vs manual review status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-auto-confirm-batch-"));
    roots.push(root);
    const rubrics = new RubricService(root);
    const assignment = await rubrics.createAssignment({
      courseId: "11111111-1111-4111-8111-111111111111",
      title: "批量实验报告",
      totalScore: 100,
      requirements: "评分",
      sources: [],
    });
    await rubrics.selectMode(assignment.id, "deductive");
    await rubrics.createDraft(assignment.id, {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      overlapGroups: [],
      rules: [
        { id: "missing", name: "缺失内容", condition: "内容缺失", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true },
      ],
    });
    const frozen = await rubrics.freeze(assignment.id, 1, []);
    const sourceA = path.join(root, "report-a.md");
    const sourceB = path.join(root, "report-b.md");
    await writeFile(sourceA, "# 报告A\n\n内容完整\n", "utf8");
    await writeFile(sourceB, "# 报告B\n\n内容完整\n", "utf8");
    const sessions = new GradingSessionService(root, rubrics, { now: () => "2026-08-04T11:00:00.000Z" });
    const highSession = await sessions.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "高置信学生",
      studentNumber: "20261001",
      submissionTitle: "报告A",
      originalPath: sourceA,
      originalFilename: "report-a.md",
      autoStartAfterConversion: false,
      autoConfirmHighConfidence: true,
    });
    const lowSession = await sessions.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "低置信学生",
      studentNumber: "20261002",
      submissionTitle: "报告B",
      originalPath: sourceB,
      originalFilename: "report-b.md",
      autoStartAfterConversion: false,
      autoConfirmHighConfidence: true,
    });
    const results = new GradingResultService(root, sessions, rubrics, { now: () => "2026-08-04T11:01:00.000Z" });
    const runs = new GradingRunService(
      root,
      sessions,
      (sessionId, runId) => ({
        async run() {
          const conf = sessionId === highSession.id ? 0.93 : 0.81;
          const draft = await results.submitDraft(sessionId, 0, makeDraft(conf), { type: "agent", id: runId });
          return { kind: "draft", draft };
        },
      }),
      {
        onDraftOutcome: async (sessionId, draftVersion) => {
          const s = await sessions.getSession(sessionId);
          if (s.autoConfirmHighConfidence && s.gradingStatus !== "waiting_for_teacher") {
            await results.tryAutoConfirm(sessionId, draftVersion);
          }
        },
      },
    );
    const batches = new GradingBatchService(root, {
      getSession: (id) => sessions.getSession(id),
      async execute(sessionId, input) {
        if (input.kind === "grade") {
          const current = await sessions.getSession(sessionId);
          if (current.gradingStatus === "not_started") {
            await sessions.lockSubmissionForGrading(sessionId, { allowBatchReservation: true, resumeWaitingForTeacher: true });
          }
        }
        const started = await runs.start(sessionId, input, { allowBatchReservation: true });
        const terminal = await runs.waitForTerminal(started.id, 10_000);
        return {
          status: terminal.status as "completed" | "waiting_for_teacher" | "failed" | "cancelled",
          runId: terminal.id,
          ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
        };
      },
      async readResult(sessionId) {
        const confirmed = await results.readConfirmedResult(sessionId);
        if (confirmed) {
          return {
            reviewStatus: "confirmed",
            confirmationMode: confirmed.confirmationMode ?? "manual",
            version: confirmed.version,
            result: confirmed.result,
            updatedAt: confirmed.confirmedAt,
          };
        }
        const draft = await results.readDraft(sessionId);
        return draft
          ? { reviewStatus: "needs_review", version: draft.version, result: draft.result, updatedAt: draft.updatedAt }
          : undefined;
      },
    });
    try {
      const created = await batches.createBatch({
        title: "自动确认批次",
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        concurrency: 2,
        autoConfirmHighConfidence: true,
        sessionIds: [highSession.id, lowSession.id],
      });
      expect(created.autoConfirmHighConfidence).toBe(true);
      await batches.startBatch(created.id);
      let detail = await batches.getBatch(created.id);
      const deadline = Date.now() + 5_000;
      while (
        (detail.status !== "completed" || detail.jobs.some((job) => job.status === "pending" || job.status === "running")) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        detail = await batches.getBatch(created.id);
      }
      expect(detail.status).toBe("completed");
      const highJob = detail.jobs.find((job) => job.sessionId === highSession.id);
      const lowJob = detail.jobs.find((job) => job.sessionId === lowSession.id);
      expect(highJob).toMatchObject({ status: "completed", reviewStatus: "confirmed", confirmationMode: "auto" });
      expect(lowJob).toMatchObject({ status: "needs_review", reviewStatus: "needs_review" });
      expect(lowJob?.confirmationMode).toBeUndefined();
    } finally {
      batches.close();
      runs.close();
      sessions.close();
    }
  });
});
