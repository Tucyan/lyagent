import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import PQueue from "p-queue";
import type { GradingAgentEvent, GradingAgentOutcome, PiAssignmentGrader } from "../agents/assignment-grader/agent.js";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import { GradingConflictError, type GradingSession, type GradingSessionService } from "./grading-session-service.js";

export type GradingRunStatus = "queued" | "running" | "completed" | "waiting_for_teacher" | "failed" | "cancelled";

export interface GradingRun {
  id: string;
  sessionId: string;
  kind: "grade" | "chat";
  message: string;
  status: GradingRunStatus;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  session_id: string;
  kind: "grade" | "chat";
  input_message: string;
  status: GradingRunStatus;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface GradingRunEvent {
  sequence: number;
  type: GradingAgentEvent["type"] | "final" | "error" | "cancelled";
  [key: string]: unknown;
}

export interface GradingConversationTool {
  id: string;
  name: string;
  label: string;
  summary: string;
  status: "completed" | "failed";
}

export type GradingConversationMessage =
  | { role: "user"; content: string; runId: string; createdAt: string }
  | { role: "assistant"; content: string; runId: string; process: string; processCollapsed: true; tools: GradingConversationTool[]; options?: string[]; createdAt: string };

export interface GradingConversation {
  sessionId: string;
  messages: GradingConversationMessage[];
  updatedAt: string;
}

export type GradingAgentFactory = (sessionId: string, runId: string) => PiAssignmentGrader;

export class GradingRunService {
  private readonly database: Database.Database;
  private readonly filesystem: SafeFilesystem;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => string;

