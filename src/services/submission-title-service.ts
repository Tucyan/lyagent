import { randomUUID } from "node:crypto";
import type { PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { GradingSessionError, type GradingSession, type GradingSessionService } from "./grading-session-service.js";

export type SubmissionTitleAgentFactory = (sessionId: string, runId: string) => PiAssignmentGrader;

export class SubmissionTitleError extends GradingSessionError {
  constructor(
    readonly code: "SUBMISSION_TITLE_MODEL_FAILED" | "SUBMISSION_TITLE_TOOL_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "SubmissionTitleError";
  }
}

export class SubmissionTitleService {
  private readonly active = new Map<string, Promise<GradingSession>>();

  constructor(private readonly sessions: GradingSessionService, private readonly createAgent: SubmissionTitleAgentFactory) {}

  async resolve(sessionId: string): Promise<GradingSession> {
    const session = await this.sessions.getSession(sessionId);
    if (session.submissionTitleStatus === "provided" || session.submissionTitleStatus === "resolved") return session;
    if (session.conversionStatus !== "ready") throw new GradingSessionError("Submission title can only be resolved after conversion");
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const running = this.resolveUnlocked(sessionId).finally(() => this.active.delete(sessionId));
    this.active.set(sessionId, running);
    return running;
  }

  private async resolveUnlocked(sessionId: string): Promise<GradingSession> {
    try {
      await this.sessions.beginSubmissionTitleResolution(sessionId);
      const runId = randomUUID();
      const outcome = await this.createAgent(sessionId, runId).run({ kind: "name", message: "请识别并保存当前学生作业名称。" }, undefined, undefined);
      const session = await this.sessions.getSession(sessionId);
      if (outcome.kind !== "title" || session.submissionTitleStatus !== "resolved" || session.submissionTitle !== outcome.title) {
        throw new SubmissionTitleError(
          "SUBMISSION_TITLE_TOOL_MISSING",
          "作业名称识别未返回有效结果，请重试",
        );
      }
      return session;
    } catch (error: unknown) {
      const safe = error instanceof SubmissionTitleError
        ? error
        : new SubmissionTitleError(
            "SUBMISSION_TITLE_MODEL_FAILED",
            "作业名称识别失败，请重试",
          );
      await this.sessions.markSubmissionTitleFailed(sessionId, {
        code: safe.code,
        message: safe.message,
      });
      throw safe;
    }
  }
}
