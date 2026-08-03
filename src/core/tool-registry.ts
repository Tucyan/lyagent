import type { ToolContext, ToolHandler } from "../schemas/tools.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();

  register<TInput, TOutput>(name: string, handler: ToolHandler<TInput, TOutput>): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.tools.set(name, handler as ToolHandler);
  }

  list(): string[] {
    return [...this.tools.keys()].sort();
  }

  async execute<TOutput>(name: string, input: unknown, context: ToolContext): Promise<TOutput> {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return (await handler(input, context)) as TOutput;
  }
}
