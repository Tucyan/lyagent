import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderRubricMarkdown, RubricConflictError, RubricService, RubricValidationError } from "../src/services/rubric-service.js";
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
  it("deletes the conversation, sources, editable draft, and every frozen formal file with the session", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({
      title: "待删除评分表",
      totalScore: 100,
      requirements: "评价报告。",
      sources: [{ role: "note", name: "设计备注.txt", content: "关注论证质量。" }],
    });
    await service.selectMode(assignment.id, "additive");
    await service.appendConversationTurn(
      assignment.id,
      { role: "user", content: "生成评分表。" },
      { role: "assistant", content: "已生成。" },
    );
    const firstDraft = await service.createDraft(assignment.id, rubric);
    await service.freeze(assignment.id, firstDraft.version, []);
    await service.createRevision(assignment.id, 1);
    const assignmentDirectory = path.join(service.root, "assignments", assignment.id);
    await expect(access(assignmentDirectory)).resolves.toBeUndefined();

    await service.deleteAssignment(assignment.id);

    await expect(access(assignmentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.getAssignment(assignment.id)).rejects.toThrow("Assignment was not found");
    await expect(service.listAssignments()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: assignment.id })]));
  });

  it("allows source-only assignments while rejecting assignments with no requirements or sources", async () => {
    const service = await serviceForTest();

    const assignment = await service.createAssignment({
      title: "Source-led rubric",
      totalScore: 100,
      requirements: "   ",
      sources: [{ role: "note", name: "teacher-note.txt", content: "Assess the submitted report." }],
    });

    expect(assignment.requirements).toBe("");
    expect(assignment.sources).toHaveLength(1);
    await expect(service.createAssignment({ title: "Empty", totalScore: 100, requirements: "", sources: [] })).rejects.toThrow("non-empty source");
    await expect(service.createAssignment({ title: "Blank source", totalScore: 100, requirements: "", sources: [{ role: "note", name: "blank.txt", content: "  \n " }] })).rejects.toThrow("non-empty source");
  });

  it("exports levels, evidence, partial-credit, and overlap semantics to Markdown", () => {
    const markdown = renderRubricMarkdown({
      schemaVersion: "1.0",
      mode: "hybrid",
      totalScore: 100,
      partialCreditAllowed: true,
      criteria: rubric.criteria,
      bonusRules: [],
      deductionRules: [{ ...deductiveRubric.rules[0]!, overlapGroup: "timing" }],
      overlapGroups: [{ id: "timing", aggregation: "highest-only" }],
    });

    expect(markdown).toContain("允许部分得分：是");
    expect(markdown).toContain("good");
    expect(markdown).toContain("60–100");
    expect(markdown).toContain("需要评分分析依据");
    expect(markdown).toContain("timing");
    expect(markdown).toContain("仅取最高项");
  });

  it("persists completed rubric conversation turns with safe process and tool summaries", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "Conversation", totalScore: 100, requirements: "Assess it", sources: [] });
    await service.selectMode(assignment.id, "additive");

    await service.appendConversationTurn(
      assignment.id,
      { role: "user", content: "Create the first rubric." },
      {
        role: "assistant",
        content: "The rubric draft is ready for review.",
        process: "I am reading the assignment context.",
        tools: [{ id: "tool-1", name: "read_assignment_context", label: "Read assignment context", summary: "Read the current assignment", status: "completed" }],
      },
    );

    const reopened = new RubricService(service.root);
    await expect(reopened.getDesignSession(assignment.id)).resolves.toMatchObject({
      selectedMode: "additive",
      messages: [
        { role: "user", content: "Create the first rubric." },
        { role: "assistant", content: "The rubric draft is ready for review.", process: expect.stringContaining("正在分析"), tools: [{ name: "read_assignment_context", status: "completed" }] },
      ],
    });
  });

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

  it("keeps the selected mode immutable after a draft and after a frozen version", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);

    await expect(service.selectMode(assignment.id, "deductive")).rejects.toThrow("cannot change after a rubric draft exists");
    await expect(service.getDesignSession(assignment.id)).resolves.toMatchObject({ selectedMode: "additive" });
    await service.freeze(assignment.id, draft.version, []);
    await expect(service.selectMode(assignment.id, "deductive")).rejects.toThrow("cannot change after a rubric version is frozen");
    await expect(service.getDesignSession(assignment.id)).resolves.toMatchObject({ selectedMode: "additive" });
  });

  it("reports conflicts for concurrent draft creation and revision creation", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");

    const creates = await Promise.allSettled([service.createDraft(assignment.id, rubric), service.createDraft(assignment.id, rubric)]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(RubricConflictError)]);

    const draft = await service.getDraft(assignment.id);
    await service.freeze(assignment.id, draft!.version, []);
    const revisions = await Promise.allSettled([service.createRevision(assignment.id, 1), service.createRevision(assignment.id, 1)]);
    expect(revisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(revisions.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([expect.any(RubricConflictError)]);
  });

  it("serializes renames with draft replacement and freezing", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "Original", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);

    await Promise.all([
      service.renameAssignment(assignment.id, "After replace"),
      service.replaceDraft(assignment.id, draft.version, { ...rubric, criteria: [{ ...rubric.criteria[0]!, name: "Updated" }] }),
    ]);
    await expect(service.getAssignment(assignment.id)).resolves.toMatchObject({ title: "After replace" });

    const updated = await service.getDraft(assignment.id);
    await Promise.all([
      service.renameAssignment(assignment.id, "After freeze"),
      service.freeze(assignment.id, updated!.version, []),
    ]);
    await expect(service.getAssignment(assignment.id)).resolves.toMatchObject({ title: "After freeze" });
  });

  it("recovers a version write failure before draft removal without leaving an editable draft", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);
    const failing = new RubricService(service.root, { afterFreezeVersionWrite: () => { throw new Error("simulated crash"); } });

    await expect(failing.freeze(assignment.id, draft.version, [])).rejects.toThrow("simulated crash");
    const recovered = new RubricService(service.root);

    await expect(recovered.listVersions(assignment.id)).resolves.toEqual([expect.objectContaining({ version: 1 })]);
    await expect(recovered.getDraft(assignment.id)).resolves.toBeUndefined();
    await expect(recovered.replaceDraft(assignment.id, draft.version, rubric)).rejects.toBeInstanceOf(RubricConflictError);
  });

  it("idempotently recovers a crash after draft deletion before commit-marker deletion", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);
    const failing = new RubricService(service.root, { afterFreezeDraftDelete: () => { throw new Error("simulated crash after draft delete"); } });

    await expect(failing.freeze(assignment.id, draft.version, [])).rejects.toThrow("simulated crash after draft delete");
    const recovered = new RubricService(service.root);

    await expect(recovered.getDraft(assignment.id)).resolves.toBeUndefined();
    await expect(recovered.getDraft(assignment.id)).resolves.toBeUndefined();
  });

  it("serializes reads with an in-progress freeze and commits its timestamp", async () => {
    const service = await serviceForTest();
    const assignment = await service.createAssignment({ title: "报告评分表", totalScore: 100, requirements: "报告", sources: [] });
    await service.selectMode(assignment.id, "additive");
    const draft = await service.createDraft(assignment.id, rubric);
    let releaseFreeze: (() => void) | undefined;
    let signalPaused: (() => void) | undefined;
    const freezePaused = new Promise<void>((resolve) => { signalPaused = resolve; });
    const paused = new RubricService(service.root, {
      afterFreezeVersionWrite: async () => {
        signalPaused?.();
        await new Promise<void>((resolve) => { releaseFreeze = resolve; });
      },
    });
    const freezing = paused.freeze(assignment.id, draft.version, []);
    await freezePaused;
    const reading = paused.getDraft(assignment.id);

    releaseFreeze?.();
    const frozen = await freezing;
    await expect(reading).resolves.toBeUndefined();
    await expect(paused.getAssignment(assignment.id)).resolves.toMatchObject({ updatedAt: frozen.frozenAt });
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
