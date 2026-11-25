export type ScoreStep = 1 | 0.5 | 0.1 | 0.01;
export type RubricMode = "additive" | "deductive" | "hybrid";

export interface NormalizedLevel {
  id: string;
  label?: string;
  minScore: number;
  maxScore: number;
  condition: string;
}

export interface NormalizedCriterion {
  id: string;
  name: string;
  description: string;
  maxScore: number;
  scoringType: "levels" | "scored";
  step: ScoreStep;
  binaryOnly: boolean;
  evidenceRequired: boolean;
  levels: NormalizedLevel[];
}

export type NormalizedAdjustmentRule =
  | {
      id: string;
      name: string;
      condition: string;
      policy: "fixed";
      amount: number;
      maxAmount: number;
      evidenceRequired: boolean;
      overlapGroup?: string;
    }
  | {
      id: string;
      name: string;
      condition: string;
      policy: "per-occurrence";
      unitAmount: number;
      maxAmount: number;
      evidenceRequired: boolean;
      overlapGroup?: string;
    }
  | {
      id: string;
      name: string;
      condition: string;
      policy: "range";
      minAmount: number;
      maxAmount: number;
      step: ScoreStep;
      evidenceRequired: boolean;
      overlapGroup?: string;
    };

export interface NormalizedScoreCap {
  id: string;
  name: string;
  condition: string;
  maxTotalScore: number;
  evidenceRequired: boolean;
}

export interface NormalizedOverlapGroup {
  id: string;
  aggregation: "highest-only" | "sum";
}

export interface NormalizedRubric {
  schemaVersion: "1.0" | "2.0";
  mode: RubricMode;
  totalScore: number;
  partialCreditAllowed?: boolean;
  criteria: NormalizedCriterion[];
  bonusRules: NormalizedAdjustmentRule[];
  deductionRules: NormalizedAdjustmentRule[];
  scoreCaps: NormalizedScoreCap[];
  overlapGroups: NormalizedOverlapGroup[];
}

export interface RubricScoreInput {
  criteria?: Record<string, number>;
  bonuses?: Record<string, number>;
  deductions?: Record<string, number>;
  scoreCaps?: Record<string, boolean>;
}

/** Loose input shape accepting both v1.0 and v2.0 rubric objects from backend or frontend. */
export interface AnyRubricLike {
  schemaVersion?: "1.0" | "2.0" | undefined;
  mode: RubricMode;
  totalScore: number;
  partialCreditAllowed?: boolean | undefined;
  criteria?: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    maxScore: number;
    scorePolicy?: "exact-level" | "range" | "continuous" | undefined;
    scoringType?: "levels" | "scored" | undefined;
    step?: ScoreStep | undefined;
    evidenceRequired: boolean;
    levels?: ReadonlyArray<{
      id: string;
      label?: string | undefined;
      score?: number | undefined;
      minScore?: number | undefined;
      maxScore?: number | undefined;
      condition: string;
    }> | undefined;
  }> | undefined;
  rules?: ReadonlyArray<AnyRuleLike> | undefined;
  deductionRules?: ReadonlyArray<AnyRuleLike> | undefined;
  bonusRules?: ReadonlyArray<AnyRuleLike> | undefined;
  scoreCaps?: ReadonlyArray<NormalizedScoreCap> | undefined;
  overlapGroups?: ReadonlyArray<NormalizedOverlapGroup> | undefined;
}

export interface AnyRuleLike {
  id: string;
  name: string;
  condition: string;
  evidenceRequired: boolean;
  overlapGroup?: string | undefined;
  // v2 fields
  policy?: "fixed" | "per-occurrence" | "range" | undefined;
  amount?: number | undefined;
  unitAmount?: number | undefined;
  minAmount?: number | undefined;
  maxAmount?: number | undefined;
  step?: ScoreStep | undefined;
  // v1 fields
  amountPolicy?: "fixed" | "per-occurrence" | "range" | undefined;
  deduction?: number | undefined;
  maxDeduction?: number | undefined;
  bonus?: number | undefined;
  maxBonus?: number | undefined;
  occurrence?: "once" | "per-occurrence" | undefined;
}

export function toUnits(value: number): number {
  return Math.round(value * 100);
}

export function fromUnits(units: number): number {
  return units / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validateStepAligned(value: number, step: ScoreStep): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  const units = toUnits(value);
  if (Math.abs(units - value * 100) >= 1e-6) return false;
  const stepUnits = toUnits(step);
  return stepUnits > 0 && units % stepUnits === 0;
}

