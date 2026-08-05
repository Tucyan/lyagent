import { randomUUID } from "node:crypto";
import type { PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { GradingSessionError, type GradingSession, type GradingSessionService } from "./grading-session-service.js";

export type SubmissionTitleAgentFactory = (sessionId: string, runId: string) => PiAssignmentGrader;

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
        throw new GradingSessionError("Submission naming tool was not called successfully");
      }
      return session;
    } catch (error: unknown) {
      await this.sessions.markSubmissionTitleFailed(sessionId);
      throw error;
    }
  }
}
