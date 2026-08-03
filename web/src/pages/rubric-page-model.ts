export function assignmentIdFromSearch(search: string): string | undefined {
  const assignmentId = new URLSearchParams(search).get("assignment")?.trim();
  return assignmentId || undefined;
}

export async function loadRubricSession<TAssignment, TDraft, TRecommendation>(input: {
  assignment: () => Promise<TAssignment>;
  draft: () => Promise<TDraft>;
  recommendations: () => Promise<TRecommendation>;
  onCore: (assignment: TAssignment, draft: TDraft) => void;
  onRecommendations: (recommendations: TRecommendation) => void;
}): Promise<void> {
  const recommendations = input.recommendations();
  const [assignment, draft] = await Promise.all([input.assignment(), input.draft()]);
  input.onCore(assignment, draft);
  input.onRecommendations(await recommendations);
}
