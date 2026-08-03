export function assignmentIdFromSearch(search: string): string | undefined {
  const assignmentId = new URLSearchParams(search).get("assignment")?.trim();
  return assignmentId || undefined;
}
