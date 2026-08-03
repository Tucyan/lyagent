import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RubricDesignerFactory } from "../src/api/server.js";
import type { PiRubricDesigner } from "../src/agents/rubric-designer/agent.js";
import type { Rubric } from "../src/schemas/rubric.js";

const roots: string[] = [];

const rubric: Rubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 100,
  partialCreditAllowed: true,
  criteria: [{
    id: "argument",
    name: "Argument",
    description: "Makes a clear, supported argument.",
    maxScore: 100,
    scorePolicy: "continuous",
    evidenceRequired: true,
  }],
};

async function serverForTest(factory?: RubricDesignerFactory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rubric-api-"));
  roots.push(root);
  return createServer({ workspaceRoot: root, ...(factory ? { rubricDesignerFactory: factory } : {}) });
}

async function createAssignment(app: Awaited<ReturnType<typeof serverForTest>>, sources: Array<{ role: "rubric_draft" | "note"; name: string; content: string }> = []) {
  const response = await app.inject({
    method: "POST",
    url: "/api/rubrics/assignments",
    payload: { title: "AI and life report", totalScore: 100, requirements: "Evaluate the report.", sources },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rubric HTTP API", () => {
  it("creates, lists, reads, renames, and deletes rubric sessions", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);

    expect((await app.inject({ method: "GET", url: "/api/rubrics/assignments" })).json()).toEqual([expect.objectContaining({ id: assignment.id, title: "AI and life report" })]);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}` })).json()).toMatchObject({ id: assignment.id, totalScore: 100 });
    const longTitle = "R".repeat(100);
    expect((await app.inject({ method: "PATCH", url: `/api/rubrics/assignments/${assignment.id}`, payload: { title: longTitle } })).json()).toMatchObject({ title: longTitle });
    expect((await app.inject({ method: "DELETE", url: `/api/rubrics/assignments/${assignment.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("returns static recommendations and manual mode state when no model is configured", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);

    const recommendation = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/recommendations` });
    expect(recommendation.statusCode).toBe(200);
    expect(recommendation.json()).toMatchObject({ source: "static", options: expect.arrayContaining([expect.objectContaining({ mode: "deductive", recommended: true, reason: expect.any(String) })]) });

    const selected = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ selectedMode: "additive", state: "manual" });
    await app.close();
  });

  it("rejects formal rubric chat until a scoring mode has been selected", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: async () => ({ options: [] }),
      design: async () => ({ kind: "question", question: { question: "Unused" }, message: "A clarification is needed before the rubric can be updated." }),
    };
    const app = await serverForTest(() => designer);
    const assignment = await createAssignment(app);

    const response = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/messages/stream`, payload: { message: "Create a rubric." } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "RUBRIC_STATE_ERROR" });
    await app.close();
  });

  it("uses source-aware recommendations and streams a safe generated draft after selecting a mode", async () => {
    const designer: PiRubricDesigner = {
      recommendModes: vi.fn(async () => ({ options: [
        { mode: "additive" as const, recommended: true, reason: "The draft defines weighted criteria." },
        { mode: "deductive" as const, recommended: false, benefit: "Tracks penalties." },
        { mode: "hybrid" as const, recommended: false, benefit: "Supports exceptional work." },
      ] })),
      design: vi.fn(async () => ({ kind: "draft" as const, draft: { version: 1, rubric, updatedAt: "2026-08-03T00:00:00.000Z" }, message: "The rubric draft has been updated and is ready for review." as const })),
    };
    const factory = vi.fn<RubricDesignerFactory>(() => designer);
    const app = await serverForTest(factory);
    const assignment = await createAssignment(app, [{ role: "rubric_draft", name: "draft.md", content: "Secret draft source text" }]);

    const recommendation = await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/recommendations` });
    expect(recommendation.json()).toMatchObject({ source: "model", options: expect.arrayContaining([expect.objectContaining({ mode: "additive", recommended: true })]) });
    expect(designer.recommendModes).toHaveBeenCalledWith(["Secret draft source text"]);

    const selected = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode/stream`, payload: { mode: "additive" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.body).toContain("event: final");
    expect(selected.body).toContain("rubric draft has been updated");
    expect(selected.body).not.toContain("Secret draft source text");
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/draft` })).json()).toMatchObject({ version: 1, rubric });
    await app.close();
  });

  it("edits, validates, freezes, exports, and restores frozen rubric versions", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });

    const saved = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/validate`, payload: { rubric } })).json()).toMatchObject({ errors: [] });
    const frozen = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: ["CONTINUOUS_WITHOUT_ANCHORS"] } });
    expect(frozen.statusCode).toBe(201);
    expect(frozen.json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions` })).json()).toEqual([expect.objectContaining({ version: 1 })]);
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions/1/export.json` })).json()).toMatchObject({ version: 1, rubric });
    expect((await app.inject({ method: "GET", url: `/api/rubrics/assignments/${assignment.id}/versions/1/export.md` })).body).toContain("Argument");
    expect((await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/versions/1/revisions` })).json()).toMatchObject({ version: 1, baseRubricVersion: 1 });
    await app.close();
  });

  it("maps stale writes to 409 and invalid rubrics to safe 422 validation errors", async () => {
    const app = await serverForTest();
    const assignment = await createAssignment(app);
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });

    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 1, rubric } });
    const stale = await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 1, rubric } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "RUBRIC_CONFLICT" });
    const invalid = await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/validate`, payload: { rubric: { ...rubric, totalScore: 99 } } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: "RUBRIC_VALIDATION_FAILED" });
    await app.close();
  });
});
