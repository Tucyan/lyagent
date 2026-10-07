import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

export interface AgentExecutionLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export type AgentExecutionLimitCode = "AGENT_TURN_LIMIT" | "AGENT_TOOL_CALL_LIMIT" | "AGENT_TIMEOUT";

export class AgentExecutionLimitError extends Error {
  constructor(public readonly code: AgentExecutionLimitCode) {
    const messages: Record<AgentExecutionLimitCode, string> = {
      AGENT_TURN_LIMIT: "模型处理轮次已达到上限，请检查输入后重试。",
      AGENT_TOOL_CALL_LIMIT: "模型工具调用次数已达到上限，请检查输入后重试。",
      AGENT_TIMEOUT: "模型处理超时，请稍后重试。",
    };
    super(messages[code]);
    this.name = "AgentExecutionLimitError";
  }
}

/** One budget per business operation, shared by all its prompts and agents. */
export class AgentExecutionBudget {
  private readonly limits: AgentExecutionLimits;
  private readonly deadline: number;
  private turns = 0;
  private toolCalls = 0;
  private failure: Error | undefined;

  constructor(limits: Partial<AgentExecutionLimits> = {}, private readonly signal?: AbortSignal) {
    this.limits = { maxTurns: 64, maxToolCalls: 128, timeoutMs: 10 * 60_000, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Agent execution limits must be positive safe integers");
    }
    this.deadline = Date.now() + this.limits.timeoutMs;
  }

  async run<T>(agent: Pick<Agent, "abort" | "subscribe">, action: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.signal?.aborted) throw new DOMException("运行已取消", "AbortError");
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      this.failure = new AgentExecutionLimitError("AGENT_TIMEOUT");
      throw this.failure;
    }
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      agent.abort();
      rejectStop(error);
    };
    const activeTools = new Set<string>();
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") activeTools.add(event.toolCallId);
      if (event.type === "tool_execution_end") activeTools.delete(event.toolCallId);
      if (event.type === "turn_start" && ++this.turns > this.limits.maxTurns) stop(new AgentExecutionLimitError("AGENT_TURN_LIMIT"));
      if (event.type === "tool_execution_start" && ++this.toolCalls > this.limits.maxToolCalls) stop(new AgentExecutionLimitError("AGENT_TOOL_CALL_LIMIT"));
    });
    const abort = () => stop(new DOMException("运行已取消", "AbortError"));
    this.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new AgentExecutionLimitError("AGENT_TIMEOUT")), remaining);
    const running = action();
    try {
      const result = await Promise.race([running, stopped]);
      if (this.failure) throw this.failure;
      return result;
    } catch (error) {
      // A filesystem mutation already admitted by Pi cannot be rolled back by
      // abort(). Keep ownership until it settles, so no write can happen after
      // the caller reports a terminal state or admits a replacement run.
      if (activeTools.size > 0) await running.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      this.signal?.removeEventListener("abort", abort);
    }
  }
}