function normalizeRule(rule: AnyRuleLike): NormalizedAdjustmentRule {
  const base = {
    id: rule.id,
    name: rule.name,
    condition: rule.condition,
    evidenceRequired: rule.evidenceRequired,
    ...(rule.overlapGroup ? { overlapGroup: rule.overlapGroup } : {}),
  };

  if (rule.policy === "fixed") {
    const amount = rule.amount ?? 0;
    return { ...base, policy: "fixed", amount, maxAmount: amount };
  }
  if (rule.policy === "per-occurrence") {
    const unitAmount = rule.unitAmount ?? 0;
    const maxAmount = rule.maxAmount ?? unitAmount;
    return { ...base, policy: "per-occurrence", unitAmount, maxAmount };
  }
  if (rule.policy === "range") {
    const step: ScoreStep = rule.step ?? 0.5;
    const maxAmount = rule.maxAmount ?? step;
    const minAmount = rule.minAmount ?? Math.min(step, maxAmount);
    return { ...base, policy: "range", minAmount, maxAmount, step };
  }

  // v1 compatibility
  const v1Policy = rule.amountPolicy ?? (rule.occurrence === "per-occurrence" ? "per-occurrence" : "fixed");
  if (v1Policy === "range") {
    const maxAmount = rule.maxDeduction ?? rule.maxBonus ?? 1;
    return { ...base, policy: "range", minAmount: 1, maxAmount, step: 1 };
  }
  if (v1Policy === "per-occurrence") {
    const unitAmount = rule.deduction ?? rule.bonus ?? 0;
    const maxAmount = rule.maxDeduction ?? rule.maxBonus ?? unitAmount;
    return { ...base, policy: "per-occurrence", unitAmount, maxAmount };
  }
  const amount = rule.deduction ?? rule.bonus ?? 0;
  const maxAmount = rule.maxDeduction ?? rule.maxBonus ?? amount;
  return { ...base, policy: "fixed", amount, maxAmount };
}

function normalizeCriterion(
  criterion: NonNullable<AnyRubricLike["criteria"]>[number],
  schemaVersion: "1.0" | "2.0",
  partialCreditAllowed: boolean | undefined,
): NormalizedCriterion {
  const isLevels = criterion.scoringType === "levels" || criterion.scorePolicy === "exact-level";
  const levels: NormalizedLevel[] = (criterion.levels ?? []).map((level) => {
    const minScore = level.score !== undefined ? level.score : (level.minScore ?? 0);
    const maxScore = level.score !== undefined ? level.score : (level.maxScore ?? minScore);
    return {
      id: level.id,
      ...(level.label ? { label: level.label } : {}),
      minScore,
      maxScore,
      condition: level.condition,
    };
  });
  const step: ScoreStep = criterion.step ?? (schemaVersion === "2.0" ? 0.5 : 0.01);
  const binaryOnly = schemaVersion === "1.0" && partialCreditAllowed === false && !isLevels;
  return {
    id: criterion.id,
    name: criterion.name,
    description: criterion.description,
    maxScore: criterion.maxScore,
    scoringType: isLevels ? "levels" : "scored",
    step: isLevels ? 0.01 : step,
    binaryOnly,
    evidenceRequired: criterion.evidenceRequired,
    levels,
  };
}

export function normalizeRubric(rubric: AnyRubricLike): NormalizedRubric {
  const schemaVersion = rubric.schemaVersion === "2.0" ? "2.0" : "1.0";
  const criteria = (rubric.criteria ?? []).map((criterion) =>
    normalizeCriterion(criterion, schemaVersion, rubric.partialCreditAllowed),
  );
  const rawDeductions = rubric.mode === "deductive"
    ? (rubric.rules ?? rubric.deductionRules ?? [])
    : (rubric.deductionRules ?? []);
  const deductionRules = rawDeductions.map(normalizeRule);
  const bonusRules = (rubric.bonusRules ?? []).map(normalizeRule);
  const scoreCaps = (rubric.scoreCaps ?? []).map((cap) => ({ ...cap }));
  const overlapGroups = (rubric.overlapGroups ?? []).map((group) => ({ ...group }));
  return {
    schemaVersion,
    mode: rubric.mode,
    totalScore: rubric.totalScore,
    ...(rubric.partialCreditAllowed !== undefined ? { partialCreditAllowed: rubric.partialCreditAllowed } : {}),
    criteria,
    bonusRules,
    deductionRules,
    scoreCaps,
    overlapGroups,
  };
}

