import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/api/server.js";

describe("batch recovery with a saved queued grading run", () => {
  it.each([
    { batchStatus: "running", attemptCount: 1 },
    { batchStatus: "running", attemptCount: 3 },
    { batchStatus: "paused", attemptCount: 1 },
  ])("reattaches a queued run in a $batchStatus batch after $attemptCount prior claims", async ({ batchStatus, attemptCount }) => {
    const root = await mkdtemp(join(tmpdir(), "grading-batch-queued-run-"));
    let app: Awaited<ReturnType<typeof createServer>> | undefined;
    let db: Database.Database | undefined;
    try {
      app = await createServer({ workspaceRoot: root });
      await app.ready();
      await app.close();
      app = undefined;

      db = new Database(join(root, "grading.sqlite"));
      const now = new Date().toISOString();
      const sessionId = randomUUID();
      const courseId = randomUUID();
      const assignmentId = randomUUID();
      const batchId = randomUUID();
      const jobId = randomUUID();
      const runId = randomUUID();
      const message = "请开始批改当前作业。";
      db.prepare(
        "INSERT INTO grading_sessions (id,course_id,assignment_id,rubric_version,rubric_hash,batch_id,student_key,student_name,student_number,title,submission_title,submission_title_status,auto_start,conversion_status,grading_status,active_run_id,submission_version,submission_hash,created_at,updated_at) VALUES (?,?,?,1,'hash',?,?,'student','101','title','report','provided',0,'ready','queued',?,1,'hash',?,?)",
      ).run(sessionId, courseId, assignmentId, randomUUID(), randomUUID(), runId, now, now);
      db.prepare(
        "INSERT INTO grading_batches (id,course_id,title,assignment_id,rubric_version,status,concurrency,created_at,updated_at) VALUES (?,?,'batch',?,1,?,1,?,?)",
      ).run(batchId, courseId, assignmentId, batchStatus, now, now);
      db.prepare(
        "INSERT INTO grading_batch_jobs (id,batch_id,session_id,student_name,student_number,submission_title,status,attempt_count,lease_owner,lease_expires_at,next_message,created_at,updated_at) VALUES (?,?,?,'student','101','title','running',?,'previous worker',?,?,?,?)",
      ).run(jobId, batchId, sessionId, attemptCount, now, message, now, now);
      db.prepare(
        "INSERT INTO agent_runs (id,session_id,kind,input_message,status,created_at,updated_at) VALUES (?,?,'grade',?,'queued',?,?)",
      ).run(runId, sessionId, message, now, now);

      const grade = vi.fn(async () => ({ kind: "question" as const, question: { question: "Teacher input?", options: ["Yes", "No"] } }));
      app = await createServer({ workspaceRoot: root, gradingAgentFactory: () => ({ run: grade }) });
      const restarted = app;
      await vi.waitFor(async () => expect((await restarted.inject("/api/health")).json().gradingRecovery.status).toBe("ready"));
      if (batchStatus === "paused") {
        expect(grade).not.toHaveBeenCalled();
        expect(db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(runId)).toEqual({ status: "queued" });
        const resumed = await app.inject({ method: "POST", url: "/api/grading/batches/" + batchId + "/resume" });
        expect(resumed.statusCode).toBe(202);
      }
      const database = db;
      await vi.waitFor(() => expect(database.prepare("SELECT status, run_id, attempt_count FROM grading_batch_jobs WHERE id = ?").get(jobId)).toEqual({ status: "waiting_for_teacher", run_id: runId, attempt_count: attemptCount }));
      expect(grade).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT id FROM agent_runs WHERE session_id = ?").all(sessionId)).toEqual([{ id: runId }]);
    } finally {
      if (app) await app.close();
      db?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
