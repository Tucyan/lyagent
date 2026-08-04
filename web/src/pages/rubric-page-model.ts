export function assignmentIdFromSearch(search: string): string | undefined {
  const assignmentId = new URLSearchParams(search).get("assignment")?.trim();
  return assignmentId || undefined;
}

export async function loadRubricSession<TAssignment, TDraft, TSession, TRecommendation>(input: {
  assignment: () => Promise<TAssignment>;
  draft: () => Promise<TDraft>;
  session: () => Promise<TSession | null>;
  recommendations: () => Promise<TRecommendation>;
  onCore: (assignment: TAssignment, draft: TDraft, session: TSession | null) => void;
  onRecommendations: (recommendations: TRecommendation) => void;
}): Promise<void> {
  const [assignment, draft, session] = await Promise.all([input.assignment(), input.draft(), input.session()]);
  input.onCore(assignment, draft, session);
  if (session) return;
  input.onRecommendations(await input.recommendations());
}

export function clampPreviewPercent(value: number): number {
  return Math.min(72, Math.max(28, Math.round(value)));
}

export function assertRubricStreamSucceeded(errorMessage?: string): void {
  if (errorMessage) throw new Error(errorMessage);
}

export function appendRubricProcess(current: string, delta: string): string {
  return `${current}${delta}`.slice(0, 12_000);
}

export function appendRubricReply(current: string, delta: string): string {
  return `${current}${delta}`.slice(0, 8_000);
}

export function shouldFollowRubricStream(distanceFromBottom: number): boolean {
  return distanceFromBottom <= 96;
}

export function rubricCompletionNotice(kind: "question" | "reply" | "draft" | undefined): string {
  if (kind === "reply") return "Agent 已回复，本轮未修改评分表草稿。";
  if (kind === "question") return "Agent 正在等待你的补充，本轮未修改评分表草稿。";
  return "本轮设计已完成；处理过程已折叠，草稿可继续人工编辑或让 Agent 修改。";
}

export function rubricDeleteWarning(title: string): string {
  return `“${title}”的参考资料、聊天记录、当前草稿和全部冻结正式版本都将从本机永久删除，无法恢复。`;
}

export interface RubricPreviewSection {
  title: string;
  rows: Array<{ title: string; score: string; description: string; detail: string; levels?: Array<{ id: string; score: string; condition: string }> }>;
}

type PreviewRubric = {
  schemaVersion?: "1.0";
  mode: "additive" | "deductive" | "hybrid";
  totalScore?: number;
  partialCreditAllowed?: boolean;
  overlapGroups?: Array<{ id: string; aggregation: "highest-only" | "sum" }>;
  criteria?: Array<{ id?: string; name: string; description: string; maxScore: number; scorePolicy: "exact-level" | "range" | "continuous"; evidenceRequired: boolean; levels?: Array<{ id: string; minScore: number; maxScore: number; condition: string }> }>;
  rules?: Array<{ name: string; condition: string; deduction: number; maxDeduction: number; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string }>;
  bonusRules?: Array<{ name: string; condition: string; bonus: number; maxBonus: number; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string }>;
  deductionRules?: Array<{ name: string; condition: string; deduction: number; maxDeduction: number; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string }>;
};

export function rubricPreviewSections(rubric: PreviewRubric): RubricPreviewSection[] {
  const sections: RubricPreviewSection[] = [];
  if (rubric.mode === "additive" || rubric.mode === "hybrid") {
    sections.push({
      title: "评分项目",
      rows: (rubric.criteria ?? []).map((criterion) => ({
        title: criterion.name,
        score: `${criterion.maxScore} 分`,
        description: criterion.description,
        detail: `${scorePolicyLabel(criterion.scorePolicy)} · ${criterion.evidenceRequired ? "需要证据" : "不强制证据"}`,
        ...((criterion.levels?.length ?? 0) > 0 ? { levels: criterion.levels!.map((level) => ({ id: level.id, score: `${level.minScore === level.maxScore ? level.minScore : `${level.minScore}–${level.maxScore}`} 分`, condition: level.condition })) } : {}),
      })),
    });
  }
  if (rubric.mode === "hybrid" && (rubric.bonusRules?.length ?? 0) > 0) {
    sections.push({ title: "加分规则", rows: rubric.bonusRules!.map((rule) => rulePreview(rule, "bonus")) });
  }
  const deductionRules = rubric.mode === "deductive" ? rubric.rules ?? [] : rubric.mode === "hybrid" ? rubric.deductionRules ?? [] : [];
  if (deductionRules.length > 0) sections.push({ title: "扣分规则", rows: deductionRules.map((rule) => rulePreview(rule, "deduction")) });
  if (rubric.mode !== "additive" && (rubric.overlapGroups?.length ?? 0) > 0) {
    sections.push({
      title: "重叠规则组",
      rows: rubric.overlapGroups!.map((group) => ({
        title: group.id,
        score: group.aggregation === "highest-only" ? "仅取最高项" : "累计",
        description: group.aggregation === "highest-only" ? "同组规则同时触发时只采用扣分或加分最高的一项。" : "同组规则同时触发时按各规则累计。",
        detail: "规则组聚合方式",
      })),
    });
  }
  return sections;
}

function scorePolicyLabel(policy: "exact-level" | "range" | "continuous"): string {
  if (policy === "exact-level") return "等级定分";
  if (policy === "range") return "区间评分";
  return "连续评分";
}

function rulePreview(
  rule: { name: string; condition: string; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string; bonus?: number; maxBonus?: number; deduction?: number; maxDeduction?: number },
  kind: "bonus" | "deduction",
): RubricPreviewSection["rows"][number] {
  const amount = kind === "bonus" ? rule.bonus ?? 0 : rule.deduction ?? 0;
  const maximum = kind === "bonus" ? rule.maxBonus ?? amount : rule.maxDeduction ?? amount;
  return {
    title: rule.name,
    score: `${kind === "bonus" ? "+" : "−"}${amount} 分（上限 ${maximum}）`,
    description: rule.condition,
    detail: `${rule.occurrence === "once" ? "仅一次" : "按次计算"} · ${rule.evidenceRequired ? "需要证据" : "不强制证据"}${rule.overlapGroup ? ` · 重叠组：${rule.overlapGroup}` : ""}`,
  };
}
