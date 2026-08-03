import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { rubricSchema, validateRubric, type Rubric } from "../../schemas/rubric.js";
import type { RubricDraft, RubricService } from "../../services/rubric-service.js";

export interface RubricQuestion {
  question: string;
  options?: string[];
}

export interface RubricDesignerTools {
  tools: AgentTool<any>[];
  capturedQuestion(): RubricQuestion | undefined;
  updatedDraft(): RubricDraft | undefined;
}

/**
 * Creates the complete, fixed allow-list for one rubric-design conversation.
 * The assignment id is deliberately closed over instead of accepted from the model.
 */
export function createRubricDesignerTools(rubricService: RubricService, assignmentId: string, selectedMode: Rubric["mode"]): RubricDesignerTools {
  let question: RubricQuestion | undefined;
  let updatedDraft: RubricDraft | undefined;
  const emptySchema = Type.Object({});
  const rubricValue = rubricParameterSchema(selectedMode);

  const readAssignmentContext: AgentTool<typeof emptySchema> = {
    name: "read_assignment_context",
    label: "Read assignment context",
    description: "Read this rubric session's assignment title, total score, requirements, and source metadata.",
    parameters: emptySchema,
    executionMode: "sequential",
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(await rubricService.getAssignment(assignmentId)) }], details: {} }),
  };

  const readSourceSchema = Type.Object({ sourceId: Type.String({ minLength: 1, maxLength: 80 }) });
  const readRubricSource: AgentTool<typeof readSourceSchema> = {
    name: "read_rubric_source",
    label: "Read rubric source",
    description: "Read one draft-standard or note source that belongs to this rubric session. Use source IDs from read_assignment_context.",
    parameters: readSourceSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => ({ content: [{ type: "text", text: JSON.stringify({ sourceId: parameters.sourceId, content: await rubricService.readSource(assignmentId, parameters.sourceId) }) }], details: {} }),
  };

  const readRubricDraft: AgentTool<typeof emptySchema> = {
    name: "read_rubric_draft",
    label: "Read rubric draft",
    description: "Read the editable rubric draft for this session, if one exists.",
    parameters: emptySchema,
    executionMode: "sequential",
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(await rubricService.getDraft(assignmentId)) }], details: {} }),
  };

  const createDraftSchema = Type.Object({ rubric: rubricValue });
  const createRubricDraft: AgentTool<typeof createDraftSchema> = {
    name: "create_rubric_draft",
    label: "Create rubric draft",
    description: `Create the first editable ${selectedMode} rubric draft for this session. Its totalScore must match the assignment exactly.`,
    parameters: createDraftSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => {
      const draft = await rubricService.createDraft(assignmentId, parseRubric(parameters.rubric));
      updatedDraft = draft;
      return { content: [{ type: "text", text: "Rubric draft created." }], details: {}, terminate: true };
    },
  };

  const replaceDraftSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }), rubric: rubricValue });
  const replaceRubricDraft: AgentTool<typeof replaceDraftSchema> = {
    name: "replace_rubric_draft",
    label: "Update rubric draft",
    description: `Replace the current editable ${selectedMode} draft. Read the draft first and supply its exact version as expectedVersion.`,
    parameters: replaceDraftSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => {
      const draft = await rubricService.replaceDraft(assignmentId, parameters.expectedVersion, parseRubric(parameters.rubric));
      updatedDraft = draft;
      return { content: [{ type: "text", text: "Rubric draft updated." }], details: {}, terminate: true };
    },
  };

  const validateRubricSchema = Type.Object({ rubric: rubricValue });
  const validateRubricTool: AgentTool<typeof validateRubricSchema> = {
    name: "validate_rubric",
    label: "Validate rubric",
    description: "Validate a candidate rubric before creating or updating the draft. Validation never changes session data.",
    parameters: validateRubricSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => ({ content: [{ type: "text", text: JSON.stringify(validateRubric(parameters.rubric)) }], details: {} }),
  };

  const askQuestionSchema = Type.Object({
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 6 })),
  });
  const askRubricQuestion: AgentTool<typeof askQuestionSchema> = {
    name: "ask_rubric_question",
    label: "Ask rubric question",
    description: "Ask one material clarification question when a safe rubric draft cannot yet be made.",
    parameters: askQuestionSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters) => {
      if (question) throw new Error("A rubric question has already been captured");
      question = { question: parameters.question, ...(parameters.options ? { options: parameters.options } : {}) };
      return { content: [{ type: "text", text: "Question captured." }], details: {}, terminate: true };
    },
  };

  return {
    tools: [readAssignmentContext, readRubricSource, readRubricDraft, createRubricDraft, replaceRubricDraft, validateRubricTool, askRubricQuestion],
    capturedQuestion: () => question,
    updatedDraft: () => updatedDraft,
  };
}

