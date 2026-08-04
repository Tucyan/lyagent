import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDeepSeekRubricDesignerFactory } from "../src/agents/rubric-designer/deepseek.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { RubricService } from "../src/services/rubric-service.js";

const enabled = process.env.RUN_REAL_AI === "1";
let root: string | undefined;

describe.runIf(enabled)("rubric real provider acceptance", () => {
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("creates a valid source-led draft through the configured model and tools", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rubric-real-ai-"));
    const config = await loadAppConfig(path.resolve("workspace"));
    const service = new RubricService(root);
    const assignment = await service.createAssignment({
      title: "Real provider rubric acceptance",
      totalScore: 100,
      requirements: "",
      sources: [{ role: "rubric_draft", name: "draft.txt", content: "Report: analysis 40, evidence 30, examples 20, writing 10. Deduct for unsupported claims." }],
    });
    await service.selectMode(assignment.id, "deductive");
    const designer = createDeepSeekRubricDesignerFactory(config.deepseekApiKey).factory?.(assignment.id, service);
    if (!designer) throw new Error("Configured rubric designer is unavailable");

    const recommendation = await designer.recommendModes(["Report: analysis 40, evidence 30, examples 20, writing 10. Deduct for unsupported claims."]);
    expect(recommendation.options).toHaveLength(3);
    expect(recommendation.options.filter((option) => option.recommended)).toHaveLength(1);

    const events: string[] = [];
    let visibleText = "";
    let outcome: Awaited<ReturnType<typeof designer.design>>;
    try {
      outcome = await designer.design("Create the first rubric draft from the assignment source.", (event) => {
        events.push(event.type === "tool_start" ? `${event.type}:${event.name}` : event.type);
        if (event.type === "process_delta") visibleText = `${visibleText}${event.delta}`.slice(-2_000);
      });
    } catch (error) {
      throw new Error(`${(error as Error).message}; safe events: ${events.join(", ")}; visible assistant text: ${visibleText}`);
    }

    expect(outcome.kind).toBe("draft");
    expect(await service.getDraft(assignment.id)).toMatchObject({ rubric: { mode: "deductive", totalScore: 100 } });
    expect(events.some((event) => event.startsWith("tool_start:"))).toBe(true);
    expect(events).toContain("tool_end");

    const draftBeforeAdvice = await service.getDraft(assignment.id);
    const replyDeltas: string[] = [];
    const advice = await designer.design("现在的评分标准有进一步改进的建议吗？请只给建议，不要修改草稿。", (event) => {
      if (event.type === "reply_delta") replyDeltas.push(event.delta);
    });
    expect(advice.kind).toBe("reply");
    if (advice.kind === "reply") {
      expect(advice.reply.length).toBeGreaterThan(10);
      expect(replyDeltas.join("")).toBe(advice.reply);
    }
    expect(replyDeltas.length).toBeGreaterThan(0);
    expect(await service.getDraft(assignment.id)).toEqual(draftBeforeAdvice);
  }, 120_000);
});
