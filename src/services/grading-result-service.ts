import { createHash } from "node:crypto";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { finalizeGradingDraft, gradingDraftSchema, type GradingDraft, type GradingResult, type ReviewReason } from "../schemas/grading.js";
import type { GradingSession, GradingSessionService } from "./grading-session-service.js";
import type { RubricService } from "./rubric-service.js";

export interface StoredGradingDraft {
  version: number;
  result: GradingResult;
  updatedAt: string;
}

export interface GradingActor {
  type: "agent" | "teacher";
  id: string;
  note?: string;
}

export interface ConfirmedGradingResult {
  reviewStatus: "confirmed";
  version: number;
  result: GradingResult;
  reviewNote: string;
  acknowledgedReasons: ReviewReason[];
  confirmedAt: string;
  resultHash: string;
}

export class GradingResultServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingResultServiceError";
  }
}

export class GradingDraftConflictError extends GradingResultServiceError {
  constructor() {
    super("Grading draft version has changed; refresh before editing");
    this.name = "GradingDraftConflictError";
  }
}

export class GradingReviewRequiredError extends GradingResultServiceError {
  constructor() {
    super("Review note and acknowledgement of every review reason are required");
    this.name = "GradingReviewRequiredError";
  }
}

export class GradingResultService {
  private readonly filesystem: SafeFilesystem;
  private readonly now: () => string;
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(private readonly root: string, private readonly sessions: GradingSessionService, private readonly rubrics: RubricService, options: { now?: () => string } = {}) {
    this.filesystem = new SafeFilesystem(root, { allowedExtensions: new Set([".json", ".jsonl", ".md"]) });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async readDraft(sessionId: string): Promise<StoredGradingDraft | undefined> {
    const session = await this.sessions.getSession(sessionId);
    try {
      return JSON.parse(await this.filesystem.readText(this.draftPath(session))) as StoredGradingDraft;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async submitDraft(sessionId: string, expectedVersion: number, draft: unknown, actor: GradingActor): Promise<StoredGradingDraft> {
    return this.withSessionLock(sessionId, async () => {
    const session = await this.sessions.getSession(sessionId);
    if (session.gradingStatus === "confirmed") throw new GradingResultServiceError("Confirmed grading results are immutable");
    if (!["queued", "running", "waiting_for_teacher", "draft_ready", "needs_review"].includes(session.gradingStatus)) throw new GradingResultServiceError("Grading draft cannot be changed in the current session state");
    const existing = await this.readDraft(sessionId);
    if ((existing?.version ?? 0) !== expectedVersion) throw new GradingDraftConflictError();
    const frozen = await this.rubrics.getVersion(session.assignmentId, session.rubricVersion);
    if (frozen.hash !== session.rubricHash) throw new GradingResultServiceError("Frozen rubric hash does not match the grading session");
    const result = finalizeGradingDraft({ rubric: frozen.rubric, submission: await this.sessions.getLockedSubmission(sessionId), draft });
    const stored: StoredGradingDraft = { version: expectedVersion + 1, result, updatedAt: this.now() };
    await this.filesystem.writeText(this.draftPath(session), stringify(stored));
    if (actor.type === "teacher") {
      await this.appendAudit(session, {
        timestamp: stored.updatedAt,
        actor: { type: actor.type, id: actor.id },
        ...(actor.note ? { note: actor.note } : {}),
        beforeHash: existing ? hashJson(existing.result) : null,
        afterHash: hashJson(stored.result),
        expectedVersion,
        newVersion: stored.version,
        patch: { before: existing?.result.decisions ?? null, after: stored.result.decisions },
      });
    }
    await this.sessions.setGradingStatus(sessionId, result.review.requiresReview ? "needs_review" : "draft_ready");
    return stored;
    });
  }

  async confirm(sessionId: string, input: { expectedVersion: number; reviewNote: string; acknowledgedReasons: ReviewReason[] }): Promise<ConfirmedGradingResult> {
    return this.withSessionLock(sessionId, async () => {
    const session = await this.sessions.getSession(sessionId);
    const existing = await this.readConfirmed(session);
    if (existing) {
      await this.finishConfirmation(session, existing);
      return existing;
    }
    const draft = await this.readDraft(sessionId);
    if (!draft || draft.version !== input.expectedVersion) throw new GradingDraftConflictError();
    const reviewNote = input.reviewNote.trim();
    const missingReasons = draft.result.review.reasons.filter((reason) => !input.acknowledgedReasons.includes(reason));
    if (draft.result.review.requiresReview && (!reviewNote || missingReasons.length > 0)) throw new GradingReviewRequiredError();
    const confirmedAt = this.now();
    const withoutHash = {
      reviewStatus: "confirmed" as const,
      version: draft.version,
      result: draft.result,
      reviewNote,
      acknowledgedReasons: input.acknowledgedReasons,
      confirmedAt,
    };
    const confirmed: ConfirmedGradingResult = { ...withoutHash, resultHash: hashJson(withoutHash) };
    await this.filesystem.writeText(this.confirmCommitPath(session), stringify({ version: draft.version, resultHash: confirmed.resultHash }));
    await this.filesystem.writeText(this.confirmedJsonPath(session), stringify(confirmed));
    await this.finishConfirmation(session, confirmed);
    return confirmed;
    });
  }

  async readConfirmedResult(sessionId: string): Promise<ConfirmedGradingResult | undefined> {
    const session = await this.sessions.getSession(sessionId);
    const confirmed = await this.readConfirmed(session);
    if (confirmed) await this.finishConfirmation(session, confirmed);
    return confirmed;
  }

  async readConfirmedMarkdown(sessionId: string): Promise<string> {
    const session = await this.sessions.getSession(sessionId);
    if (!await this.readConfirmedResult(sessionId)) throw new GradingResultServiceError("Confirmed grading result was not found");
    return this.filesystem.readText(this.confirmedMarkdownPath(session));
  }

  private async readConfirmed(session: GradingSession): Promise<ConfirmedGradingResult | undefined> {
    try {
      const parsed = JSON.parse(await this.filesystem.readText(this.confirmedJsonPath(session))) as unknown;
      if (!isConfirmedGradingResult(parsed))
        throw new GradingResultServiceError("Confirmed grading result is invalid or its hash does not match");
      const { resultHash, ...withoutHash } = parsed;
      if (hashJson(withoutHash) !== resultHash)
        throw new GradingResultServiceError("Confirmed grading result hash does not match its contents");
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async appendAudit(session: GradingSession, event: Record<string, unknown>): Promise<void> {
    const auditPath = this.auditPath(session);
    let existing = "";
    try {
      existing = await this.filesystem.readText(auditPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.filesystem.writeText(auditPath, `${existing}${JSON.stringify(event)}\n`);
  }

  private async finishConfirmation(session: GradingSession, confirmed: ConfirmedGradingResult): Promise<void> {
    const frozen = await this.rubrics.getVersion(session.assignmentId, session.rubricVersion);
    await this.filesystem.writeText(this.confirmedMarkdownPath(session), renderStudentFeedback(confirmed, frozen.rubric));
    await this.sessions.setGradingStatus(session.id, "confirmed");
    await this.ensureConfirmationAudit(session, confirmed);
    await this.removeIfPresent(this.confirmCommitPath(session));
  }

  private async ensureConfirmationAudit(session: GradingSession, confirmed: ConfirmedGradingResult): Promise<void> {
    let existing = "";
    try {
      existing = await this.filesystem.readText(this.auditPath(session));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const alreadyRecorded = existing.split(/\r?\n/).filter(Boolean).some((line) => {
      try { const event = JSON.parse(line) as { action?: unknown; resultHash?: unknown }; return event.action === "confirm" && event.resultHash === confirmed.resultHash; } catch { return false; }
    });
    if (!alreadyRecorded) await this.appendAudit(session, { timestamp: confirmed.confirmedAt, actor: { type: "teacher", id: "local-teacher" }, action: "confirm", version: confirmed.version, resultHash: confirmed.resultHash, reviewNote: confirmed.reviewNote, acknowledgedReasons: confirmed.acknowledgedReasons });
  }

  private async removeIfPresent(relativePath: string): Promise<void> {
    try {
      await this.filesystem.removeFile(relativePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.sessionLocks.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === tail) this.sessionLocks.delete(sessionId);
    }
  }

  private resultBase(session: GradingSession): string {
    return `assignments/${session.assignmentId}/results/${session.batchId}`;
  }

  private draftPath(session: GradingSession): string { return `${this.resultBase(session)}/${session.studentKey}.draft.json`; }
  private confirmedJsonPath(session: GradingSession): string { return `${this.resultBase(session)}/${session.studentKey}.json`; }
  private confirmedMarkdownPath(session: GradingSession): string { return `${this.resultBase(session)}/${session.studentKey}.md`; }
  private confirmCommitPath(session: GradingSession): string { return `${this.resultBase(session)}/${session.studentKey}.confirm-commit.json`; }
  private auditPath(session: GradingSession): string { return `${this.resultBase(session)}/audit/${session.studentKey}.jsonl`; }
}

function isConfirmedGradingResult(value: unknown): value is ConfirmedGradingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const confirmed = value as Record<string, unknown>;
  if (confirmed.reviewStatus !== "confirmed"
    || !Number.isInteger(confirmed.version) || (confirmed.version as number) < 1
    || typeof confirmed.reviewNote !== "string"
    || typeof confirmed.confirmedAt !== "string" || !Number.isFinite(Date.parse(confirmed.confirmedAt))
    || typeof confirmed.resultHash !== "string" || !/^[a-f0-9]{64}$/u.test(confirmed.resultHash)
    || !Array.isArray(confirmed.acknowledgedReasons)) return false;
  const validReasons = new Set<ReviewReason>(["LOW_CONFIDENCE", "EVIDENCE_INSUFFICIENT", "CONVERSION_WARNING", "NEAR_PASSING_BOUNDARY"]);
  if (!confirmed.acknowledgedReasons.every((reason) => validReasons.has(reason as ReviewReason))) return false;
  if (!confirmed.result || typeof confirmed.result !== "object" || Array.isArray(confirmed.result)) return false;
  const result = confirmed.result as Record<string, unknown>;
  if (result.schemaVersion !== "1.0" || !["additive", "deductive", "hybrid"].includes(String(result.mode))
    || typeof result.submissionHash !== "string" || !/^[a-f0-9]{64}$/u.test(result.submissionHash)) return false;
  const score = result.score as Record<string, unknown> | null;
  const confidence = result.confidence as Record<string, unknown> | null;
  const review = result.review as Record<string, unknown> | null;
  if (!score || !Number.isFinite(score.earned) || !Number.isFinite(score.possible)
    || (score.earned as number) < 0 || (score.possible as number) < 0 || (score.earned as number) > (score.possible as number)
    || !confidence || !Number.isFinite(confidence.overall) || !Number.isFinite(confidence.minimum)
    || !Number.isInteger(confidence.lowCount) || (confidence.overall as number) < 0 || (confidence.overall as number) > 1
    || (confidence.minimum as number) < 0 || (confidence.minimum as number) > 1 || (confidence.lowCount as number) < 0
    || !review || typeof review.requiresReview !== "boolean" || !Array.isArray(review.reasons)
    || !review.reasons.every((reason) => validReasons.has(reason as ReviewReason))) return false;
  try {
    const decisions = gradingDraftSchema.parse(result.decisions);
    return decisions.mode === result.mode;
  } catch {
    return false;
  }
}

function renderStudentFeedback(confirmed: ConfirmedGradingResult, rubric: Awaited<ReturnType<RubricService["getVersion"]>>["rubric"]): string {
  const result = confirmed.result;
  const lines = ["# 作业评分反馈", "", `## 总分：${result.score.earned}/${result.score.possible}`, ""];
  if (result.decisions.mode === "additive" && rubric.mode === "additive") {
    lines.push("## 逐项评分", "");
    for (const decision of result.decisions.criteria) lines.push(`- **${rubric.criteria.find(({ id }) => id === decision.criterionId)?.name ?? decision.criterionId}**：${decision.score} 分。${decision.reason}`);
  } else if (result.decisions.mode === "deductive" && rubric.mode === "deductive") {
    lines.push("## 扣分判断", "");
    for (const decision of result.decisions.deductions) lines.push(`- **${rubric.rules.find(({ id }) => id === decision.ruleId)?.name ?? decision.ruleId}**：${decision.triggered ? `扣 ${decision.deduction} 分` : "未扣分"}。${decision.reason}`);
  } else if (result.decisions.mode === "hybrid" && rubric.mode === "hybrid") {
    lines.push("## 综合评分", "");
    for (const decision of result.decisions.criteria) lines.push(`- **${rubric.criteria.find(({ id }) => id === decision.criterionId)?.name ?? decision.criterionId}**：${decision.score} 分。${decision.reason}`);
    for (const decision of result.decisions.bonuses) lines.push(`- **${decision.ruleId}**：${decision.triggered ? `加 ${decision.bonus} 分` : "未加分"}。${decision.reason}`);
    for (const decision of result.decisions.deductions) lines.push(`- **${decision.ruleId}**：${decision.triggered ? `扣 ${decision.deduction} 分` : "未扣分"}。${decision.reason}`);
  }
  const decisions = result.decisions.mode === "additive"
    ? result.decisions.criteria
    : result.decisions.mode === "deductive"
      ? result.decisions.deductions
      : [...result.decisions.criteria, ...result.decisions.bonuses, ...result.decisions.deductions];
  const analyses = decisions.flatMap((decision) => decision.evidence
    .filter((item): item is Extract<typeof item, { kind: "analysis" }> => item.kind === "analysis")
    .map((item) => ({ id: "criterionId" in decision ? decision.criterionId : decision.ruleId, item })));
  if (analyses.length > 0) {
    lines.push("", "## 评分分析依据", "");
    for (const { id, item } of analyses) {
      lines.push(`### ${id}`, "", `- **作业表现：** ${item.observation}`, `- **标准对应：** ${item.rubricBasis}`, `- **分值理由：** ${item.scoreJustification}`, "");
    }
  }
  lines.push("", "## 主要优点", "", ...result.decisions.strengths.map((item) => `- ${item}`), "", "## 改进建议", "", ...result.decisions.improvements.map((item) => `- ${item}`), "");
  return lines.join("\n");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
