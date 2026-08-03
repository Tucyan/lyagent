import type { Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { AgentExecutionResult, AgentRequest } from "../schemas/messages.js";

export type PiAgentHandle = Pick<PiAgent, "prompt">;
export type PiAgentFactory = (request: AgentRequest) => PiAgentHandle | Promise<PiAgentHandle>;

export class AgentRuntime {
  constructor(private readonly createAgent: PiAgentFactory) {}

  async run(request: AgentRequest): Promise<AgentExecutionResult> {
    const agent = await this.createAgent(request);
    await agent.prompt(request.prompt);
    return {
      agentKey: request.agentKey,
      prompt: request.prompt,
      completed: true,
    };
  }
}
