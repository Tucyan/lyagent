import { randomUUID } from "node:crypto";
import { SafeFilesystem } from "../../core/safe-filesystem.js";
import type { CourseCitation } from "../../schemas/qa-stream.js";
import type { CourseQaSession, CourseQaSessionSummary, SessionMessage } from "../../services/session-service.js";
import { SessionNotFoundError } from "../../services/session-service.js";

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
    let session: StudentCourseQaSession;
    try {
      session = normalizeSession(
        JSON.parse(await this.filesystem.readText(this.file(userId, courseId, sessionId))) as StudentCourseQaSession,
      );
    } catch {
      throw new SessionNotFoundError();
    }
    if (session.userId !== userId || session.courseId !== courseId || session.id !== sessionId) {
      throw new SessionNotFoundError();
    }
    return session;
  }

  async appendCompletedTurn(
    userId: string,
    courseId: string,
    sessionId: string,
    user: Extract<SessionMessage, { role: "user" }>,
    assistant: Extract<SessionMessage, { role: "assistant" }>,
  ): Promise<StudentCourseQaSession> {
    return this.mutateSession(userId, courseId, sessionId, async () => {
      const session = await this.get(userId, courseId, sessionId);
      const updated: StudentCourseQaSession = {
        ...session,
        updatedAt: new Date().toISOString(),
        messages: [...session.messages, user, assistant].slice(-20),
      };
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
    const entries = await this.filesystem.listFiles(`student-sessions/${userId}/${courseId}`);
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => this.get(userId, courseId, entry.slice(0, -5))),
    );
    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        id: session.id,
        releaseId: session.releaseId,
        updatedAt: session.updatedAt,
        summary:
          session.title ??
          session.messages.find((message) => message.role === "user")?.content.slice(0, 80) ??
          "新对话",
      }));
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
