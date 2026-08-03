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
export function createRubricDesignerTools(rubricService: RubricService, assignmentId: string): RubricDesignerTools {
  let question: RubricQuestion | undefined;
  let updatedDraft: RubricDraft | undefined;
  const emptySchema = Type.Object({});
  const rubricValue = Type.Object({}, { additionalProperties: true });

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
    description: "Create the first editable rubric draft for this session. Its totalScore must match the assignment exactly.",
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
    description: "Replace the current editable draft. Read the draft first and supply its exact version as expectedVersion.",
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
