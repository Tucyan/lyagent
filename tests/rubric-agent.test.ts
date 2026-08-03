import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPiRubricDesigner } from "../src/agents/rubric-designer/agent.js";
import { RubricService } from "../src/services/rubric-service.js";
import { createRubricDesignerTools } from "../src/tools/rubric/index.js";

const roots: string[] = [];

const additiveRubric = {
  schemaVersion: "1.0" as const,
  mode: "additive" as const,
  totalScore: 100,
  partialCreditAllowed: true,
  criteria: [{
    id: "argument",
    name: "Argument",
    description: "Makes a clear, supported argument.",
    maxScore: 100,
    scorePolicy: "continuous" as const,
    evidenceRequired: true,
  }],
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rubric-agent-"));
  roots.push(root);
  const service = new RubricService(root);
  const assignment = await service.createAssignment({
    title: "AI and life report rubric",
    totalScore: 100,
    requirements: "Evaluate the report's argument, evidence, and clarity.",
    sources: [{ role: "rubric_draft", name: "draft.md", content: "Prefer evidence and clear argumentation." }],
  });
  return { service, assignment };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rubric designer tools", () => {
  it("binds every tool to its constructor assignment and does not expose freezing", async () => {
    const { service, assignment } = await fixture();
    const other = await service.createAssignment({
      title: "Other assignment",
      totalScore: 10,
      requirements: "Other requirements.",
      sources: [{ role: "note", name: "other.md", content: "Other private source." }],
    });
    const tools = createRubricDesignerTools(service, assignment.id);

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "read_assignment_context",
      "read_rubric_source",
      "read_rubric_draft",
      "create_rubric_draft",
      "replace_rubric_draft",
      "validate_rubric",
      "ask_rubric_question",
    ]);
    expect(tools.tools.some((tool) => tool.name.includes("freeze"))).toBe(false);
    expect(JSON.stringify(tools.tools.map((tool) => tool.parameters))).not.toContain("assignmentId");

    const sourceTool = tools.tools.find((tool) => tool.name === "read_rubric_source");
    await expect(sourceTool!.execute("test", { sourceId: other.sources[0]!.id })).rejects.toThrow("Rubric source was not found");
  });
});

describe("rubric designer agent", () => {
  it("returns a strict three-option mode recommendation", async () => {
    const { service, assignment } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify({
      options: [
        { mode: "additive", recommended: false, benefit: "Clear criterion weights." },
        { mode: "deductive", recommended: true, reason: "The draft focuses on common mistakes." },
        { mode: "hybrid", recommended: false, benefit: "Can recognize exceptional work." },
      ],
    }))])]);

    const recommendation = await createPiRubricDesigner({ models, model: faux.getModel(), rubricService: service, assignmentId: assignment.id })
      .recommendModes(["Prefer evidence and clear argumentation."]);

    expect(recommendation.options).toHaveLength(3);
    expect(recommendation.options.map((option) => option.mode)).toEqual(["additive", "deductive", "hybrid"]);
    expect(recommendation.options.filter((option) => option.recommended)).toEqual([
      expect.objectContaining({ mode: "deductive", reason: "The draft focuses on common mistakes." }),
    ]);
  });

  it.each([
    ["an incomplete mode list", [
      { mode: "additive", recommended: true, reason: "Fits weighted criteria." },
      { mode: "deductive", recommended: false },
    ]],
    ["a three-item list with a duplicate mode", [
      { mode: "additive", recommended: true, reason: "Fits weighted criteria." },
      { mode: "additive", recommended: false },
      { mode: "hybrid", recommended: false },
    ]],
    ["multiple recommended options", [
      { mode: "additive", recommended: true, reason: "Fits weighted criteria." },
      { mode: "deductive", recommended: true, reason: "Fits common-error rules." },
      { mode: "hybrid", recommended: false },
    ]],
    ["a blank reason for the recommended option", [
      { mode: "additive", recommended: true, reason: "   " },
      { mode: "deductive", recommended: false },
      { mode: "hybrid", recommended: false },
    ]],
  ])("rejects %s in a mode recommendation", async (_description, options) => {
    const { service, assignment } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify({ options }))])]);

    await expect(createPiRubricDesigner({ models, model: faux.getModel(), rubricService: service, assignmentId: assignment.id })
      .recommendModes(["Prefer evidence and clear argumentation."]))
      .rejects.toThrow("invalid scoring-mode recommendation");
  });

  it("captures a structured question with a safe final message", async () => {
    const { service, assignment } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_rubric_question", {
      question: "Should citations be mandatory for the report?",
      options: ["Required", "Recommended"],
    })], { stopReason: "toolUse" })]);

    const outcome = await createPiRubricDesigner({ models, model: faux.getModel(), rubricService: service, assignmentId: assignment.id })
      .design("Create a first rubric draft.");

    expect(outcome).toEqual({
      kind: "question",
      question: { question: "Should citations be mandatory for the report?", options: ["Required", "Recommended"] },
      message: "A clarification is needed before the rubric can be updated.",
    });
    await expect(service.getDraft(assignment.id)).resolves.toBeUndefined();
  });

  it("creates a rubric draft and returns a safe final message", async () => {
    const { service, assignment } = await fixture();
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("create_rubric_draft", { rubric: additiveRubric })], { stopReason: "toolUse" })]);

    const outcome = await createPiRubricDesigner({ models, model: faux.getModel(), rubricService: service, assignmentId: assignment.id })
      .design("Create a first rubric draft.");

    expect(outcome).toMatchObject({ kind: "draft", message: "The rubric draft has been updated and is ready for review.", draft: { version: 1, rubric: additiveRubric } });
    await expect(service.getDraft(assignment.id)).resolves.toMatchObject({ version: 1, rubric: additiveRubric });
  });
});
