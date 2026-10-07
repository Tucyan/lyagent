import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentExecutionBudget, AgentExecutionLimitError } from "../src/core/agent-execution-budget.js";

function controlledAgent() {
  type Listener = Parameters<Agent["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const signal = new AbortController().signal;
  return {
    abort: vi.fn(),
    subscribe: (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (event: AgentEvent) => { for (const listener of listeners) void listener(event, signal); },
    listeners,
  };
}

describe("Agent execution budget", () => {
  it("retains task ownership until an admitted tool finishes after cancellation", async () => {
    const controller = new AbortController();
    const agent = controlledAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutation = false;
    let settled = false;
    const running = new AgentExecutionBudget({}, controller.signal).run(agent, async () => {
      agent.emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write_draft", args: {} });
      await gate;
      mutation = true;
      agent.emit({ type: "tool_execution_end", toolCallId: "write", toolName: "write_draft", result: {}, isError: false });
    });
    const outcome = running.catch((error: Error) => { settled = true; return error; });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeTool = settled;
    release();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(settledBeforeTool).toBe(false);
    expect(mutation).toBe(true);
    expect(agent.listeners.size).toBe(0);
  });

  it("shares the model turn budget across prompts and fallback agents", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
    const makeAgent = () => new Agent({ initialState: { model: faux.getModel() }, streamFn: models.streamSimple.bind(models) });
    const budget = new AgentExecutionBudget({ maxTurns: 1 });
    const first = makeAgent();
    await budget.run(first, () => first.prompt("one"));
    const fallback = makeAgent();
    await expect(budget.run(fallback, () => fallback.prompt("two"))).rejects.toMatchObject({ code: "AGENT_TURN_LIMIT" });
  });

  it("aborts a batch of tool calls at the configured limit", async () => {
    const agent = controlledAgent();
    const budget = new AgentExecutionBudget({ maxToolCalls: 2 });
    await expect(budget.run(agent, async () => {
      for (let n = 0; n < 3; n++) agent.emit({ type: "tool_execution_start", toolCallId: `${n}`, toolName: "invalid", args: {} });
    })).rejects.toMatchObject({ code: "AGENT_TOOL_CALL_LIMIT" });
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(agent.listeners.size).toBe(0);
  });

  it("times out a stalled request and removes its listeners", async () => {
    vi.useFakeTimers();
    try {
      const agent = controlledAgent();
      const running = new AgentExecutionBudget({ timeoutMs: 100 }).run(agent, () => new Promise<void>(() => {}));
      const result = expect(running).rejects.toBeInstanceOf(AgentExecutionLimitError);
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(agent.abort).toHaveBeenCalledOnce();
      expect(agent.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps one total deadline across prompts", async () => {
    vi.useFakeTimers();
    try {
      const budget = new AgentExecutionBudget({ timeoutMs: 100 });
      const agent = controlledAgent();
      await budget.run(agent, async () => {});
      await vi.advanceTimersByTimeAsync(80);
      const running = budget.run(agent, () => new Promise<void>(() => {}));
      const result = expect(running).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await result;
    } finally { vi.useRealTimers(); }
  });

  it("honors cancellation before starting a provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const action = vi.fn();
    await expect(new AgentExecutionBudget({}, controller.signal).run(controlledAgent(), action)).rejects.toMatchObject({ name: "AbortError" });
    expect(action).not.toHaveBeenCalled();
  });

  it("honors cancellation while the provider is stalled", async () => {
    const controller = new AbortController();
    const agent = controlledAgent();
    const running = new AgentExecutionBudget({}, controller.signal).run(agent, () => new Promise<void>(() => {}));
    const result = expect(running).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(agent.listeners.size).toBe(0);
  });
});
