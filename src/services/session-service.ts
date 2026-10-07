import { randomUUID } from "node:crypto";
import { SafeFilesystem } from "../core/safe-filesystem.js";
import type { CourseCitation, KnowledgeCitation } from "../schemas/qa-stream.js";

export type SessionMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; citations: CourseCitation[]; insufficient?: boolean };

export interface CourseQaSession {
  id: string;
  courseId: string;
  releaseId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  messages: SessionMessage[];
}

export interface CourseQaSessionSummary {
  id: string;
  releaseId: string;
  updatedAt: string;
  summary: string;
}

export class SessionNotFoundError extends Error {
  constructor() {
    super("Session was not found");
    this.name = "SessionNotFoundError";
  }
}

export class SessionService {
  private readonly filesystem: SafeFilesystem;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.filesystem = new SafeFilesystem(workspaceRoot);
  }

  async create(courseId: string, releaseId: string): Promise<CourseQaSession> {
    const now = new Date().toISOString();
    const session: CourseQaSession = { id: randomUUID(), courseId, releaseId, createdAt: now, updatedAt: now, messages: [] };
    await this.write(session);
    return session;
  }

  async get(courseId: string, sessionId: string): Promise<CourseQaSession> {
    let session: CourseQaSession;
    try {
      session = normalizeSession(JSON.parse(await this.filesystem.readText(this.file(courseId, sessionId))) as CourseQaSession);
    } catch {
      throw new SessionNotFoundError();
    }
    if (session.courseId !== courseId || session.id !== sessionId) throw new SessionNotFoundError();
    return session;
  }

  async appendCompletedTurn(courseId: string, sessionId: string, user: Extract<SessionMessage, { role: "user" }>, assistant: Extract<SessionMessage, { role: "assistant" }>): Promise<CourseQaSession> {
    return this.mutateSession(courseId, sessionId, async () => {
      const session = await this.get(courseId, sessionId);
      const updated: CourseQaSession = {
        ...session,
        updatedAt: new Date().toISOString(),
        messages: [...session.messages, user, assistant].slice(-20),
      };
      await this.write(updated);
      return updated;
    });
  }

  async rename(courseId: string, sessionId: string, title: string): Promise<CourseQaSession> {
    return this.mutateSession(courseId, sessionId, async () => {
      const session = await this.get(courseId, sessionId);
      const updated: CourseQaSession = { ...session, title, updatedAt: new Date().toISOString() };
      await this.write(updated);
      return updated;
    });
  }

  async delete(courseId: string, sessionId: string): Promise<void> {
    return this.mutateSession(courseId, sessionId, async () => {
      await this.get(courseId, sessionId);
      try {
        await this.filesystem.removeFile(this.file(courseId, sessionId));
      } catch {
        throw new SessionNotFoundError();
      }
    });
  }

  async list(courseId: string): Promise<CourseQaSessionSummary[]> {
    const entries = await this.filesystem.listFiles(`sessions/web/${courseId}`);
    const sessions = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      const sessionId = entry.slice(0, -5);
      return this.get(courseId, sessionId);
    }));
    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({ id: session.id, releaseId: session.releaseId, updatedAt: session.updatedAt, summary: session.title ?? session.messages.find((message) => message.role === "user")?.content.slice(0, 80) ?? "新对话" }));
  }

  private async write(session: CourseQaSession): Promise<void> {
    await this.filesystem.writeText(this.file(session.courseId, session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  private async mutateSession<T>(courseId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
    const key = this.file(courseId, sessionId);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.mutationTails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
    }
  }

  private file(courseId: string, sessionId: string): string {
    return `sessions/web/${courseId}/${sessionId}.json`;
  }
}

type LegacyKnowledgeCitation = Omit<KnowledgeCitation, "type">;

function normalizeSession(session: CourseQaSession): CourseQaSession {
  return {
    ...session,
    messages: session.messages.map((message) => message.role === "assistant" ? {
      ...message,
      citations: (message.citations as Array<CourseCitation | LegacyKnowledgeCitation>).map((citation) => "type" in citation ? citation : { type: "knowledge", ...citation }),
    } : message),
  };
}
