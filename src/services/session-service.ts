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
    try {
      return await this.readStored(courseId, sessionId);
    } catch {
      throw new SessionNotFoundError();
    }
  }

  private async readStored(courseId: string, sessionId: string): Promise<CourseQaSession> {
    const text = await this.filesystem.readText(this.file(courseId, sessionId));
    try {
      const session = normalizeSession(JSON.parse(text) as CourseQaSession);
      if (session.courseId === courseId && session.id === sessionId &&
        isReadableQaSession(session)) return session;
    } catch {
      throw new SessionNotFoundError();
    }
    throw new SessionNotFoundError();
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
    return (await this.listWithDiagnostics(courseId)).sessions;
  }

  async listWithDiagnostics(courseId: string): Promise<CourseQaSessionListing> {
    const entries = await this.filesystem.listFiles(`sessions/web/${courseId}`);
    return summarizeStoredSessions(entries, (sessionId) => this.readStored(courseId, sessionId));
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

export interface CourseQaSessionListing {
  sessions: CourseQaSessionSummary[];
  damagedCount: number;
}

export async function summarizeStoredSessions(
  entries: string[],
  read: (sessionId: string) => Promise<CourseQaSession>,
): Promise<CourseQaSessionListing> {
  const files = entries.filter((entry) => entry.endsWith(".json"));
  const sessions: CourseQaSessionSummary[] = [];
  let damagedCount = 0;
  const readOne = async (entry: string) => {
    try {
      const session = await read(entry.slice(0, -5));
      sessions.push({
        id: session.id,
        releaseId: session.releaseId,
        updatedAt: session.updatedAt,
        summary: session.title ?? session.messages.find((message) => message.role === "user")?.content.slice(0, 80) ?? "新对话",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!(error instanceof SessionNotFoundError)) throw error;
      damagedCount += 1;
    }
  };
  const concurrency = 8;
  for (let offset = 0; offset < files.length; offset += concurrency) {
    await Promise.all(files.slice(offset, offset + concurrency).map(readOne));
  }
  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return { sessions, damagedCount };
}

export function isReadableQaSession(session: CourseQaSession): boolean {
  return typeof session.updatedAt === "string" && typeof session.releaseId === "string" &&
    (session.title === undefined || typeof session.title === "string") &&
    session.messages.every((message) =>
      (message.role === "user" || message.role === "assistant") && typeof message.content === "string");
}
