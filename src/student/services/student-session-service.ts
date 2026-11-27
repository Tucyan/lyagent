import { randomUUID } from "node:crypto";
import { SafeFilesystem } from "../../core/safe-filesystem.js";
import type { CourseCitation } from "../../schemas/qa-stream.js";
import type { CourseQaSession, CourseQaSessionListing, CourseQaSessionSummary, SessionMessage } from "../../services/session-service.js";
import { SessionNotFoundError, isReadableQaSession, summarizeStoredSessions } from "../../services/session-service.js";

export interface StudentCourseQaSession extends CourseQaSession {
  userId: string;
}

export class StudentSessionService {
  private readonly filesystem: SafeFilesystem;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.filesystem = new SafeFilesystem(workspaceRoot);
  }

  async create(userId: string, courseId: string, releaseId: string): Promise<StudentCourseQaSession> {
    const now = new Date().toISOString();
    const session: StudentCourseQaSession = {
      id: randomUUID(),
      userId,
      courseId,
      releaseId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.write(session);
    return session;
  }

  async get(userId: string, courseId: string, sessionId: string): Promise<StudentCourseQaSession> {
    try {
      return await this.readStored(userId, courseId, sessionId);
    } catch {
      throw new SessionNotFoundError();
    }
  }

  private async readStored(userId: string, courseId: string, sessionId: string): Promise<StudentCourseQaSession> {
    const text = await this.filesystem.readText(this.file(userId, courseId, sessionId));
    try {
      const session = normalizeSession(JSON.parse(text) as StudentCourseQaSession);
      if (session.userId === userId && session.courseId === courseId && session.id === sessionId &&
        isReadableQaSession(session)) return session;
    } catch {
      throw new SessionNotFoundError();
    }
    throw new SessionNotFoundError();
  }

  async appendCompletedTurn(
    userId: string,
    courseId: string,
    sessionId: string,
    user: Extract<SessionMessage, { role: "user" }>,
    assistant: Extract<SessionMessage, { role: "assistant" }>,
    signal?: AbortSignal,
  ): Promise<StudentCourseQaSession> {
    return this.mutateSession(userId, courseId, sessionId, async () => {
      const session = await this.get(userId, courseId, sessionId);
      const updated: StudentCourseQaSession = {
        ...session,
        updatedAt: new Date().toISOString(),
        messages: [...session.messages, user, assistant].slice(-20),
      };
      signal?.throwIfAborted();
      await this.write(updated);
      return updated;
    });
  }

  async rename(userId: string, courseId: string, sessionId: string, title: string): Promise<StudentCourseQaSession> {
    return this.mutateSession(userId, courseId, sessionId, async () => {
      const session = await this.get(userId, courseId, sessionId);
      const updated: StudentCourseQaSession = { ...session, title, updatedAt: new Date().toISOString() };
      await this.write(updated);
      return updated;
    });
  }

  async delete(userId: string, courseId: string, sessionId: string): Promise<void> {
    return this.mutateSession(userId, courseId, sessionId, async () => {
      await this.get(userId, courseId, sessionId);
      try {
        await this.filesystem.removeFile(this.file(userId, courseId, sessionId));
      } catch {
        throw new SessionNotFoundError();
      }
    });
  }

  async list(userId: string, courseId: string): Promise<CourseQaSessionSummary[]> {
    return (await this.listWithDiagnostics(userId, courseId)).sessions;
  }

  async listWithDiagnostics(userId: string, courseId: string): Promise<CourseQaSessionListing> {
    const entries = await this.filesystem.listFiles(`student-sessions/${userId}/${courseId}`);
    return summarizeStoredSessions(entries, (sessionId) => this.readStored(userId, courseId, sessionId));
  }

  private async write(session: StudentCourseQaSession): Promise<void> {
    await this.filesystem.writeText(
      this.file(session.userId, session.courseId, session.id),
      `${JSON.stringify(session, null, 2)}\n`,
    );
  }

  private async mutateSession<T>(userId: string, courseId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
    const key = this.file(userId, courseId, sessionId);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
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

  private file(userId: string, courseId: string, sessionId: string): string {
    return `student-sessions/${userId}/${courseId}/${sessionId}.json`;
  }
}

function normalizeSession(session: StudentCourseQaSession): StudentCourseQaSession {
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            citations: (message.citations ?? []).map((citation) =>
              "type" in citation ? citation : ({ type: "knowledge", ...(citation as Record<string, unknown>) } as CourseCitation),
            ),
          }
        : message,
    ),
  };
}
