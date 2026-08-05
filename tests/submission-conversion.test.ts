import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversionTaskMissingError,
  ConversionUnavailableError,
  type ConversionTaskStatus,
  type DocumentConversionClient,
} from "../src/services/document-conversion-client.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import {
  SubmissionConversionService,
} from "../src/services/submission-conversion-service.js";

const roots: string[] = [];

async function setup(autoStart = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "submission-conversion-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({
    courseId: "11111111-1111-4111-8111-111111111111",
    title: "报告",
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
      {
        id: "missing",
        name: "缺失",
        condition: "缺失",
        deduction: 10,
        maxDeduction: 10,
        occurrence: "once",
        evidenceRequired: true,
      },
    ],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "report.pdf");
  await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({
    assignmentId: assignment.id,
    rubricVersion: frozen.version,
    studentName: "张晓明",
    studentNumber: "20260001",
    originalPath: source,
    originalFilename: "report.pdf",
    autoStartAfterConversion: autoStart,
  });
  return { root, rubrics, sessions, session };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function resultZip() {
  return {
    kind: "archive" as const,
    bytes: zipSync({
      "report/report.md": strToU8("# 转换报告\n\n![图表](images/chart.png)\n"),
      "report/images/chart.png": new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]),
    }),
  };
}

describe("SubmissionConversionService", () => {
  it("converts a queued submission and auto-queues grading only when configured", async () => {
    const { root, sessions, session } = await setup(true);
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => ({ taskId: "task-1", queuedAhead: 0 })),
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({
        status: "completed",
      })),
      result: vi.fn(async () => resultZip()),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });

    await conversion.process(session.id);

    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "ready",
      gradingStatus: "queued",
      submissionVersion: 1,
    });
    expect(await sessions.readSubmission(session.id)).toContain(
      "assets/chart.png",
    );
    expect(
      await sessions.readSubmissionAsset(session.id, "assets/chart.png"),
    ).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      status: "completed",
      externalTaskId: "task-1",
      attemptCount: 1,
    });
    sessions.close();
    expect(root).toBeTruthy();
  });

  it("resubmits from the immutable original when the converter loses a task", async () => {
    const { sessions, session } = await setup();
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ taskId: "lost" })
      .mockResolvedValueOnce({ taskId: "replacement" });
    const status = vi
      .fn()
      .mockRejectedValueOnce(new ConversionTaskMissingError())
      .mockResolvedValueOnce({ status: "completed" });
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit,
      status,
      result: vi.fn(async () => resultZip()),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 3,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });

    await conversion.process(session.id);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      status: "completed",
      externalTaskId: "replacement",
      attemptCount: 2,
    });
    sessions.close();
  });

  it("keeps a lost task retryable after the automatic retry budget is exhausted", async () => {
    const { sessions, session } = await setup();
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => ({ taskId: "lost" })),
      status: vi.fn(async () => {
        throw new ConversionTaskMissingError();
      }),
      result: vi.fn(),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 2,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });

    await conversion.process(session.id);
    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "waiting_for_converter",
      gradingStatus: "not_started",
      conversionError: { code: "CONVERTER_TASK_LOST", retryable: true },
    });
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      status: "failed",
      attemptCount: 2,
    });
    sessions.close();
  });

  it("retries converter outages with bounded backoff and preserves a retryable waiting state", async () => {
    const { sessions, session } = await setup();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => {
        throw new ConversionUnavailableError();
      }),
      status: vi.fn(),
      result: vi.fn(),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 3,
      retryDelaysMs: [5, 30],
      sleep,
    });

    await conversion.process(session.id);
    expect(client.submit).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5, 30]);
    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "waiting_for_converter",
      conversionAttemptCount: 3,
      conversionError: { code: "CONVERTER_UNAVAILABLE", retryable: true },
    });
    sessions.close();
  });

  it("retries transient status and result outages without resubmitting the task", async () => {
    const { sessions, session } = await setup();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const status = vi
      .fn()
      .mockRejectedValueOnce(new ConversionUnavailableError())
      .mockResolvedValue({ status: "completed" });
    const result = vi
      .fn()
      .mockRejectedValueOnce(new ConversionUnavailableError())
      .mockResolvedValue(resultZip());
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => ({ taskId: "stable-task" })),
      status,
      result,
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 3,
      retryDelaysMs: [5, 30],
      sleep,
    });

    await conversion.process(session.id);

    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5, 5]);
    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "ready",
    });
    sessions.close();
  });

  it("resubmits when a completed task disappears before result download", async () => {
    const { sessions, session } = await setup();
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ taskId: "vanished-task" })
      .mockResolvedValueOnce({ taskId: "replacement-task" });
    const result = vi
      .fn()
      .mockRejectedValueOnce(new ConversionTaskMissingError())
      .mockResolvedValue(resultZip());
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit,
      status: vi.fn(
        async (): Promise<ConversionTaskStatus> => ({ status: "completed" }),
      ),
      result,
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 3,
      sleep: async () => undefined,
    });

    await conversion.process(session.id);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      status: "completed",
      externalTaskId: "replacement-task",
      attemptCount: 2,
    });
    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "ready",
    });
    sessions.close();
  });

  it("marks explicit converter failures and unsafe results as distinct terminal states", async () => {
    const failedSetup = await setup();
    const failed = new SubmissionConversionService(
      failedSetup.sessions,
      {
        health: vi.fn(),
        submit: vi.fn(async () => ({ taskId: "failed-task" })),
        status: vi.fn(async (): Promise<ConversionTaskStatus> => ({
          status: "failed",
          error: "internal parser details",
        })),
        result: vi.fn(),
      },
      { sleep: async () => undefined },
    );
    await failed.process(failedSetup.session.id);
    expect(
      await failedSetup.sessions.getSession(failedSetup.session.id),
    ).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionError: { code: "CONVERSION_FAILED", retryable: false },
    });
    failedSetup.sessions.close();

    const rejectedSetup = await setup();
    const rejected = new SubmissionConversionService(
      rejectedSetup.sessions,
      {
        health: vi.fn(),
        submit: vi.fn(async () => ({ taskId: "unsafe-task" })),
        status: vi.fn(async (): Promise<ConversionTaskStatus> => ({
          status: "completed",
        })),
        result: vi.fn(async () => ({
          kind: "archive" as const,
          bytes: zipSync({ "../unsafe.md": strToU8("bad") }),
        })),
      },
      { sleep: async () => undefined },
    );
    await rejected.process(rejectedSetup.session.id);
    expect(
      await rejectedSetup.sessions.getSession(rejectedSetup.session.id),
    ).toMatchObject({
      conversionStatus: "result_rejected",
      conversionError: { code: "RESULT_REJECTED", retryable: false },
    });
    rejectedSetup.sessions.close();
  });

  it("marks a missing immutable original as a terminal controlled failure", async () => {
    const { root, sessions, session } = await setup();
    await rm(path.join(root, "assignments", session.assignmentId, "submissions", session.batchId), { recursive: true, force: true });
    const conversion = new SubmissionConversionService(sessions, {
      health: vi.fn(),
      submit: vi.fn(),
      status: vi.fn(),
      result: vi.fn(),
    });

    await conversion.process(session.id);

    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionError: { code: "ORIGINAL_UNAVAILABLE", retryable: false },
    });
    sessions.close();
  });

  it("resumes queued and running conversions after startup", async () => {
    const { sessions, session } = await setup();
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => ({ taskId: "task-1" })),
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({
        status: "completed",
      })),
      result: vi.fn(async () => resultZip()),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const process = vi.spyOn(conversion, "process");
    await conversion.resumePending();
    expect(process).toHaveBeenCalledWith(session.id);
    sessions.close();
  });
});