export function resolveCriterionLevelId(criterion: NormalizedCriterion, score: number): string | undefined {
  if (!Number.isFinite(score) || criterion.levels.length === 0) return undefined;
  const scoreUnits = toUnits(score);
  if (criterion.scoringType === "levels") {
    return criterion.levels.find((level) => toUnits(level.minScore) === scoreUnits && toUnits(level.maxScore) === scoreUnits)?.id;
  }
  return criterion.levels.find((level) => toUnits(level.minScore) <= scoreUnits && scoreUnits <= toUnits(level.maxScore))?.id;
}

function sumCriteria(criteria: NormalizedCriterion[], scores: Record<string, number> | undefined): number {
  return criteria.reduce((total, criterion) => total + clamp(toUnits(scores?.[criterion.id] ?? 0), 0, toUnits(criterion.maxScore)), 0);
}

function sumRules(
  rules: NormalizedAdjustmentRule[],
  values: Record<string, number> | undefined,
  groups: NormalizedOverlapGroup[],
): number {
  const grouped = new Map<string, number[]>();
  let total = 0;
  for (const rule of rules) {
    const value = clamp(toUnits(values?.[rule.id] ?? 0), 0, toUnits(rule.maxAmount));
    if (!rule.overlapGroup) total += value;
    else grouped.set(rule.overlapGroup, [...(grouped.get(rule.overlapGroup) ?? []), value]);
  }
  for (const group of groups) {
    const valuesForGroup = grouped.get(group.id) ?? [];
    total += group.aggregation === "highest-only"
      ? Math.max(0, ...valuesForGroup)
      : valuesForGroup.reduce((sum, value) => sum + value, 0);
    grouped.delete(group.id);
  }
  return total + [...grouped.values()].flat().reduce((sum, value) => sum + value, 0);
}

export function calculateNormalizedRubricScore(normalized: NormalizedRubric, input: RubricScoreInput): number {
  const totalUnits = toUnits(normalized.totalScore);
  let earnedUnits: number;
  if (normalized.mode === "additive") {
    earnedUnits = clamp(sumCriteria(normalized.criteria, input.criteria), 0, totalUnits);
  } else if (normalized.mode === "deductive") {
    earnedUnits = clamp(totalUnits - sumRules(normalized.deductionRules, input.deductions, normalized.overlapGroups), 0, totalUnits);
  } else {
    const criteriaUnits = sumCriteria(normalized.criteria, input.criteria);
    const bonusUnits = sumRules(normalized.bonusRules, input.bonuses, normalized.overlapGroups);
    const deductionUnits = sumRules(normalized.deductionRules, input.deductions, normalized.overlapGroups);
    earnedUnits = clamp(criteriaUnits + bonusUnits - deductionUnits, 0, totalUnits);
  }
  for (const cap of normalized.scoreCaps) {
    if (input.scoreCaps?.[cap.id] === true) {
      earnedUnits = Math.min(earnedUnits, toUnits(cap.maxTotalScore));
    }
  }
  return fromUnits(clamp(earnedUnits, 0, totalUnits));
}

export function computeDecisionScorePreview(
  rubric: AnyRubricLike,
  decisions: Record<string, unknown>,
): { earned: number; possible: number } {
  const normalized = normalizeRubric(rubric);
  const criteria: Record<string, number> = {};
  const bonuses: Record<string, number> = {};
  const deductions: Record<string, number> = {};
  const scoreCaps: Record<string, boolean> = {};

  if (Array.isArray(decisions.criteria)) {
    for (const item of decisions.criteria as Array<Record<string, unknown>>) {
      if (typeof item.criterionId === "string" && typeof item.score === "number" && Number.isFinite(item.score)) {
        criteria[item.criterionId] = item.score;
      }
    }
  }
  if (Array.isArray(decisions.bonuses)) {
    for (const item of decisions.bonuses as Array<Record<string, unknown>>) {
      if (typeof item.ruleId === "string") {
        bonuses[item.ruleId] = item.triggered === true && typeof item.bonus === "number" && Number.isFinite(item.bonus) ? item.bonus : 0;
      }
    }
  }
  if (Array.isArray(decisions.deductions)) {
    for (const item of decisions.deductions as Array<Record<string, unknown>>) {
      if (typeof item.ruleId === "string") {
        deductions[item.ruleId] = item.triggered === true && typeof item.deduction === "number" && Number.isFinite(item.deduction) ? item.deduction : 0;
      }
    }
  }
  if (Array.isArray(decisions.scoreCaps)) {
    for (const item of decisions.scoreCaps as Array<Record<string, unknown>>) {
      if (typeof item.ruleId === "string") {
        scoreCaps[item.ruleId] = item.triggered === true;
      }
    }
  }

  return {
    earned: calculateNormalizedRubricScore(normalized, { criteria, bonuses, deductions, scoreCaps }),
    possible: normalized.totalScore,
  };
}

