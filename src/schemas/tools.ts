import type { AgentKey } from "./messages.js";
import type { Workspace } from "../core/workspace.js";

export interface ToolContext {
  agentKey: AgentKey;
  workspace: Workspace;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolContext,
) => TOutput | Promise<TOutput>;
