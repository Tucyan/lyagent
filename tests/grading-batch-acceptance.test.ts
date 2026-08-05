import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GradingBatchService, type BatchSessionSummary } from "../src/services/grading-batch-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("M5 deterministic batch acceptance", () => {
  it("produces exactly 120 JSON, 120 Markdown, and 120 CSV data rows at concurrency four", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grading-batch-120-"));
    roots.push(root);
    const members: BatchSessionSummary[] = Array.from({ length: 120 }, (_, index) => ({
      id: `session-${String(index + 1).padStart(3, "0")}`,
      assignmentId: "assignment-120",
      rubricVersion: 1,
      conversionStatus: "ready",
      gradingStatus: "not_started",
      studentName: `合成学生${index + 1}`,
      studentNumber: `2026${String(index + 1).padStart(4, "0")}`,
      submissionTitle: `合成研究报告${index + 1}`,
    }));
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec("CREATE TABLE grading_sessions (id TEXT PRIMARY KEY)");
    const insert = database.prepare("INSERT INTO grading_sessions (id) VALUES (?)");
    for (const member of members) insert.run(member.id);
    database.close();
    let active = 0;
    let maximum = 0;
    let modelCalls = 0;
    const service = new GradingBatchService(root, {
      getSession: async (id) => members.find((member) => member.id === id)!,
      async execute() {
        modelCalls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { status: "completed" };
      },
      async readResult(sessionId) {
        const index = Number(sessionId.slice(-3));
        return {
          reviewStatus: "needs_review",
          version: 1,
          result: {
            score: { earned: 70 + index % 21, possible: 100 },
            confidence: { overall: 0.85, minimum: 0.8, lowCount: 0 },
            review: { requiresReview: false, reasons: [] },
            decisions: { strengths: ["合成优点"], improvements: ["合成建议"] },
          },
          updatedAt: "2026-08-05T08:00:00.000Z",
        };
      },
    });
    const batch = await service.createBatch({ title: "120份确定性验收", assignmentId: "assignment-120", rubricVersion: 1, concurrency: 4, sessionIds: members.map(({ id }) => id) });
    await service.startBatch(batch.id);
    await service.waitForIdle(batch.id);
    const resultDirectory = path.join(root, "batch-grading", batch.id, "results");
    const names = await readdir(resultDirectory);
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(120);
    expect(names.filter((name) => name.endsWith(".md"))).toHaveLength(120);
    const csv = await service.rebuildSummary(batch.id);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(121);
    expect(modelCalls).toBe(120);
    expect(maximum).toBe(4);
    expect(await service.getBatch(batch.id)).toMatchObject({ status: "completed", counts: { needs_review: 120 } });
    service.close();
  }, 30_000);
});

