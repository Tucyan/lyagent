import { z } from "zod";

const scoreSchema = z.number().finite().nonnegative().refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8, "Scores support at most two decimal places");
const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const levelSchema = z.object({
  id: idSchema,
  minScore: scoreSchema,
  maxScore: scoreSchema,
  condition: z.string().trim().min(1).max(2_000),
});

const criterionSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4_000),
  maxScore: scoreSchema.positive(),
  scorePolicy: z.enum(["exact-level", "range", "continuous"]),
  evidenceRequired: z.boolean(),
  levels: z.array(levelSchema).max(20).optional(),
});

const deductionRuleSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  condition: z.string().trim().min(1).max(2_000),
  deduction: scoreSchema.positive(),
  maxDeduction: scoreSchema.positive(),
  occurrence: z.enum(["once", "per-occurrence"]),
  evidenceRequired: z.boolean(),
  overlapGroup: idSchema.optional(),
});

const bonusRuleSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  condition: z.string().trim().min(1).max(2_000),
  bonus: scoreSchema.positive(),
  maxBonus: scoreSchema.positive(),
  occurrence: z.enum(["once", "per-occurrence"]),
  evidenceRequired: z.boolean(),
  overlapGroup: idSchema.optional(),
});

const overlapGroupSchema = z.object({ id: idSchema, aggregation: z.enum(["highest-only", "sum"]) });

export const additiveRubricSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("additive"),
  totalScore: scoreSchema.positive(),
  partialCreditAllowed: z.boolean(),
  criteria: z.array(criterionSchema).min(1).max(40),
});

export const deductiveRubricSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("deductive"),
  totalScore: scoreSchema.positive(),
  rules: z.array(deductionRuleSchema).min(1).max(80),
  overlapGroups: z.array(overlapGroupSchema).max(40),
});

export const hybridRubricSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("hybrid"),
  totalScore: scoreSchema.positive(),
  partialCreditAllowed: z.boolean(),
  criteria: z.array(criterionSchema).min(1).max(40),
  bonusRules: z.array(bonusRuleSchema).max(40),
  deductionRules: z.array(deductionRuleSchema).max(80),
  overlapGroups: z.array(overlapGroupSchema).max(40),
});

export const rubricSchema = z.discriminatedUnion("mode", [additiveRubricSchema, deductiveRubricSchema, hybridRubricSchema]);

export type AdditiveRubric = z.infer<typeof additiveRubricSchema>;
export type DeductiveRubric = z.infer<typeof deductiveRubricSchema>;
export type HybridRubric = z.infer<typeof hybridRubricSchema>;
export type Rubric = AdditiveRubric | DeductiveRubric | HybridRubric;

export interface RubricProblem {
  code: string;
  message: string;
  path?: string;
}

export interface RubricValidation {
  errors: RubricProblem[];
  warnings: RubricProblem[];
}

export interface RubricScoreInput {
  criteria?: Record<string, number>;
  bonuses?: Record<string, number>;
  deductions?: Record<string, number>;
}

export function validateRubric(value: unknown): RubricValidation {
  const parsed = rubricSchema.safeParse(value);
  if (!parsed.success) return {
    errors: parsed.error.issues.map((issue) => ({ code: "SCHEMA_INVALID", message: issue.message, path: issue.path.join(".") })),
    warnings: [],
  };

  const rubric = parsed.data;
  const errors: RubricProblem[] = [];
  const warnings: RubricProblem[] = [];
  const groupIds = new Set<string>();
  for (const group of "overlapGroups" in rubric ? rubric.overlapGroups : []) {
    if (groupIds.has(group.id)) errors.push(problem("DUPLICATE_OVERLAP_GROUP", `Overlap group ${group.id} is duplicated`, "overlapGroups"));
    groupIds.add(group.id);
  }

  if (rubric.mode === "additive" || rubric.mode === "hybrid") {
    validateCriteria(rubric.criteria, rubric.totalScore, errors, warnings);
  }
  if (rubric.mode === "deductive") {
    validateDeductionRules(rubric.rules, groupIds, errors);
  }
  if (rubric.mode === "hybrid") {
    validateBonusRules(rubric.bonusRules, groupIds, errors);
    validateDeductionRules(rubric.deductionRules, groupIds, errors);
    const ids = [...rubric.criteria.map((criterion) => criterion.id), ...rubric.bonusRules.map((rule) => rule.id), ...rubric.deductionRules.map((rule) => rule.id)];
    findDuplicateIds(ids, errors);
  }
  if (rubric.mode === "deductive") findDuplicateIds(rubric.rules.map((rule) => rule.id), errors);
  return { errors, warnings };
}

export function calculateRubricScore(rubric: Rubric, input: RubricScoreInput): number {
  const totalUnits = toUnits(rubric.totalScore);
  if (rubric.mode === "additive") return fromUnits(sumCriteria(rubric.criteria, input.criteria));
  if (rubric.mode === "deductive") return fromUnits(clamp(totalUnits - sumRules(rubric.rules, input.deductions, rubric.overlapGroups, "maxDeduction"), 0, totalUnits));
  const criteriaUnits = sumCriteria(rubric.criteria, input.criteria);
  const bonusUnits = sumRules(rubric.bonusRules, input.bonuses, rubric.overlapGroups, "maxBonus");
  const deductionUnits = sumRules(rubric.deductionRules, input.deductions, rubric.overlapGroups, "maxDeduction");
  return fromUnits(clamp(criteriaUnits + bonusUnits - deductionUnits, 0, totalUnits));
}

