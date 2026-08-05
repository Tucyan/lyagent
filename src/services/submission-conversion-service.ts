import {
  ConversionTaskMissingError,
  ConversionUnavailableError,
  type ConversionTaskStatus,
  type DocumentConversionClient,
} from "./document-conversion-client.js";
import { importConversionResult } from "./conversion-result.js";
import type { GradingSessionService } from "./grading-session-service.js";

export interface SubmissionConversionOptions {
  pollIntervalMs?: number;
  taskTimeoutSeconds?: number;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}

export class SubmissionConversionService {
  private readonly pollIntervalMs: number;
  private readonly taskTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: GradingSessionService,
    private readonly client: DocumentConversionClient,
    options: SubmissionConversionOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.taskTimeoutMs = (options.taskTimeoutSeconds ?? 3_600) * 1_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 30_000, 120_000];
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.nowMs = options.nowMs ?? Date.now;
  }

  process(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const running = this.processUnlocked(sessionId).finally(() =>
      this.active.delete(sessionId),
    );
    this.active.set(sessionId, running);
    return running;
  }

  async resumePending(): Promise<void> {
    for (const session of await this.sessions.listPendingConversions())
      await this.process(session.id);
  }

  private async processUnlocked(sessionId: string): Promise<void> {
    let session = await this.sessions.getSession(sessionId);
    if (session.conversionStatus === "ready") return;
    if (
      session.conversionStatus === "conversion_failed" ||
      session.conversionStatus === "result_rejected"
    )
      return;
    if (
      session.conversionStatus === "waiting_for_converter" &&
      session.conversionAttemptCount >= this.maxAttempts
    )
      return;
    let original: Awaited<ReturnType<GradingSessionService["readOriginal"]>>;
    try {
      original = await this.sessions.readOriginal(sessionId);
    } catch {
      await this.sessions.recordConversionFailure(sessionId, {
        status: "conversion_failed",
        code: "ORIGINAL_UNAVAILABLE",
        message: "原始作业文件不可用，请重新上传文件创建新会话。",
        retryable: false,
      });
      return;
    }
    let job = await this.sessions.getConversionJob(sessionId);
    let taskId = job?.externalTaskId;
    if (!taskId) {
      while (!taskId) {
        session = await this.sessions.beginConversionAttempt(sessionId);
        try {
          const submitted = await this.client.submit(original);
          taskId = submitted.taskId;
          job = await this.sessions.recordConversionTask(sessionId, taskId);
        } catch (error: unknown) {
          if (!(error instanceof ConversionUnavailableError)) {
            await this.sessions.recordConversionFailure(
              sessionId,
              conversionFailed(),
            );
            return;
          }
          const delay = this.retryDelay(session.conversionAttemptCount);
          await this.sessions.recordConversionFailure(
            sessionId,
            converterUnavailable(
              delay === undefined ? undefined : this.nextRetryAt(delay),
            ),
          );
          if (
            delay === undefined ||
            session.conversionAttemptCount >= this.maxAttempts
          )
            return;
          await this.sleep(delay);
        }
      }
    }
    const startedAt = this.nowMs();
    let transientFailures = 0;
    while (true) {
      if (this.nowMs() - startedAt > this.taskTimeoutMs) {
        await this.sessions.recordConversionFailure(sessionId, {
          status: "waiting_for_converter",
          code: "CONVERSION_TIMEOUT",
          message: "转换服务处理超时，原始作业已安全保存。",
          retryable: true,
        });
        return;
      }
      let status: ConversionTaskStatus;
      try {
        status = await this.client.status(taskId);
      } catch (error: unknown) {
        if (!(error instanceof ConversionTaskMissingError)) {
          if (error instanceof ConversionUnavailableError) {
            transientFailures += 1;
            const delay = this.transientRetryDelay(transientFailures);
            await this.sessions.recordConversionFailure(
              sessionId,
              converterUnavailable(
                delay === undefined ? undefined : this.nextRetryAt(delay),
              ),
            );
            if (delay === undefined) return;
            await this.sleep(delay);
            continue;
          } else {
            await this.sessions.recordConversionFailure(
              sessionId,
              conversionFailed(),
            );
          }
          return;
        }
        job = await this.sessions.getConversionJob(sessionId);
        if ((job?.attemptCount ?? 0) >= this.maxAttempts) {
          await this.sessions.recordConversionFailure(sessionId, {
            status: "waiting_for_converter",
            code: "CONVERTER_TASK_LOST",
            message: "转换任务暂时不可恢复，原始作业已安全保存，可稍后重试。",
            retryable: true,
          });
          return;
        }
        session = await this.sessions.beginConversionAttempt(sessionId);
        try {
          const submitted = await this.client.submit(original);
          taskId = submitted.taskId;
          job = await this.sessions.recordConversionTask(sessionId, taskId);
        } catch (error: unknown) {
          if (error instanceof ConversionUnavailableError)
            await this.sessions.recordConversionFailure(
              sessionId,
              converterUnavailable(),
            );
          else
            await this.sessions.recordConversionFailure(
              sessionId,
              conversionFailed(),
            );
          return;
        }
        continue;
      }
      transientFailures = 0;
      if (status.status === "failed") {
        await this.sessions.recordConversionFailure(
          sessionId,
          conversionFailed(),
        );
        return;
      }
      if (status.status === "completed") {
        let taskReplaced = false;
        while (!taskReplaced) {
          try {
            const imported = importConversionResult(
              await this.client.result(taskId),
            );
            await this.sessions.completeConversion(sessionId, imported);
            return;
          } catch (error: unknown) {
            if (error instanceof ConversionUnavailableError) {
              transientFailures += 1;
              const delay = this.transientRetryDelay(transientFailures);
              await this.sessions.recordConversionFailure(
                sessionId,
                converterUnavailable(
                  delay === undefined ? undefined : this.nextRetryAt(delay),
                ),
              );
              if (delay === undefined) return;
              await this.sleep(delay);
              continue;
            }
            if (error instanceof ConversionTaskMissingError) {
              job = await this.sessions.getConversionJob(sessionId);
              if ((job?.attemptCount ?? 0) >= this.maxAttempts) {
                await this.sessions.recordConversionFailure(sessionId, {
                  status: "waiting_for_converter",
                  code: "CONVERTER_TASK_LOST",
                  message:
                    "转换任务暂时不可恢复，原始作业已安全保存，可稍后重试。",
                  retryable: true,
                });
                return;
              }
              await this.sessions.beginConversionAttempt(sessionId);
              try {
                const submitted = await this.client.submit(original);
                taskId = submitted.taskId;
                job = await this.sessions.recordConversionTask(
                  sessionId,
                  taskId,
                );
                transientFailures = 0;
                taskReplaced = true;
                continue;
              } catch (submitError: unknown) {
                if (submitError instanceof ConversionUnavailableError)
                  await this.sessions.recordConversionFailure(
                    sessionId,
                    converterUnavailable(),
                  );
                else
                  await this.sessions.recordConversionFailure(
                    sessionId,
                    conversionFailed(),
                  );
                return;
              }
            }
            await this.sessions.recordConversionFailure(sessionId, {
              status: "result_rejected",
              code: "RESULT_REJECTED",
              message:
                "转换结果未通过安全或格式校验，请重新上传文件或联系管理员。",
              retryable: false,
            });
            return;
          }
        }
        continue;
      }
      if (status.status !== "queued" && status.status !== "running") {
        await this.sessions.recordConversionFailure(sessionId, {
          status: "conversion_failed",
          code: "INTERNAL_CONVERSION_ERROR",
          message:
            "转换服务返回了无法识别的任务状态，请重新上传文件或联系管理员。",
          retryable: false,
        });
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private retryDelay(attemptCount: number): number | undefined {
    if (attemptCount >= this.maxAttempts) return undefined;
    return this.retryDelaysMs[
      Math.min(attemptCount - 1, this.retryDelaysMs.length - 1)
    ];
  }

  private transientRetryDelay(failureCount: number): number | undefined {
    if (failureCount >= this.maxAttempts) return undefined;
    return this.retryDelaysMs[
      Math.min(failureCount - 1, this.retryDelaysMs.length - 1)
    ];
  }

  private nextRetryAt(delay: number): string {
    return new Date(this.nowMs() + delay).toISOString();
  }
}

function converterUnavailable(nextRetryAt?: string) {
  return {
    status: "waiting_for_converter" as const,
    code: "CONVERTER_UNAVAILABLE" as const,
    message: "转换服务当前不可用，原始作业已安全保存。",
    retryable: true,
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

function conversionFailed() {
  return {
    status: "conversion_failed" as const,
    code: "CONVERSION_FAILED" as const,
    message: "转换服务无法解析该文件，请检查文件是否损坏、加密或不受支持。",
    retryable: false,
  };
}
