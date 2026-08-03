import type { AgentKey, InboundMessage } from "../schemas/messages.js";

const pageRoutes: Record<string, AgentKey> = {
  "material-import": "material-import",
  "course-qa": "course-qa",
  "rubric-designer": "rubric-designer",
  "assignment-grader": "assignment-grader",
};

export class AgentRouter {
  route(message: InboundMessage): AgentKey {
    const requestedAgent = message.metadata?.agentKey;
    if (typeof requestedAgent === "string") {
      const route = pageRoutes[requestedAgent];
      if (route) return route;
    }

    const page = message.metadata?.page;
    if (typeof page === "string") {
      const route = pageRoutes[page];
      if (route) return route;
    }

    return "course-qa";
  }
}