function parseRubric(value: unknown): Rubric {
  return rubricSchema.parse(value);
}

function rubricParameterSchema(mode: Rubric["mode"]) {
  const score = Type.Number({ minimum: 0 });
  const positiveScore = Type.Number({ exclusiveMinimum: 0 });
  const id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
  const level = Type.Object({
    id,
    minScore: score,
    maxScore: score,
    condition: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false });
  const criterion = Type.Object({
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.String({ minLength: 1, maxLength: 4_000 }),
    maxScore: positiveScore,
    scorePolicy: Type.Union([Type.Literal("exact-level"), Type.Literal("range"), Type.Literal("continuous")]),
    evidenceRequired: Type.Boolean(),
    levels: Type.Optional(Type.Array(level, { maxItems: 20 })),
  }, { additionalProperties: false });
  const overlapGroup = Type.Object({
    id,
    aggregation: Type.Union([Type.Literal("highest-only"), Type.Literal("sum")]),
  }, { additionalProperties: false });
  const deductionRule = Type.Object({
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    condition: Type.String({ minLength: 1, maxLength: 2_000 }),
    deduction: positiveScore,
    maxDeduction: positiveScore,
    occurrence: Type.Union([Type.Literal("once"), Type.Literal("per-occurrence")]),
    evidenceRequired: Type.Boolean(),
    overlapGroup: Type.Optional(id),
  }, { additionalProperties: false });
  const bonusRule = Type.Object({
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    condition: Type.String({ minLength: 1, maxLength: 2_000 }),
    bonus: positiveScore,
    maxBonus: positiveScore,
    occurrence: Type.Union([Type.Literal("once"), Type.Literal("per-occurrence")]),
    evidenceRequired: Type.Boolean(),
    overlapGroup: Type.Optional(id),
  }, { additionalProperties: false });

  if (mode === "additive") return Type.Object({
    schemaVersion: Type.Literal("1.0"),
    mode: Type.Literal("additive"),
    totalScore: positiveScore,
    partialCreditAllowed: Type.Boolean(),
    criteria: Type.Array(criterion, { minItems: 1, maxItems: 40 }),
  }, { additionalProperties: false });
  if (mode === "deductive") return Type.Object({
    schemaVersion: Type.Literal("1.0"),
    mode: Type.Literal("deductive"),
    totalScore: positiveScore,
    rules: Type.Array(deductionRule, { minItems: 1, maxItems: 80 }),
    overlapGroups: Type.Array(overlapGroup, { maxItems: 40 }),
  }, { additionalProperties: false });
  return Type.Object({
    schemaVersion: Type.Literal("1.0"),
    mode: Type.Literal("hybrid"),
    totalScore: positiveScore,
    partialCreditAllowed: Type.Boolean(),
    criteria: Type.Array(criterion, { minItems: 1, maxItems: 40 }),
    bonusRules: Type.Array(bonusRule, { maxItems: 40 }),
    deductionRules: Type.Array(deductionRule, { maxItems: 80 }),
    overlapGroups: Type.Array(overlapGroup, { maxItems: 40 }),
  }, { additionalProperties: false });
}