  constructor(private readonly root: string, private readonly sessions: GradingSessionService, private readonly graderFactory: GradingAgentFactory, options: { now?: () => string } = {}) {
    this.database = new Database(path.join(path.resolve(root), "grading.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.filesystem = new SafeFilesystem(root, { allowedExtensions: new Set([".json"]) });
    this.now = options.now ?? (() => new Date().toISOString());
    this.recoverInterruptedRuns();
  }

  async start(sessionId: string, input: { kind: "grade" | "chat"; message: string }): Promise<GradingRun> {
    const session = await this.sessions.getSession(sessionId);
    if (input.kind === "grade" && session.gradingStatus !== "queued") throw new GradingConflictError("A grading run cannot start in the current session state");
    if (input.kind === "chat" && (session.conversionStatus !== "ready" || !["not_started", "queued", "waiting_for_teacher", "draft_ready", "needs_review", "failed"].includes(session.gradingStatus))) {
      throw new GradingConflictError("A grading conversation cannot continue in the current session state");
    }
    const message = input.message.trim();
    if (!message || message.length > 8_000) throw new Error("Grading message must contain between 1 and 8000 characters");
    const id = randomUUID();
    const now = this.now();
    const insert = this.database.transaction(() => {
      const active = this.database.prepare("SELECT id FROM agent_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1").get(sessionId);
      if (active) throw new GradingConflictError("A grading run is already active for this session");
      const inserted = this.database
        .prepare(
          `INSERT INTO agent_runs (id, session_id, kind, input_message, status, created_at, updated_at)
           SELECT ?, id, ?, ?, 'queued', ?, ? FROM grading_sessions
           WHERE id = ? AND deletion_pending = 0`,
        )
        .run(id, input.kind, message, now, now, sessionId);
      if (inserted.changes !== 1)
        throw new GradingConflictError(
          "The grading session is being deleted",
        );
    });
    insert();
    await this.appendConversation(sessionId, { role: "user", content: message, runId: id, createdAt: now });
    await this.sessions.setActiveRun(sessionId, id);
    void this.queue.add(async () => this.execute(id)).catch(() => undefined);
    return this.getRun(id);
  }

  async getRun(runId: string): Promise<GradingRun> {
    const row = this.database.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error("Grading run was not found");
    return fromRunRow(row);
  }

  async listEvents(runId: string, afterSequence: number): Promise<GradingRunEvent[]> {
    await this.getRun(runId);
    const rows = this.database.prepare("SELECT sequence, event_type, payload_json FROM agent_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, afterSequence) as Array<{ sequence: number; event_type: GradingRunEvent["type"]; payload_json: string }>;
    return rows.map((row) => ({ sequence: row.sequence, type: row.event_type, ...(JSON.parse(row.payload_json) as Record<string, unknown>) }));
  }

  async waitForTerminal(runId: string, timeoutMs = 5_000): Promise<GradingRun> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const run = await this.getRun(runId);
      if (["completed", "waiting_for_teacher", "failed", "cancelled"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for grading run");
  }

  async cancel(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    if (["completed", "waiting_for_teacher", "failed", "cancelled"].includes(run.status)) return false;
    this.controllers.get(runId)?.abort();
    await this.finishRun(runId, "cancelled");
    await this.appendEvent(runId, "cancelled", { message: "运行已取消" });
    if (run.kind === "grade") await this.sessions.setGradingStatus(run.sessionId, "cancelled");
    else await this.sessions.clearActiveRun(run.sessionId, runId);
    return true;
  }

  async getConversation(sessionId: string): Promise<GradingConversation> {
    const session = await this.sessions.getSession(sessionId);
    try {
      return JSON.parse(await this.filesystem.readText(this.conversationPath(session))) as GradingConversation;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId, messages: [], updatedAt: session.updatedAt };
      throw error;
    }
  }

  close(): void {
    this.queue.pause();
    for (const controller of this.controllers.values()) controller.abort();
    if (this.database.open) this.database.close();
  }

  private async execute(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run.status === "cancelled") return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    await this.updateRun(runId, "running");
    if (run.kind === "grade") await this.sessions.setGradingStatus(run.sessionId, "running", runId);
    else await this.sessions.setActiveRun(run.sessionId, runId);
    let process = "";
    let reply = "";
    const tools = new Map<string, GradingConversationTool>();
    let eventTail = Promise.resolve();
    const onEvent = (event: GradingAgentEvent) => {
      if (event.type === "process_delta") process += event.delta;
      if (event.type === "reply_delta") reply += event.delta;
      if (event.type === "tool_start") tools.set(event.id, { id: event.id, name: event.name, label: event.label, summary: event.summary, status: "completed" });
      if (event.type === "tool_end") tools.set(event.id, { id: event.id, name: event.name, label: event.label, summary: event.summary, status: event.status });
      eventTail = eventTail.then(() => this.appendEvent(runId, event.type, safeEventPayload(event)));
    };
    try {
      const conversation = await this.getConversation(run.sessionId);
      const history = conversation.messages.filter(({ runId: messageRunId }) => messageRunId !== runId).slice(-12).map(({ role, content }) => ({ role, content: content.slice(0, 2_000) }));
      const outcome = await this.graderFactory(run.sessionId, runId).run({ kind: run.kind, message: run.message, history }, onEvent, controller.signal);
      await eventTail;
      if ((await this.getRun(runId)).status === "cancelled") return;
      await this.persistOutcome(run, outcome, process, reply, [...tools.values()]);
    } catch (error: unknown) {
      await eventTail;
      if ((await this.getRun(runId)).status === "cancelled" || isAbort(error)) return;
      await this.finishRun(runId, "failed", "GRADING_RUN_FAILED");
      await this.appendEvent(runId, "error", { code: "GRADING_RUN_FAILED", message: "批改运行未能完成" });
      if (run.kind === "grade") await this.sessions.setGradingStatus(run.sessionId, "failed");
      else await this.sessions.clearActiveRun(run.sessionId, runId);
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async persistOutcome(run: GradingRun, outcome: GradingAgentOutcome, process: string, streamedReply: string, tools: GradingConversationTool[]): Promise<void> {
    let content: string;
    let options: string[] | undefined;
    let status: GradingRunStatus = "completed";
    if (outcome.kind === "question") {
      content = outcome.question.question;
      options = outcome.question.options;
      status = "waiting_for_teacher";
      await this.sessions.setGradingStatus(run.sessionId, "waiting_for_teacher", run.id);
    } else if (outcome.kind === "draft") {
      content = `批改草稿已更新：${outcome.draft.result.score.earned}/${outcome.draft.result.score.possible}。`;
    } else if (outcome.kind === "title") {
      throw new Error("A submission-title outcome cannot complete a grading run");
    } else {
      content = outcome.reply || streamedReply;
      if (run.kind === "grade") {
        status = "failed";
        await this.sessions.setGradingStatus(run.sessionId, "failed");
      }
    }
    const now = this.now();
    await this.appendConversation(run.sessionId, { role: "assistant", content, runId: run.id, process, processCollapsed: true, tools, ...(options ? { options } : {}), createdAt: now });
    await this.finishRun(run.id, status);
    if (run.kind === "chat" && status !== "waiting_for_teacher") await this.sessions.clearActiveRun(run.sessionId, run.id);
    await this.appendEvent(run.id, "final", { kind: outcome.kind, message: content, ...(options ? { options } : {}) });
  }

  private async appendEvent(runId: string, type: GradingRunEvent["type"], payload: Record<string, unknown>): Promise<void> {
    const now = this.now();
    const insert = this.database.transaction(() => {
      const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_run_events WHERE run_id = ?").get(runId) as { sequence: number };
      const sequence = row.sequence + 1;
      this.database.prepare("INSERT INTO agent_run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, sequence, type, JSON.stringify(payload), now);
    });
    insert();
  }

  private async appendConversation(sessionId: string, message: GradingConversationMessage): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    const existing = await this.getConversation(sessionId);
    const conversation: GradingConversation = { sessionId, messages: [...existing.messages, message], updatedAt: message.createdAt };
    await this.filesystem.writeText(this.conversationPath(session), `${JSON.stringify(conversation, null, 2)}\n`);
  }

  private conversationPath(session: GradingSession): string {
    return `assignments/${session.assignmentId}/results/${session.batchId}/sessions/${session.studentKey}.json`;
  }

  private async updateRun(runId: string, status: GradingRunStatus): Promise<void> {
    this.database.prepare("UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), runId);
  }

  private async finishRun(runId: string, status: GradingRunStatus, errorCode?: string): Promise<void> {
    this.database.prepare("UPDATE agent_runs SET status = ?, error_code = ?, updated_at = ? WHERE id = ?").run(status, errorCode ?? null, this.now(), runId);
  }

  private recoverInterruptedRuns(): void {
    const now = this.now();
    const interrupted = this.database.prepare("SELECT id, session_id, kind FROM agent_runs WHERE status = 'running'").all() as Array<{ id: string; session_id: string; kind: "grade" | "chat" }>;
    const recover = this.database.transaction(() => {
      for (const run of interrupted) {
        this.database.prepare("UPDATE agent_runs SET status = 'failed', error_code = 'INTERRUPTED', updated_at = ? WHERE id = ?").run(now, run.id);
        const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_run_events WHERE run_id = ?").get(run.id) as { sequence: number };
        this.database.prepare("INSERT INTO agent_run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, 'error', ?, ?)").run(run.id, row.sequence + 1, JSON.stringify({ code: "INTERRUPTED", message: "批改运行因服务重启而中断；未自动重新调用模型" }), now);
        this.database.prepare("UPDATE grading_sessions SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?").run(now, run.session_id, run.id);
        if (run.kind === "grade") this.database.prepare("UPDATE grading_sessions SET grading_status = 'failed', updated_at = ? WHERE id = ? AND grading_status = 'running'").run(now, run.session_id);
      }
    });
    recover();
    const queued = this.database.prepare("SELECT id FROM agent_runs WHERE status = 'queued' ORDER BY created_at").all() as Array<{ id: string }>;
    for (const { id } of queued) {
      this.database.prepare("UPDATE grading_sessions SET active_run_id = ?, updated_at = ? WHERE id = (SELECT session_id FROM agent_runs WHERE id = ?)").run(id, now, id);
      void this.queue.add(async () => this.execute(id)).catch(() => undefined);
    }
  }
}

function fromRunRow(row: RunRow): GradingRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    message: row.input_message,
    status: row.status,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeEventPayload(event: GradingAgentEvent): Record<string, unknown> {
  if (event.type === "status") return { phase: event.phase };
  if (event.type === "process_delta" || event.type === "reply_delta") return { delta: event.delta };
  return { id: event.id, name: event.name, label: event.label, summary: event.summary, ...(event.type === "tool_end" ? { status: event.status } : {}) };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
