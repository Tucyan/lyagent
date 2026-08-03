import { describe, expect, it } from "vitest";
import { AgentRouter } from "../src/core/agent-router.js";
import { AgentRuntime } from "../src/core/agent-runtime.js";
import { MessageBus } from "../src/core/message-bus.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { Workspace, WorkspacePathError } from "../src/core/workspace.js";

describe("phase 1 core", () => {
  it("confines paths to the workspace", () => {
    const workspace = new Workspace("C:/course-agent-workspace");
    expect(workspace.resolve("knowledge/course-1")).toBe("C:\\course-agent-workspace\\knowledge\\course-1");
    expect(() => workspace.resolve("../outside")).toThrow(WorkspacePathError);
    expect(() => workspace.resolve("C:/outside")).toThrow(WorkspacePathError);
  });

  it("publishes messages and supports unsubscribe", async () => {
    const bus = new MessageBus<{ id: string }>();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((message) => {
      received.push(message.id);
    });
    await bus.publish({ id: "one" });
    unsubscribe();
    await bus.publish({ id: "two" });
    expect(received).toEqual(["one"]);
  });

  it("executes only registered tools", async () => {
    const tools = new ToolRegistry();
    tools.register("echo", async (input: unknown) => input);
    expect(await tools.execute<string>("echo", "ok", {} as never)).toBe("ok");
    await expect(tools.execute("missing", null, {} as never)).rejects.toThrow("Unknown tool");
  });

  it("routes management pages and defaults chat to course QA", () => {
    const router = new AgentRouter();
    const base = { id: "1", channel: "web" as const, userId: "local", text: "" };
    expect(router.route({ ...base, metadata: { page: "rubric-designer" } })).toBe("rubric-designer");
    expect(router.route(base)).toBe("course-qa");
  });

  it("runs a Pi-compatible agent without requiring credentials", async () => {
    let prompt = "";
    const runtime = new AgentRuntime(async () => ({
      prompt: async (value: unknown) => {
        if (typeof value === "string") {
          prompt = value;
        }
      },
    }));
    const message = { id: "1", channel: "web" as const, userId: "local", text: "hello" };
    await expect(runtime.run({ agentKey: "course-qa", prompt: "hello", message })).resolves.toMatchObject({
      completed: true,
    });
    expect(prompt).toBe("hello");
  });
});