export function validateDecisionDraftLocally(
  rubric: AnyRubricLike,
  decisions: Record<string, unknown>,
): Record<string, string> {
  const normalized = normalizeRubric(rubric);
  const errors: Record<string, string> = {};

  if (Array.isArray(decisions.criteria)) {
    const byId = new Map(normalized.criteria.map((item) => [item.id, item]));
    for (const item of decisions.criteria as Array<Record<string, unknown>>) {
      const id = String(item.criterionId ?? "");
      const key = `criteria:${id}`;
      const criterion = byId.get(id);
      if (!criterion) continue;
      const score = Number(item.score);
      if (!Number.isFinite(score) || score < 0 || score > criterion.maxScore) {
        errors[key] = `得分须在 0 到 ${criterion.maxScore} 分之间`;
      } else if (criterion.scoringType === "levels") {
        if (!resolveCriterionLevelId(criterion, score)) {
          errors[key] = "请选择评分表规定的固定等级分值";
        }
      } else if (criterion.binaryOnly && toUnits(score) !== 0 && toUnits(score) !== toUnits(criterion.maxScore)) {
        errors[key] = `该项目不允许部分得分，仅能取 0 或 ${criterion.maxScore} 分`;
      } else if (!validateStepAligned(score, criterion.step)) {
        errors[key] = `得分须按 ${criterion.step} 分步长取值`;
      } else if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
        errors[key] = "请填写评分理由";
      }
    }
  }

  const checkRuleList = (
    listKey: "deductions" | "bonuses",
    amountField: "deduction" | "bonus",
    rules: NormalizedAdjustmentRule[],
    label: string,
  ) => {
    const raw = decisions[listKey];
    if (!Array.isArray(raw)) return;
    const byId = new Map(rules.map((item) => [item.id, item]));
    for (const item of raw as Array<Record<string, unknown>>) {
      const id = String(item.ruleId ?? "");
      const key = `${listKey}:${id}`;
      const rule = byId.get(id);
      if (!rule) continue;
      const triggered = item.triggered === true;
      const amount = Number(item[amountField]);
      if (!triggered) {
        if (Number.isFinite(amount) && amount !== 0) {
          errors[key] = `未触发规则时${label}必须为 0`;
        } else if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
          errors[key] = "请填写评分理由";
        }
        continue;
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > rule.maxAmount) {
        errors[key] = `${label}须大于 0 且不超过上限 ${rule.maxAmount} 分`;
      } else if (rule.policy === "fixed" && toUnits(amount) !== toUnits(rule.amount)) {
        errors[key] = `固定规则触发时${label}必须为 ${rule.amount} 分`;
      } else if (rule.policy === "per-occurrence" && toUnits(amount) % toUnits(rule.unitAmount) !== 0) {
        errors[key] = `按次规则${label}必须为 ${rule.unitAmount} 分的整数倍`;
      } else if (rule.policy === "range" && (toUnits(amount) < toUnits(rule.minAmount) || !validateStepAligned(amount, rule.step))) {
        errors[key] = `区间${label}须在 ${rule.minAmount}–${rule.maxAmount} 分内按 ${rule.step} 分步长取值`;
      } else if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
        errors[key] = "请填写评分理由";
      }
    }
  };

  checkRuleList("deductions", "deduction", normalized.deductionRules, "扣分");
  checkRuleList("bonuses", "bonus", normalized.bonusRules, "加分");

  if (Array.isArray(decisions.scoreCaps)) {
    for (const item of decisions.scoreCaps as Array<Record<string, unknown>>) {
      const id = String(item.ruleId ?? "");
      const key = `scoreCaps:${id}`;
      if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
        errors[key] = "请填写评分理由";
      }
    }
  }

  return errors;
}

export function inferCriterionStep(
  maxScore: number,
  levels?: ReadonlyArray<{ minScore?: number; maxScore?: number }>,
): ScoreStep {
  const values = [maxScore, ...(levels ?? []).flatMap((level) => [level.minScore ?? 0, level.maxScore ?? 0])];
  if (values.every((value) => validateStepAligned(value, 1))) return 1;
  if (values.every((value) => validateStepAligned(value, 0.5))) return 0.5;
  if (values.every((value) => validateStepAligned(value, 0.1))) return 0.1;
  return 0.01;
}
