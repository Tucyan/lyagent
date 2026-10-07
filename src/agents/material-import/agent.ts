import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model, type Models } from "@earendil-works/pi-ai";
import { AgentExecutionBudget, type AgentExecutionLimits } from "../../core/agent-execution-budget.js";
import type { KnowledgePlan, SourceSection } from "../../services/material-service.js";

export interface PiMaterialPlannerOptions {
  executionLimits?: Partial<AgentExecutionLimits>;
  models: Models;
  model: Model<any>;
  getApiKey?: () => string | undefined;
}

/**
 * Pi may only submit a structure. The service owns source slicing, paths,
 * writes, validation, release IDs, and activation.
 */
export function createPiMaterialPlanner(options: PiMaterialPlannerOptions): (sections: SourceSection[]) => Promise<KnowledgePlan> {
  return async (sections) => {
    const budget = new AgentExecutionBudget(options.executionLimits);
    let submittedPlan: KnowledgePlan | undefined;
    const expectedSectionIds = new Set(sections.map((section) => section.id));
    let submissionAttempts = 0;
    const planSchema = Type.Object({
      documents: Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        sectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }), { minItems: 1 }),
    });
    const tool: AgentTool<typeof planSchema> = {
      name: "submit_knowledge_plan",
      label: "Submit knowledge plan",
      description: "Submit the complete knowledge-document plan. Each supplied section ID must appear exactly once.",
      parameters: planSchema,
      executionMode: "sequential",
      execute: async (_toolCallId, parameters) => {
        if (submittedPlan) throw new Error("A knowledge plan has already been submitted");
        submissionAttempts += 1;
        if (submissionAttempts > 3) throw new Error("Knowledge plan submission limit reached");
        const candidate = { documents: parameters.documents.map((document) => ({ ...document, sectionIds: [...document.sectionIds] })) };
        const received = candidate.documents.flatMap((document) => document.sectionIds);
        const missing = [...expectedSectionIds].filter((id) => !received.includes(id));
        const duplicate = received.find((id, index) => received.indexOf(id) !== index);
        const unknown = received.find((id) => !expectedSectionIds.has(id));
        if (missing.length > 0 || duplicate || unknown) {
          throw new Error(`Plan must contain every source section exactly once. Missing: ${missing.join(", ") || "none"}; duplicate: ${duplicate ?? "none"}; unknown: ${unknown ?? "none"}`);
        }
        submittedPlan = candidate;
        return { content: [{ type: "text", text: "Plan captured. Do not make another tool call." }], details: {}, terminate: true };
      },
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: [
          "You organize course source sections into a concise local knowledge tree.",
          "Do not invent content, rewrite source text, or omit a section.",
          "Use only the submit_knowledge_plan tool once. Paths must end in .md and be relative.",
        ].join("\n"),
        model: options.model,
        thinkingLevel: "off",
        tools: [tool],
      },
      streamFn: options.models.streamSimple.bind(options.models),
      ...(options.getApiKey ? { getApiKey: () => options.getApiKey?.() } : {}),
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => toolCall.name === "submit_knowledge_plan" ? undefined : { block: true, reason: "Tool is not allowed" },
    });
    await budget.run(agent, () => agent.prompt(renderSourceInventory(sections)));
    if (!submittedPlan) throw new Error("Model did not submit a knowledge plan");
    return submittedPlan;
  };
}

function renderSourceInventory(sections: SourceSection[]): string {
  const inventory = sections.map((section) => ({
    id: section.id,
    sourcePath: section.sourcePath,
    title: section.title,
    excerpt: section.content.slice(0, 600),
  }));
  return `Organize these source sections. Every id must appear exactly once.\n${JSON.stringify(inventory)}`;
}
