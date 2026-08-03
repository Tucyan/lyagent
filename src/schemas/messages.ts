export type AgentKey =
  | "material-import"
  | "course-qa"
  | "rubric-designer"
  | "assignment-grader";

export type Channel = "web" | "wecom";

export interface InboundMessage {
  id: string;
  channel: Channel;
  userId: string;
  text: string;
  courseId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRequest {
  agentKey: AgentKey;
  prompt: string;
  message: InboundMessage;
}

export interface AgentExecutionResult {
  agentKey: AgentKey;
  prompt: string;
  completed: boolean;
}
