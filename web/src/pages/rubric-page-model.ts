import {
  normalizeRubric,
  type AnyRubricLike,
  type NormalizedAdjustmentRule,
} from "../../../src/schemas/rubric-engine.js";

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

export function resolveRubricPreviewPercent(input: {
  customPreviewPercent?: number;
  frozenWithoutDraft: boolean;
  messageCount: number;
}): number {
  if (typeof input.customPreviewPercent === "number") {
    return clampPreviewPercent(input.customPreviewPercent);
  }
  return input.frozenWithoutDraft && input.messageCount === 0 ? 58 : 38;
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

export type RubricLevelTone = "tier-high" | "tier-good" | "tier-mid" | "tier-low" | "tier-fail";

export interface RubricPreviewSection {
  title: string;
  rows: Array<{
    targetKey?: string;
    title: string;
    score: string;
    description: string;
    detail: string;
    levels?: Array<{ id: string; label: string; tone: RubricLevelTone; score: string; condition: string }>;
  }>;
}

export function rubricPreviewSections(rubric: AnyRubricLike): RubricPreviewSection[] {
  const normalized = normalizeRubric(rubric);
  const sections: RubricPreviewSection[] = [];
  if (normalized.mode === "additive" || normalized.mode === "hybrid") {
    sections.push({
      title: "评分项目",
      rows: normalized.criteria.map((criterion, index) => ({
        targetKey: `criterion:${index}`,
        title: criterion.name,
        score: `${criterion.maxScore} 分`,
        description: criterion.description,
        detail: `${criterion.scoringType === "levels" ? "按档定分" : `区间打分（步长 ${criterion.step}）`} · ${criterion.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"}`,
        ...(criterion.levels.length > 0
          ? {
              levels: criterion.levels.map((level) => ({
                id: level.id,
                label: level.label ?? rubricLevelLabel(level.id),
                tone: rubricLevelTone(level, criterion.maxScore),
                score: `${level.minScore === level.maxScore ? level.minScore : `${level.minScore}–${level.maxScore}`} 分`,
                condition: level.condition,
              })),
            }
          : {}),
      })),
    });
  }
  if (normalized.bonusRules.length > 0) {
    sections.push({
      title: "加分规则",
      rows: normalized.bonusRules.map((rule, index) => ({
        targetKey: `bonus:${index}`,
        ...rulePreview(rule, "bonus"),
      })),
    });
  }
  if (normalized.deductionRules.length > 0) {
    sections.push({
      title: "扣分规则",
      rows: normalized.deductionRules.map((rule, index) => ({
        targetKey: `deduction:${index}`,
        ...rulePreview(rule, "deduction"),
      })),
    });
  }
  if (normalized.scoreCaps.length > 0) {
    sections.push({
      title: "条件总分封顶",
      rows: normalized.scoreCaps.map((cap, index) => ({
        targetKey: `scoreCap:${index}`,
        title: cap.name,
        score: `≤ ${cap.maxTotalScore} 分`,
        description: cap.condition,
        detail: `触发时总分封顶 · ${cap.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"}`,
      })),
    });
  }
  if (normalized.mode !== "additive" && normalized.overlapGroups.length > 0) {
    sections.push({
      title: "重叠规则组",
      rows: normalized.overlapGroups.map((group, index) => ({
        targetKey: `group:${index}`,
        title: group.id,
        score: group.aggregation === "highest-only" ? "仅取最高项" : "累计",
        description: group.aggregation === "highest-only" ? "同组规则同时触发时只采用扣分或加分最高的一项。" : "同组规则同时触发时按各规则累计。",
        detail: "规则组聚合方式",
      })),
    });
  }
  return sections;
}

export function rubricProblemTargetKey(rubric: AnyRubricLike | undefined, problemPath?: string): string | undefined {
  if (!rubric || !problemPath) return undefined;
  const normalized = normalizeRubric(rubric);
  const segments = problemPath.split(".");
  const section = segments[0];
  const idOrIndex = segments[1];
  if (section === "criteria" && idOrIndex) {
    const idx = normalized.criteria.findIndex((item) => item.id === idOrIndex);
    if (idx >= 0) return `criterion:${idx}`;
  }
  if ((section === "rules" || section === "deductionRules") && idOrIndex) {
    const idx = normalized.deductionRules.findIndex((item) => item.id === idOrIndex);
    if (idx >= 0) return `deduction:${idx}`;
  }
  if (section === "bonusRules" && idOrIndex) {
    const idx = normalized.bonusRules.findIndex((item) => item.id === idOrIndex);
    if (idx >= 0) return `bonus:${idx}`;
  }
  if (section === "scoreCaps" && idOrIndex) {
    const idx = normalized.scoreCaps.findIndex((item) => item.id === idOrIndex);
    if (idx >= 0) return `scoreCap:${idx}`;
  }
  if (section === "overlapGroups") return "group:0";
  return undefined;
}

export function rubricLevelLabel(id: string): string {
  const normalized = id.trim().toLowerCase();
  const suffix = normalized.split(/[_\-\s]+/).at(-1) ?? normalized;
  const labels: Record<string, string> = {
    excellent: "优秀",
    outstanding: "优秀",
    superior: "优秀",
    good: "良好",
    proficient: "良好",
    medium: "中等",
    average: "中等",
    fair: "中等",
    moderate: "中等",
    pass: "合格",
    passing: "合格",
    basic: "合格",
    satisfactory: "合格",
    marginal: "勉强合格",
    poor: "较差",
    fail: "不合格",
    failing: "不合格",
    unsatisfactory: "不合格",
    none: "未达标",
    missing: "缺失",
    full: "达标",
    zero: "未达标",
  };
  return labels[suffix] ?? labels[normalized] ?? id;
}

export function rubricLevelTone(
  level: { id: string; minScore: number; maxScore: number },
  criterionMaxScore: number,
): RubricLevelTone {
  const suffix = level.id.trim().toLowerCase().split(/[_\-\s]+/).at(-1) ?? "";
  if (["fail", "failing", "unsatisfactory", "missing", "none", "zero"].includes(suffix)) return "tier-fail";
  if (["poor", "marginal"].includes(suffix)) return "tier-low";
  const safeMax = criterionMaxScore > 0 ? criterionMaxScore : Math.max(level.maxScore, 1);
  const midpointRatio = ((level.minScore + level.maxScore) / 2) / safeMax;
  if (midpointRatio >= 0.8) return "tier-high";
  if (midpointRatio >= 0.6) return "tier-good";
  if (midpointRatio >= 0.4) return "tier-mid";
  if (midpointRatio >= 0.2) return "tier-low";
  return "tier-fail";
}

function rulePreview(
  rule: NormalizedAdjustmentRule,
  kind: "bonus" | "deduction",
): RubricPreviewSection["rows"][number] {
  const sign = kind === "bonus" ? "+" : "−";
  const score = rule.policy === "fixed"
    ? `${sign}${rule.amount} 分（固定一次）`
    : rule.policy === "per-occurrence"
      ? `${sign}${rule.unitAmount} 分/次（上限 ${rule.maxAmount}）`
      : `${sign}${rule.minAmount}–${rule.maxAmount} 分（步长 ${rule.step}）`;
  const policyText = rule.policy === "fixed"
    ? "固定一次"
    : rule.policy === "per-occurrence"
      ? "按次累计"
      : "区间酌情";
  return {
    title: rule.name,
    score,
    description: rule.condition,
    detail: `${policyText} · ${rule.evidenceRequired ? "需要评分分析依据" : "不强制分析依据"}${rule.overlapGroup ? ` · 重叠组：${rule.overlapGroup}` : ""}`,
  };
}