function validateCriteria(criteria: AdditiveRubric["criteria"], totalScore: number, errors: RubricProblem[], warnings: RubricProblem[]): void {
  findDuplicateIds(criteria.map((criterion) => criterion.id), errors);
  if (criteria.reduce((total, criterion) => total + toUnits(criterion.maxScore), 0) !== toUnits(totalScore)) {
    errors.push(problem("CRITERIA_TOTAL_MISMATCH", "Criterion maxima must equal the rubric total score", "criteria"));
  }
  for (const criterion of criteria) {
    const levels = criterion.levels ?? [];
    if ((criterion.scorePolicy === "range" || criterion.scorePolicy === "exact-level") && levels.length === 0) {
      errors.push(problem("LEVELS_REQUIRED", `${criterion.id} requires scoring levels`, `criteria.${criterion.id}.levels`));
      continue;
    }
    if (criterion.scorePolicy === "continuous" && levels.length === 0) {
      warnings.push(problem("CONTINUOUS_WITHOUT_ANCHORS", `${criterion.id} has no score anchors`, `criteria.${criterion.id}.levels`));
    }
    const sorted = [...levels].sort((left, right) => left.minScore - right.minScore);
    for (const level of sorted) {
      if (level.minScore > level.maxScore || level.maxScore > criterion.maxScore) errors.push(problem("LEVEL_OUT_OF_RANGE", `Level ${level.id} is outside ${criterion.id}'s bounds`, `criteria.${criterion.id}.levels`));
      if (criterion.scorePolicy === "exact-level" && level.minScore !== level.maxScore) errors.push(problem("EXACT_LEVEL_NOT_EXACT", `Level ${level.id} must have one exact score`, `criteria.${criterion.id}.levels`));
    }
    if (criterion.scorePolicy === "range" && sorted.length > 0) {
      const first = sorted[0]!;
      const last = sorted.at(-1)!;
      if (toUnits(first.minScore) !== 0 || toUnits(last.maxScore) !== toUnits(criterion.maxScore)) errors.push(problem("RANGE_NOT_COVERED", `${criterion.id} levels must cover its full score range`, `criteria.${criterion.id}.levels`));
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]!;
        const current = sorted[index]!;
        if (toUnits(previous.maxScore) + 1 !== toUnits(current.minScore)) errors.push(problem("RANGE_GAP_OR_OVERLAP", `${criterion.id} levels must be contiguous`, `criteria.${criterion.id}.levels`));
      }
    }
  }
}

function validateDeductionRules(rules: DeductiveRubric["rules"], groupIds: Set<string>, errors: RubricProblem[]): void {
  for (const rule of rules) {
    if (rule.deduction > rule.maxDeduction) errors.push(problem("DEDUCTION_EXCEEDS_MAXIMUM", `${rule.id} deduction exceeds its maximum`, `rules.${rule.id}`));
    if (rule.overlapGroup && !groupIds.has(rule.overlapGroup)) errors.push(problem("UNKNOWN_OVERLAP_GROUP", `${rule.id} references an unknown overlap group`, `rules.${rule.id}.overlapGroup`));
  }
}

function validateBonusRules(rules: HybridRubric["bonusRules"], groupIds: Set<string>, errors: RubricProblem[]): void {
  for (const rule of rules) {
    if (rule.bonus > rule.maxBonus) errors.push(problem("BONUS_EXCEEDS_MAXIMUM", `${rule.id} bonus exceeds its maximum`, `bonusRules.${rule.id}`));
    if (rule.overlapGroup && !groupIds.has(rule.overlapGroup)) errors.push(problem("UNKNOWN_OVERLAP_GROUP", `${rule.id} references an unknown overlap group`, `bonusRules.${rule.id}.overlapGroup`));
  }
}

function sumCriteria(criteria: AdditiveRubric["criteria"], scores: Record<string, number> | undefined): number {
  return criteria.reduce((total, criterion) => total + clamp(toUnits(scores?.[criterion.id] ?? 0), 0, toUnits(criterion.maxScore)), 0);
}

function sumRules<TRule extends { id: string; overlapGroup?: string | undefined }>(rules: TRule[], values: Record<string, number> | undefined, groups: Array<{ id: string; aggregation: "highest-only" | "sum" }>, maximum: TRule extends { maxBonus: number } ? "maxBonus" : "maxDeduction"): number {
  const grouped = new Map<string, number[]>();
  let total = 0;
  for (const rule of rules) {
    const cap = maximum === "maxBonus" ? (rule as TRule & { maxBonus: number }).maxBonus : (rule as TRule & { maxDeduction: number }).maxDeduction;
    const value = clamp(toUnits(values?.[rule.id] ?? 0), 0, toUnits(cap));
    if (!rule.overlapGroup) total += value;
    else grouped.set(rule.overlapGroup, [...(grouped.get(rule.overlapGroup) ?? []), value]);
  }
  for (const group of groups) {
    const valuesForGroup = grouped.get(group.id) ?? [];
    total += group.aggregation === "highest-only" ? Math.max(0, ...valuesForGroup) : valuesForGroup.reduce((sum, value) => sum + value, 0);
    grouped.delete(group.id);
  }
  return total + [...grouped.values()].flat().reduce((sum, value) => sum + value, 0);
}

function findDuplicateIds(ids: string[], errors: RubricProblem[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(problem("DUPLICATE_ID", `ID ${id} is duplicated`));
    seen.add(id);
  }
}

function problem(code: string, message: string, path?: string): RubricProblem {
  return { code, message, ...(path ? { path } : {}) };
}

function toUnits(value: number): number {
  return Math.round(value * 100);
}

function fromUnits(value: number): number {
  return value / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
