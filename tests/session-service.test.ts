import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService, type CourseQaSession } from "../src/services/session-service.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-session-lock-"));
  roots.push(root);
  const service = new SessionService(root);
  const session = await service.create("course", "release");
  return { service, session };
}

// Hold the first snapshot before its write. Unserialized reads see that same
// snapshot; serialized reads must wait and fetch the newly persisted state.
function pauseFirstRead(service: SessionService, session: CourseQaSession) {
  const original = service.get.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  let first = true;
  vi.spyOn(service, "get").mockImplementation(async (courseId, sessionId) => {
    if (courseId !== session.courseId || sessionId !== session.id) return original(courseId, sessionId);
    if (paused) return structuredClone(session);
    const snapshot = await original(courseId, sessionId);
    if (first) {
      first = false;
      paused = true;
      entered();
      await gate;
      paused = false;
    }
    return snapshot;
  });
  return { ready, release, original };
}

function append(service: SessionService, session: CourseQaSession, content: string) {
  return service.appendCompletedTurn(session.courseId, session.id, { role: "user", content }, { role: "assistant", content: `${content} answer`, citations: [] });
}

describe("QA session mutations", () => {
  it("preserves both completed turns submitted concurrently", async () => {
    const { service, session } = await fixture();
    const pause = pauseFirstRead(service, session);
    const first = append(service, session, "first");
    await pause.ready;
    const second = append(service, session, "second");
    pause.release();
    await Promise.all([first, second]);
    expect((await pause.original(session.courseId, session.id)).messages.map(({ content }) => content)).toEqual(["first", "first answer", "second", "second answer"]);
  });

  it("preserves a rename made while a completed turn is being saved", async () => {
    const { service, session } = await fixture();
    const pause = pauseFirstRead(service, session);
    const writing = append(service, session, "first");
    await pause.ready;
    const renaming = service.rename(session.courseId, session.id, "New title");
    pause.release();
    await Promise.all([writing, renaming]);
    expect(await pause.original(session.courseId, session.id)).toMatchObject({ title: "New title", messages: [{ role: "user", content: "first" }, { role: "assistant", content: "first answer" }] });
  });

  it("does not recreate a deleted session when a prior save completes", async () => {
    const { service, session } = await fixture();
    const pause = pauseFirstRead(service, session);
    const writing = append(service, session, "first");
    await pause.ready;
    const deleting = service.delete(session.courseId, session.id);
    pause.release();
    await Promise.all([writing, deleting]);
    await expect(pause.original(session.courseId, session.id)).rejects.toThrow("Session was not found");
  });

  it("releases a failed mutation lock and does not block another course", async () => {
    const { service, session } = await fixture();
    const other = await service.create("other-course", "release");
    const pause = pauseFirstRead(service, session);
    const writing = append(service, session, "first");
    await pause.ready;
    await expect(append(service, other, "independent")).resolves.toMatchObject({ messages: expect.any(Array) });
    pause.release();
    await writing;
    await expect(service.rename("other-course", session.id, "Wrong course")).rejects.toThrow("Session was not found");
    await expect(service.rename(session.courseId, session.id, "Correct course")).resolves.toMatchObject({ title: "Correct course" });
  });

  it("retains only the last twenty messages after serialized writes", async () => {
    const { service, session } = await fixture();
    await Promise.all(Array.from({ length: 12 }, (_, n) => append(service, session, `turn-${n}`)));
    const saved = await service.get(session.courseId, session.id);
    expect(saved.messages).toHaveLength(20);
    expect(saved.messages[0]?.content).toBe("turn-2");
    expect(saved.messages.at(-1)?.content).toBe("turn-11 answer");
  });
});
