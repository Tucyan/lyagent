const VISIBLE_TOOL_STEP_COUNT = 5;

export function visibleToolSteps<T>(steps: T[], expanded: boolean): T[] {
  return expanded || steps.length <= VISIBLE_TOOL_STEP_COUNT ? steps : steps.slice(-VISIBLE_TOOL_STEP_COUNT);
}

export function appendProcessText(current: string | undefined, delta: string): string {
  return `${current ?? ""}${delta}`;
}

export function shouldOpenProcess(isStreamingMessage: boolean): boolean {
  return isStreamingMessage;
}
