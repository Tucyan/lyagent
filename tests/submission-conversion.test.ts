import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversionTaskFailedError,
  ConversionTaskMissingError,
  ConversionUnavailableError,
  type PublicFailureInfo,
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

function publicFailure(retryable: boolean): PublicFailureInfo {
  return {
    category: retryable ? "capacity" : "policy",
    message: "private provider failure detail",
    retryable,
    phase: "execution",
    details: { trace: "private trace" },
  };
}

describe("SubmissionConversionService", () => {
  it("allows deleting an exhausted conversion without retaining its session files", async () => {
    const { sessions, session } = await setup();
    const conversion = new SubmissionConversionService(sessions, {
      health: vi.fn(), submit: vi.fn(async () => { throw new ConversionUnavailableError(); }), status: vi.fn(), result: vi.fn(),
    }, { maxAttempts: 3, sleep: async () => undefined });
    try {
      await conversion.process(session.id);
      await expect(sessions.deleteSession(session.id)).resolves.toBeUndefined();
      await expect(sessions.getSession(session.id)).rejects.toThrow(/not found/i);
      expect(await sessions.listPendingConversions()).toEqual([]);
    } finally { sessions.close(); }
  });

  it("manually retries an exhausted conversion using the preserved original", async () => {
    const { sessions, session } = await setup();
    const submit = vi.fn(async (_original: { filename: string; bytes: Uint8Array }) => { throw new ConversionUnavailableError(); });
    const conversion = new SubmissionConversionService(sessions, {
      health: vi.fn(), submit, status: vi.fn(), result: vi.fn(),
    }, { maxAttempts: 1, sleep: async () => undefined });
    try {
      await conversion.process(session.id);
      expect((await sessions.getSession(session.id)).conversionStatus).toBe("conversion_failed");
      await conversion.process(session.id);
      expect(submit).toHaveBeenCalledTimes(1);
      await sessions.retryConversion(session.id);
      const recovered = new SubmissionConversionService(sessions, {
        health: vi.fn(), submit: async (original) => {
          expect(original).toEqual(submit.mock.calls[0]![0]);
          return { taskId: "recovered" };
        }, status: async () => ({ status: "completed" }), result: async () => resultZip(),
      });
      await recovered.process(session.id);
      expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "ready", conversionAttemptCount: 1 });
    } finally { sessions.close(); }
  });

  it("recovers a legacy exhausted waiting session into a deletable failed state", async () => {
    const { sessions, session } = await setup();
    try {
      await sessions.beginConversionAttempt(session.id);
      await sessions.recordConversionFailure(session.id, { status: "waiting_for_converter", code: "CONVERTER_UNAVAILABLE", message: "Converter unavailable", retryable: true });
      const submit = vi.fn();
      await new SubmissionConversionService(sessions, { health: vi.fn(), submit, status: vi.fn(), result: vi.fn() }, { maxAttempts: 1 }).resumePending();
      expect(submit).not.toHaveBeenCalled();
      expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "conversion_failed", conversionError: { retryable: true } });
      await expect(sessions.deleteSession(session.id)).resolves.toBeUndefined();
    } finally { sessions.close(); }
  });

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

  it("resubmits the immutable original after a retryable task status failure", async () => {
    const { sessions, session } = await setup();
    const submit = vi.fn()
      .mockResolvedValueOnce({ taskId: "failed-task" })
      .mockResolvedValueOnce({ taskId: "replacement-task" });
    const status = vi.fn()
      .mockResolvedValueOnce({ status: "failed", failure: publicFailure(true) })
      .mockResolvedValueOnce({ status: "completed" });
    const conversion = new SubmissionConversionService(sessions, {
      health: vi.fn(), submit, status, result: vi.fn(async () => resultZip()),
    }, { maxAttempts: 3, sleep: async () => undefined });

    await conversion.process(session.id);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
    expect(await sessions.getSession(session.id)).toMatchObject({ conversionStatus: "ready" });
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      externalTaskId: "replacement-task", attemptCount: 2,
    });
    sessions.close();
  });

  it("bounds retryable task status failure resubmission and keeps provider text private", async () => {
    const { sessions, session } = await setup();
    const client: DocumentConversionClient = {
      health: vi.fn(),
      submit: vi.fn(async () => ({ taskId: "failed-task" })),
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({
        status: "failed", failure: publicFailure(true),
      })),
      result: vi.fn(),
    };
    const conversion = new SubmissionConversionService(sessions, client, {
      maxAttempts: 2, sleep: async () => undefined,
    });

    await conversion.process(session.id);

    expect(client.submit).toHaveBeenCalledTimes(2);
    const saved = await sessions.getSession(session.id);
    expect(saved).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionAttemptCount: 2,
      conversionError: { code: "CONVERSION_FAILED", retryable: true },
    });
    expect(saved.conversionError?.message).not.toContain("private provider failure detail");
    sessions.close();
  });

  it("resubmits after a retryable result failure and terminates a non-retryable result failure", async () => {
    const retryableSetup = await setup();
    const retrySubmit = vi.fn()
      .mockResolvedValueOnce({ taskId: "failed-result" })
      .mockResolvedValueOnce({ taskId: "replacement-result" });
    const retryResult = vi.fn()
      .mockRejectedValueOnce(new ConversionTaskFailedError(publicFailure(true)))
      .mockResolvedValueOnce(resultZip());
    const retryConversion = new SubmissionConversionService(retryableSetup.sessions, {
      health: vi.fn(), submit: retrySubmit,
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({ status: "completed" })),
      result: retryResult,
    }, { maxAttempts: 3, sleep: async () => undefined });

    await retryConversion.process(retryableSetup.session.id);
    expect(retrySubmit).toHaveBeenCalledTimes(2);
    expect(retrySubmit.mock.calls[1]?.[0]).toEqual(retrySubmit.mock.calls[0]?.[0]);
    expect(await retryableSetup.sessions.getSession(retryableSetup.session.id))
      .toMatchObject({ conversionStatus: "ready" });
    retryableSetup.sessions.close();

    const terminalSetup = await setup();
    const terminalConversion = new SubmissionConversionService(terminalSetup.sessions, {
      health: vi.fn(), submit: vi.fn(async () => ({ taskId: "terminal-result" })),
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({ status: "completed" })),
      result: vi.fn(async () => { throw new ConversionTaskFailedError(publicFailure(false)); }),
    }, { sleep: async () => undefined });
    await terminalConversion.process(terminalSetup.session.id);
    const terminal = await terminalSetup.sessions.getSession(terminalSetup.session.id);
    expect(terminal).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionError: { code: "CONVERSION_FAILED", retryable: false },
    });
    expect(terminal.conversionError?.message).not.toContain("private provider failure detail");
    terminalSetup.sessions.close();
  });

  it("bounds retryable TaskFailureResult resubmission", async () => {
    const { sessions, session } = await setup();
    const submit = vi.fn(async () => ({ taskId: "failed-result" }));
    const conversion = new SubmissionConversionService(sessions, {
      health: vi.fn(),
      submit,
      status: vi.fn(async (): Promise<ConversionTaskStatus> => ({ status: "completed" })),
      result: vi.fn(async () => { throw new ConversionTaskFailedError(publicFailure(true)); }),
    }, { maxAttempts: 2, sleep: async () => undefined });

    await conversion.process(session.id);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(await sessions.getSession(session.id)).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionAttemptCount: 2,
      conversionError: { code: "CONVERSION_FAILED", retryable: true },
    });
    sessions.close();
  });

  it("rejects resource-bearing raw HTML before converted Markdown is persisted", async () => {
    const { sessions, session } = await setup();
    for (const markdown of [
      '<sVg><ImAgE XLINK:HREF = "&#x68;ttps://example.com/a.svg"></svg>',
      '<OBJECT DaTa =https://example.com/a>',
      '<embed/src=https://example.com/a>',
      '<IFRAME\nSRC = https://example.com/a',
      '<VIDEO poster=https://example.com/a>',
      '<AuDiO><SoUrCe SRCSET=https://example.com/a>',
      '<&#111;bject data=https://example.com/a>',
      '<script src=https://example.com/a>',
    ]) {
      await expect(sessions.completeConversion(session.id, { markdown, assets: [] }))
        .rejects.toThrow(/resource-bearing raw HTML/i);
    }
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
      conversionStatus: "conversion_failed",
      gradingStatus: "not_started",
      conversionError: { code: "CONVERTER_TASK_LOST", retryable: true },
    });
    expect(await sessions.getConversionJob(session.id)).toMatchObject({
      status: "failed",
      attemptCount: 2,
    });
    sessions.close();
  });

  it("retries converter outages with bounded backoff and finishes in a retryable failed state", async () => {
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
      conversionStatus: "conversion_failed",
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
          failure: publicFailure(false),
        })),
        result: vi.fn(),
      },
      { sleep: async () => undefined },
    );
    await failed.process(failedSetup.session.id);
    const terminalStatusFailure = await failedSetup.sessions.getSession(
      failedSetup.session.id,
    );
    expect(terminalStatusFailure).toMatchObject({
      conversionStatus: "conversion_failed",
      conversionError: { code: "CONVERSION_FAILED", retryable: false },
    });
    expect(terminalStatusFailure.conversionError?.message)
      .not.toContain("private provider failure detail");
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
