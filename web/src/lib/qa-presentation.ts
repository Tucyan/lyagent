const VISIBLE_TOOL_STEP_COUNT = 5;

export function visibleToolSteps<T>(steps: T[], expanded: boolean): T[] {
  return expanded || steps.length <= VISIBLE_TOOL_STEP_COUNT ? steps : steps.slice(-VISIBLE_TOOL_STEP_COUNT);
}

export interface CollapsibleToolStep {
  id: string;
  label: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

export interface CollapsedToolStep extends CollapsibleToolStep {
  count: number;
}

/**
 * Merges consecutive identical tool calls (same label, summary, and status)
 * into a single step with an execution count badge, keeping chronological order.
 */
export function collapseConsecutiveToolSteps<T extends CollapsibleToolStep>(steps: T[]): CollapsedToolStep[] {
  const collapsed: CollapsedToolStep[] = [];
  for (const step of steps) {
    const previous = collapsed.at(-1);
    if (
      previous &&
      previous.label === step.label &&
      previous.summary === step.summary &&
      previous.status === step.status
    ) {
      previous.count += 1;
      previous.id = step.id;
    } else {
      collapsed.push({
        id: step.id,
        label: step.label,
        summary: step.summary,
        status: step.status,
        count: 1,
      });
    }
  }
  return collapsed;
}

export function appendProcessText(current: string | undefined, delta: string): string {
  return `${current ?? ""}${delta}`;
}

export function shouldOpenProcess(isStreamingMessage: boolean): boolean {
  return isStreamingMessage;
}
