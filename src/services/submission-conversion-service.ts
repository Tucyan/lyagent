import { importMineruResult, MineruError, MineruTaskMissingError, type MineruTaskStatus } from "./mineru-client.js";
import { GradingSessionError, type GradingSessionService } from "./grading-session-service.js";

export interface MineruConversionClient {
  submit(input: { filename: string; bytes: Uint8Array }): Promise<{ taskId: string; queuedAhead?: number }>;
  status(taskId: string): Promise<MineruTaskStatus>;
  result(taskId: string): Promise<Uint8Array>;
}

export interface SubmissionConversionOptions {
  pollIntervalMs?: number;
  taskTimeoutSeconds?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}

export class SubmissionConversionService {
  private readonly pollIntervalMs: number;
  private readonly taskTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly sessions: GradingSessionService, private readonly client: MineruConversionClient, options: SubmissionConversionOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.taskTimeoutMs = (options.taskTimeoutSeconds ?? 3_600) * 1_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.nowMs = options.nowMs ?? Date.now;
  }

  process(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const running = this.processUnlocked(sessionId).finally(() => this.active.delete(sessionId));
    this.active.set(sessionId, running);
    return running;
  }

  async resumePending(): Promise<void> {
    for (const session of await this.sessions.listPendingConversions()) await this.process(session.id);
  }

  private async processUnlocked(sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (session.conversionStatus === "ready") return;
    const original = await this.sessions.readOriginal(sessionId);
    let job = await this.sessions.getConversionJob(sessionId);
    let taskId = job?.externalTaskId;
    if (!taskId) {
      try {
        const submitted = await this.client.submit(original);
        taskId = submitted.taskId;
        job = await this.sessions.recordConversionTask(sessionId, taskId);
      } catch (error: unknown) {
        await this.sessions.failConversion(sessionId);
        throw error;
      }
    }
    const startedAt = this.nowMs();
    while (true) {
      if (this.nowMs() - startedAt > this.taskTimeoutMs) {
        await this.sessions.failConversion(sessionId);
        throw new MineruError("MinerU conversion timed out");
      }
      let status: MineruTaskStatus;
      try {
        status = await this.client.status(taskId);
      } catch (error: unknown) {
        if (!(error instanceof MineruTaskMissingError)) {
          await this.sessions.failConversion(sessionId);
          throw error;
        }
        job = await this.sessions.getConversionJob(sessionId);
        if ((job?.attemptCount ?? 0) >= this.maxAttempts) {
          await this.sessions.failConversion(sessionId);
          throw new MineruError("MinerU conversion retry budget was exhausted");
        }
        const submitted = await this.client.submit(original);
        taskId = submitted.taskId;
        job = await this.sessions.recordConversionTask(sessionId, taskId);
        continue;
      }
      if (status.status === "failed") {
        await this.sessions.failConversion(sessionId);
        throw new MineruError(status.error || "MinerU conversion failed");
      }
      if (status.status === "completed") {
        try {
          const imported = importMineruResult(await this.client.result(taskId));
          await this.sessions.completeConversion(sessionId, imported);
          return;
        } catch (error: unknown) {
          await this.sessions.failConversion(sessionId);
          throw error;
        }
      }
      if (status.status !== "queued" && status.status !== "running") throw new GradingSessionError("MinerU returned an unknown task state");
      await this.sleep(this.pollIntervalMs);
    }
  }
}
