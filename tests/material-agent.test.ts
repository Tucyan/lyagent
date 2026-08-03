import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiMaterialPlanner } from "../src/agents/material-import/agent.js";

describe("material import Pi planner", () => {
  it("accepts only the submitted structured plan from its single write-free tool", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall("submit_knowledge_plan", {
        documents: [{ path: "01-概述/AI.md", title: "AI", sectionIds: ["source.md#0"] }],
      }),
    ], { stopReason: "toolUse" })]);

    const planner = createPiMaterialPlanner({ models, model: faux.getModel() });
    const plan = await planner([{ id: "source.md#0", sourcePath: "source.md", title: "AI", content: "# AI\n正文" }]);

    expect(plan).toEqual({ documents: [{ path: "01-概述/AI.md", title: "AI", sectionIds: ["source.md#0"] }] });
  });

  it("rejects an incomplete tool submission and lets the model correct it", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_knowledge_plan", {
        documents: [{ path: "one.md", title: "One", sectionIds: ["source.md#0"] }],
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("submit_knowledge_plan", {
        documents: [{ path: "one.md", title: "One", sectionIds: ["source.md#0", "source.md#1"] }],
      })], { stopReason: "toolUse" }),
    ]);

    const plan = await createPiMaterialPlanner({ models, model: faux.getModel() })([
      { id: "source.md#0", sourcePath: "source.md", title: "One", content: "# One" },
      { id: "source.md#1", sourcePath: "source.md", title: "Two", content: "# Two" },
    ]);

    expect(plan.documents[0]?.sectionIds).toEqual(["source.md#0", "source.md#1"]);
  });
});
