import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MineruTaskMissingError, type MineruTaskStatus } from "../src/services/mineru-client.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import { SubmissionConversionService, type MineruConversionClient } from "../src/services/submission-conversion-service.js";

const roots: string[] = [];

async function setup(autoStart = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "submission-conversion-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "报告", totalScore: 100, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, { schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [], rules: [{ id: "missing", name: "缺失", condition: "缺失", deduction: 10, maxDeduction: 10, occurrence: "once", evidenceRequired: true }] });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.pdf");
  await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.pdf", autoStartAfterConversion: autoStart });
  return { root, rubrics, sessions, session };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function resultZip() {
  return zipSync({ "report/report.md": strToU8("# 转换报告\n\n![图表](images/chart.png)\n"), "report/images/chart.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
}

describe("SubmissionConversionService", () => {
  it("converts a queued submission and auto-queues grading only when configured", async () => {
    const { root, sessions, session } = await setup(true);
    const client: MineruConversionClient = {
      submit: vi.fn(async () => ({ taskId: "task-1", queuedAhead: 0 })),
      status: vi.fn(async (): Promise<MineruTaskStatus> => ({ status: "completed" })),
      result: vi.fn(async () => resultZip()),
    };
    const conversion = new SubmissionConversionService(sessions, client, { pollIntervalMs: 1, sleep: async () => undefined });

    await conversion.process(session.id);

    expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "ready", gradingStatus: "queued", submissionVersion: 1 });
    expect(await sessions.readSubmission(session.id)).toContain("assets/chart.png");
    expect(await sessions.readSubmissionAsset(session.id, "assets/chart.png")).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await sessions.getConversionJob(session.id)).toMatchObject({ status: "completed", externalTaskId: "task-1", attemptCount: 1 });
    sessions.close();
    expect(root).toBeTruthy();
  });

  it("resubmits from the immutable original when MinerU loses a task", async () => {
    const { sessions, session } = await setup();
    const submit = vi.fn()
      .mockResolvedValueOnce({ taskId: "lost" })
      .mockResolvedValueOnce({ taskId: "replacement" });
    const status = vi.fn()
      .mockRejectedValueOnce(new MineruTaskMissingError())
      .mockResolvedValueOnce({ status: "completed" });
    const client: MineruConversionClient = { submit, status, result: vi.fn(async () => resultZip()) };
    const conversion = new SubmissionConversionService(sessions, client, { maxAttempts: 3, pollIntervalMs: 1, sleep: async () => undefined });

    await conversion.process(session.id);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(await sessions.getConversionJob(session.id)).toMatchObject({ status: "completed", externalTaskId: "replacement", attemptCount: 2 });
    sessions.close();
  });

  it("marks conversion failed after the retry budget is exhausted", async () => {
    const { sessions, session } = await setup();
    const client: MineruConversionClient = {
      submit: vi.fn(async () => ({ taskId: "lost" })),
      status: vi.fn(async () => { throw new MineruTaskMissingError(); }),
      result: vi.fn(),
    };
    const conversion = new SubmissionConversionService(sessions, client, { maxAttempts: 2, pollIntervalMs: 1, sleep: async () => undefined });

    await expect(conversion.process(session.id)).rejects.toThrow(/retry budget/i);
    expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "failed", gradingStatus: "not_started" });
    expect(await sessions.getConversionJob(session.id)).toMatchObject({ status: "failed", attemptCount: 2 });
    sessions.close();
  });

  it("marks conversion failed when the initial MinerU submission fails", async () => {
    const { sessions, session } = await setup();
    const client: MineruConversionClient = {
      submit: vi.fn(async () => { throw new Error("MinerU unavailable"); }),
      status: vi.fn(),
      result: vi.fn(),
    };
    const conversion = new SubmissionConversionService(sessions, client);

    await expect(conversion.process(session.id)).rejects.toThrow("MinerU unavailable");
    expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "failed", gradingStatus: "not_started" });
    sessions.close();
  });

  it("resumes queued and running conversions after startup", async () => {
    const { sessions, session } = await setup();
    const client: MineruConversionClient = { submit: vi.fn(async () => ({ taskId: "task-1" })), status: vi.fn(async (): Promise<MineruTaskStatus> => ({ status: "completed" })), result: vi.fn(async () => resultZip()) };
    const conversion = new SubmissionConversionService(sessions, client, { pollIntervalMs: 1, sleep: async () => undefined });
    const process = vi.spyOn(conversion, "process");
    await conversion.resumePending();
    expect(process).toHaveBeenCalledWith(session.id);
    sessions.close();
  });
});
