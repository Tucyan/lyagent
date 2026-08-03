export function sseFrame(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

export function sseComment(value: string): string {
  return `: ${value.replace(/[\r\n]/g, " ")}\n\n`;
}
