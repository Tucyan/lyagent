import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RubricConflictError, RubricService, RubricValidationError } from "../src/services/rubric-service.js";
import type { Rubric } from "../src/schemas/rubric.js";

const roots: string[] = [];

const rubric: Rubric = {
  schemaVersion: "1.0",
  mode: "additive",
  totalScore: 100,
  partialCreditAllowed: true,
  criteria: [{
    id: "analysis",
    name: "分析质量",
    description: "评价报告的分析质量",
    maxScore: 100,
    scorePolicy: "range",
    evidenceRequired: true,
    levels: [
      { id: "good", minScore: 60, maxScore: 100, condition: "分析完整" },
      { id: "basic", minScore: 0, maxScore: 59.99, condition: "分析不足" },
    ],
  }],
};

const deductiveRubric: Rubric = {
  schemaVersion: "1.0",
  mode: "deductive",
  totalScore: 100,
  rules: [{ id: "late", name: "Late submission", condition: "Submitted after the deadline", deduction: 10, maxDeduction: 10, occurrence: "once", evidenceRequired: true }],
  overlapGroups: [],
};

async function serviceForTest(): Promise<RubricService> {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-rubric-"));
  roots.push(root);
  return new RubricService(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rubric versioning", () => {
  it("stores controlled source text and freezes a validated immutable v1", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({
      title: "AI 与生活的融合及挑战-AI的发展-作业报告评分表",
      totalScore: 100,
      requirements: "提交一份关于 AI 与生活的报告。",
      sources: [{ role: "rubric_draft", name: "原始标准.md", content: "# 草稿\n重视分析。" }],
    });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);
    const frozen = await service.freeze(assignment.id, draft.version, []);

    expect(frozen.version).toBe(1);
    expect(frozen.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.readSource(assignment.id, assignment.sources[0]!.id)).toContain("重视分析");
    expect(await service.renderVersionMarkdown(assignment.id, 1)).toContain("分析质量");
    expect(await service.getDraft(assignment.id)).toBeUndefined();
    expect(await service.listVersions(assignment.id)).toEqual([expect.objectContaining({ version: 1, hash: frozen.hash })]);
  });

  it("rejects stale draft writes and clones a frozen history version into an editable revision", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const initial = await service.createDraft(assignment.id, rubric);
    const updated = await service.replaceDraft(assignment.id, initial.version, { ...rubric, criteria: [{ ...rubric.criteria[0]!, name: "论证质量" }] });

    await expect(service.replaceDraft(assignment.id, initial.version, rubric)).rejects.toBeInstanceOf(RubricConflictError);
    await service.freeze(assignment.id, updated.version, []);
    const revision = await service.createRevision(assignment.id, 1);

    expect(revision.version).toBe(1);
    expect(revision.baseRubricVersion).toBe(1);
    expect(revision.rubric.mode).toBe("additive");
    if (revision.rubric.mode !== "additive") throw new Error("Expected additive revision");
    expect(revision.rubric.criteria[0]!.name).toBe("论证质量");
  });

  it("rejects semantically invalid drafts before creating or replacing stored data", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    const invalid: Rubric = { ...rubric, criteria: [{ ...rubric.criteria[0]!, maxScore: 99 }] };

    await service.selectMode(assignment.id, "additive");
    await expect(service.createDraft(assignment.id, invalid)).rejects.toBeInstanceOf(RubricValidationError);
    await expect(service.getDraft(assignment.id)).resolves.toBeUndefined();

    const initial = await service.createDraft(assignment.id, rubric);
    await expect(service.replaceDraft(assignment.id, initial.version, invalid)).rejects.toBeInstanceOf(RubricValidationError);
    await expect(service.getDraft(assignment.id)).resolves.toMatchObject({ version: initial.version, rubric });
  });

  it("requires a persisted selected mode before drafts and rejects a different rubric mode", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });

    await expect(service.createDraft(assignment.id, rubric)).rejects.toThrow("Select a scoring mode");
    await expect(service.selectMode(assignment.id, "additive")).resolves.toMatchObject({ assignmentId: assignment.id, selectedMode: "additive" });
    const draft = await service.createDraft(assignment.id, rubric);
    await expect(service.replaceDraft(assignment.id, draft.version, deductiveRubric)).rejects.toThrow("does not match the selected scoring mode");
    await expect(service.getDraft(assignment.id)).resolves.toMatchObject({ version: draft.version, rubric });
  });

  it("serializes concurrent draft replacements and freezes for one assignment", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);

    const replacements = await Promise.allSettled([
      service.replaceDraft(assignment.id, draft.version, { ...rubric, criteria: [{ ...rubric.criteria[0]!, name: "First update" }] }),
      service.replaceDraft(assignment.id, draft.version, { ...rubric, criteria: [{ ...rubric.criteria[0]!, name: "Second update" }] }),
    ]);
    expect(replacements.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(RubricConflictError)]);

    const updated = await service.getDraft(assignment.id);
    const freezes = await Promise.allSettled([
      service.freeze(assignment.id, updated!.version, []),
      service.freeze(assignment.id, updated!.version, []),
    ]);
    expect(freezes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(freezes.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(RubricConflictError)]);
    await expect(service.listVersions(assignment.id)).resolves.toEqual([expect.objectContaining({ version: 1 })]);
  });
});
