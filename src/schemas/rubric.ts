import { z } from "zod";
import {
  calculateNormalizedRubricScore,
  inferCriterionStep,
  normalizeRubric,
  toUnits,
  validateStepAligned,
  type RubricScoreInput,
  type ScoreStep,
} from "./rubric-engine.js";
import {
  additiveRubricV1Schema,
  deductiveRubricV1Schema,
  hybridRubricV1Schema,
  rubricV1Schema,
  validateRubricV1,
  type AdditiveRubricV1,
  type DeductiveRubricV1,
  type DeductionRuleV1,
  type HybridRubricV1,
  type RubricV1,
} from "./rubric-v1.js";

export type { RubricScoreInput, ScoreStep } from "./rubric-engine.js";
export {
  additiveRubricV1Schema,
  deductiveRubricV1Schema,
  hybridRubricV1Schema,
  rubricV1Schema,
  type AdditiveRubricV1,
  type DeductiveRubricV1,
  type DeductionRuleV1,
  type HybridRubricV1,
  type RubricV1,
};

const scoreSchema = z.number().finite().nonnegative().refine(
  (value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8,
  "Scores support at most two decimal places",
);
const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const scoreStepSchema = z.union([z.literal(1), z.literal(0.5), z.literal(0.1), z.literal(0.01)]);
const overlapGroupSchema = z.object({ id: idSchema, aggregation: z.enum(["highest-only", "sum"]) });

export const discreteLevelV2Schema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(60).optional(),
  score: scoreSchema,
  condition: z.string().trim().min(1).max(2_000),
});

export const scoredLevelV2Schema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(60).optional(),
  minScore: scoreSchema,
  maxScore: scoreSchema,
  condition: z.string().trim().min(1).max(2_000),
});

export const criterionV2Schema = z.discriminatedUnion("scoringType", [
  z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4_000),
    maxScore: scoreSchema.positive(),
    scoringType: z.literal("levels"),
    evidenceRequired: z.boolean(),
    levels: z.array(discreteLevelV2Schema).min(1).max(20),
  }),
  z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4_000),
    maxScore: scoreSchema.positive(),
    scoringType: z.literal("scored"),
    step: scoreStepSchema.default(0.5),
    evidenceRequired: z.boolean(),
    levels: z.array(scoredLevelV2Schema).max(20).optional(),
  }),
]);

const adjustmentRuleBase = {
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  condition: z.string().trim().min(1).max(2_000),
  evidenceRequired: z.boolean(),
  overlapGroup: idSchema.optional(),
};

export const adjustmentRuleV2Schema = z.discriminatedUnion("policy", [
  z.object({ ...adjustmentRuleBase, policy: z.literal("fixed"), amount: scoreSchema.positive() }),
  z.object({ ...adjustmentRuleBase, policy: z.literal("per-occurrence"), unitAmount: scoreSchema.positive(), maxAmount: scoreSchema.positive() }),
  z.object({ ...adjustmentRuleBase, policy: z.literal("range"), minAmount: scoreSchema.positive().optional(), maxAmount: scoreSchema.positive(), step: scoreStepSchema.default(0.5) }),
]);

export const scoreCapV2Schema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  condition: z.string().trim().min(1).max(2_000),
  maxTotalScore: scoreSchema,
  evidenceRequired: z.boolean(),
});

export const additiveRubricV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  mode: z.literal("additive"),
  totalScore: scoreSchema.positive(),
  criteria: z.array(criterionV2Schema).min(1).max(40),
  scoreCaps: z.array(scoreCapV2Schema).max(20).optional(),
});

export const deductiveRubricV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  mode: z.literal("deductive"),
  totalScore: scoreSchema.positive(),
  rules: z.array(adjustmentRuleV2Schema).min(1).max(80),
  scoreCaps: z.array(scoreCapV2Schema).max(20).optional(),
  overlapGroups: z.array(overlapGroupSchema).max(40),
});

export const hybridRubricV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  mode: z.literal("hybrid"),
  totalScore: scoreSchema.positive(),
  criteria: z.array(criterionV2Schema).min(1).max(40),
  bonusRules: z.array(adjustmentRuleV2Schema).max(40),
  deductionRules: z.array(adjustmentRuleV2Schema).max(80),
  scoreCaps: z.array(scoreCapV2Schema).max(20).optional(),
  overlapGroups: z.array(overlapGroupSchema).max(40),
});

export const rubricV2Schema = z.discriminatedUnion("mode", [
  additiveRubricV2Schema,
  deductiveRubricV2Schema,
  hybridRubricV2Schema,
]);

export const additiveRubricSchema = z.union([additiveRubricV1Schema, additiveRubricV2Schema]);
export const deductiveRubricSchema = z.union([deductiveRubricV1Schema, deductiveRubricV2Schema]);
export const hybridRubricSchema = z.union([hybridRubricV1Schema, hybridRubricV2Schema]);
export const rubricSchema = z.union([rubricV1Schema, rubricV2Schema]);

export type AdditiveRubricV2 = z.infer<typeof additiveRubricV2Schema>;
export type DeductiveRubricV2 = z.infer<typeof deductiveRubricV2Schema>;
export type HybridRubricV2 = z.infer<typeof hybridRubricV2Schema>;
export type RubricV2 = AdditiveRubricV2 | DeductiveRubricV2 | HybridRubricV2;
export type CriterionV2 = z.infer<typeof criterionV2Schema>;
export type AdjustmentRuleV2 = z.infer<typeof adjustmentRuleV2Schema>;
export type ScoreCapV2 = z.infer<typeof scoreCapV2Schema>;

export type AdditiveRubric = AdditiveRubricV1 | AdditiveRubricV2;
export type DeductiveRubric = DeductiveRubricV1 | DeductiveRubricV2;
export type HybridRubric = HybridRubricV1 | HybridRubricV2;
export type Rubric = RubricV1 | RubricV2;
export type DeductionRule = DeductionRuleV1 | AdjustmentRuleV2;

export interface RubricProblem {
  code: string;
  message: string;
  path?: string;
}

export interface RubricValidation {
  errors: RubricProblem[];
  warnings: RubricProblem[];
}

export function validateRubric(value: unknown): RubricValidation {
  if (value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === "1.0") {
    return validateRubricV1(value);
  }
  return validateRubricV2(value);
}

function validateRubricV2(value: unknown): RubricValidation {
  const parsed = rubricV2Schema.safeParse(value);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => ({ code: "SCHEMA_INVALID", message: issue.message, path: issue.path.join(".") })),
      warnings: [],
    };
  }

  const rubric = parsed.data;
  const errors: RubricProblem[] = [];
  const warnings: RubricProblem[] = [];
  const groupIds = new Set<string>();
  for (const group of "overlapGroups" in rubric ? rubric.overlapGroups : []) {
    if (groupIds.has(group.id)) errors.push(problem("DUPLICATE_OVERLAP_GROUP", `Overlap group ${group.id} is duplicated`, "overlapGroups"));
    groupIds.add(group.id);
  }

  const scoreCaps = rubric.scoreCaps ?? [];
  for (const cap of scoreCaps) {
    if (toUnits(cap.maxTotalScore) >= toUnits(rubric.totalScore)) {
      errors.push(problem("SCORE_CAP_NOT_BELOW_TOTAL", `Score cap ${cap.id} must be lower than the rubric total score`, `scoreCaps.${cap.id}.maxTotalScore`));
    }
  }

  if (rubric.mode === "additive" || rubric.mode === "hybrid") {
    validateCriteriaV2(rubric.criteria, rubric.totalScore, errors, warnings);
  }
  if (rubric.mode === "deductive") {
    validateAdjustmentRulesV2(rubric.rules, groupIds, "rules", "DEDUCTION_EXCEEDS_MAXIMUM", errors);
    findDuplicateIds([...rubric.rules.map((rule) => rule.id), ...scoreCaps.map((cap) => cap.id)], errors);
  }
  if (rubric.mode === "additive") {
    findDuplicateIds([...rubric.criteria.map((criterion) => criterion.id), ...scoreCaps.map((cap) => cap.id)], errors);
  }
  if (rubric.mode === "hybrid") {
    validateAdjustmentRulesV2(rubric.bonusRules, groupIds, "bonusRules", "BONUS_EXCEEDS_MAXIMUM", errors);
    validateAdjustmentRulesV2(rubric.deductionRules, groupIds, "deductionRules", "DEDUCTION_EXCEEDS_MAXIMUM", errors);
    findDuplicateIds([
      ...rubric.criteria.map((criterion) => criterion.id),
      ...rubric.bonusRules.map((rule) => rule.id),
      ...rubric.deductionRules.map((rule) => rule.id),
      ...scoreCaps.map((cap) => cap.id),
    ], errors);
    const bonusGroups = new Set(rubric.bonusRules.map((rule) => rule.overlapGroup).filter((g): g is string => Boolean(g)));
    for (const rule of rubric.deductionRules) {
      if (rule.overlapGroup && bonusGroups.has(rule.overlapGroup)) {
        errors.push(problem("MIXED_OVERLAP_GROUP", `Overlap group ${rule.overlapGroup} cannot mix bonus and deduction rules`, "overlapGroups"));
      }
    }
    if (rubric.bonusRules.length === 0 && rubric.deductionRules.length === 0 && scoreCaps.length === 0) {
      warnings.push(problem("HYBRID_WITHOUT_EXTRA_RULES", "Hybrid rubric has no bonus, deduction, or score cap rules", "mode"));
    }
  }
  return { errors, warnings };
}

function validateCriteriaV2(
  criteria: CriterionV2[],
  totalScore: number,
  errors: RubricProblem[],
  warnings: RubricProblem[],
): void {
  if (criteria.reduce((total, criterion) => total + toUnits(criterion.maxScore), 0) !== toUnits(totalScore)) {
    errors.push(problem("CRITERIA_TOTAL_MISMATCH", "Criterion maxima must equal the rubric total score", "criteria"));
  }
  for (const criterion of criteria) {
    if (criterion.scoringType === "levels") {
      const levelIds = new Set<string>();
      const levelScores = new Set<number>();
      let hasFullScore = false;
      for (const level of criterion.levels) {
        if (levelIds.has(level.id)) {
          errors.push(problem("DUPLICATE_LEVEL_ID", `Level ID ${level.id} is duplicated in ${criterion.id}`, `criteria.${criterion.id}.levels`));
        }
        levelIds.add(level.id);
        const units = toUnits(level.score);
        if (units > toUnits(criterion.maxScore)) {
          errors.push(problem("LEVEL_OUT_OF_RANGE", `Level ${level.id} exceeds ${criterion.id}'s maximum`, `criteria.${criterion.id}.levels`));
        }
        if (levelScores.has(units)) {
          errors.push(problem("DUPLICATE_LEVEL_SCORE", `Level ${level.id} duplicates another level score in ${criterion.id}`, `criteria.${criterion.id}.levels`));
        }
        levelScores.add(units);
        if (units === toUnits(criterion.maxScore)) hasFullScore = true;
      }
      if (!hasFullScore) {
        warnings.push(problem("LEVELS_MISSING_FULL_SCORE", `${criterion.id} has no level awarding its full score`, `criteria.${criterion.id}.levels`));
      }
      continue;
    }

    // scoringType === "scored"
    const step = criterion.step;
    if (!validateStepAligned(criterion.maxScore, step)) {
      errors.push(problem("SCORE_STEP_MISMATCH", `${criterion.id} maxScore must align with step ${step}`, `criteria.${criterion.id}.maxScore`));
    }
    const levels = criterion.levels ?? [];
    if (levels.length === 0) {
      warnings.push(problem("CONTINUOUS_WITHOUT_ANCHORS", `${criterion.id} has no score anchors`, `criteria.${criterion.id}.levels`));
      continue;
    }
    const levelIds = new Set<string>();
    for (const level of levels) {
      if (levelIds.has(level.id)) {
        errors.push(problem("DUPLICATE_LEVEL_ID", `Level ID ${level.id} is duplicated in ${criterion.id}`, `criteria.${criterion.id}.levels`));
      }
      levelIds.add(level.id);
      if (level.minScore > level.maxScore || level.maxScore > criterion.maxScore) {
        errors.push(problem("LEVEL_OUT_OF_RANGE", `Level ${level.id} is outside ${criterion.id}'s bounds`, `criteria.${criterion.id}.levels`));
      }
      if (!validateStepAligned(level.minScore, step) || !validateStepAligned(level.maxScore, step)) {
        errors.push(problem("SCORE_STEP_MISMATCH", `Level ${level.id} bounds must align with step ${step}`, `criteria.${criterion.id}.levels`));
      }
    }
    const sorted = [...levels].sort((left, right) => left.minScore - right.minScore);
    let hasOverlap = false;
    let hasGap = toUnits(sorted[0]!.minScore) !== 0 || toUnits(sorted.at(-1)!.maxScore) !== toUnits(criterion.maxScore);
    const stepUnits = toUnits(step);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (toUnits(previous.maxScore) >= toUnits(current.minScore)) {
        hasOverlap = true;
      } else if (toUnits(previous.maxScore) + stepUnits < toUnits(current.minScore)) {
        hasGap = true;
      }
    }
    if (hasOverlap) {
      errors.push(problem("LEVEL_OVERLAP", `${criterion.id} levels must not overlap`, `criteria.${criterion.id}.levels`));
    } else if (hasGap) {
      warnings.push(problem("CONTINUOUS_LEVELS_GAP_OR_OVERLAP", `${criterion.id} anchor levels have gaps or incomplete coverage`, `criteria.${criterion.id}.levels`));
    }
  }
}

function validateAdjustmentRulesV2(
  rules: AdjustmentRuleV2[],
  groupIds: Set<string>,
  prefix: "rules" | "bonusRules" | "deductionRules",
  exceedsCode: "DEDUCTION_EXCEEDS_MAXIMUM" | "BONUS_EXCEEDS_MAXIMUM",
  errors: RubricProblem[],
): void {
  for (const rule of rules) {
    if (rule.overlapGroup && !groupIds.has(rule.overlapGroup)) {
      errors.push(problem("UNKNOWN_OVERLAP_GROUP", `${rule.id} references an unknown overlap group`, `${prefix}.${rule.id}.overlapGroup`));
    }
    if (rule.policy === "per-occurrence") {
      if (toUnits(rule.unitAmount) > toUnits(rule.maxAmount)) {
        errors.push(problem(exceedsCode, `${rule.id} unit amount exceeds its maximum`, `${prefix}.${rule.id}`));
      }
    } else if (rule.policy === "range") {
      const minAmount = rule.minAmount ?? Math.min(rule.step, rule.maxAmount);
      if (toUnits(minAmount) > toUnits(rule.maxAmount)) {
        errors.push(problem("RANGE_MIN_EXCEEDS_MAX", `${rule.id} minimum amount exceeds its maximum`, `${prefix}.${rule.id}`));
      }
      if (!validateStepAligned(rule.maxAmount, rule.step) || (rule.minAmount !== undefined && !validateStepAligned(rule.minAmount, rule.step))) {
        errors.push(problem("SCORE_STEP_MISMATCH", `${rule.id} range bounds must align with step ${rule.step}`, `${prefix}.${rule.id}`));
      }
    }
  }
}

export function calculateRubricScore(rubric: Rubric, input: RubricScoreInput): number {
  return calculateNormalizedRubricScore(normalizeRubric(rubric), input);
}

export function upgradeRubricV1ToV2(rubric: RubricV1): RubricV2 {
  const upgradeCriterion = (
    criterion: AdditiveRubricV1["criteria"][number],
    partialCreditAllowed: boolean,
  ): CriterionV2 => {
    if (!partialCreditAllowed && criterion.scorePolicy !== "exact-level") {
      return {
        id: criterion.id,
        name: criterion.name,
        description: criterion.description,
        maxScore: criterion.maxScore,
        scoringType: "levels",
        evidenceRequired: criterion.evidenceRequired,
        levels: [
          { id: `${criterion.id}_full`, label: "达标", score: criterion.maxScore, condition: "完整达到本项目全部要求" },
          { id: `${criterion.id}_zero`, label: "未达标", score: 0, condition: "未满足本项目要求" },
        ],
      };
    }
    if (criterion.scorePolicy === "exact-level") {
      return {
        id: criterion.id,
        name: criterion.name,
        description: criterion.description,
        maxScore: criterion.maxScore,
        scoringType: "levels",
        evidenceRequired: criterion.evidenceRequired,
        levels: (criterion.levels ?? []).map((level) => ({
          id: level.id,
          score: level.minScore,
          condition: level.condition,
        })),
      };
    }
    const step: ScoreStep = inferCriterionStep(criterion.maxScore, criterion.levels);
    const levels = criterion.levels?.map((level) => ({
      id: level.id,
      minScore: level.minScore,
      maxScore: level.maxScore,
      condition: level.condition,
    }));
    return {
      id: criterion.id,
      name: criterion.name,
      description: criterion.description,
      maxScore: criterion.maxScore,
      scoringType: "scored",
      step,
      evidenceRequired: criterion.evidenceRequired,
      ...(levels && levels.length > 0 ? { levels } : {}),
    };
  };

  const upgradeDeduction = (rule: DeductionRuleV1): AdjustmentRuleV2 => {
    const base = {
      id: rule.id,
      name: rule.name,
      condition: rule.condition,
      evidenceRequired: rule.evidenceRequired,
      ...(rule.overlapGroup ? { overlapGroup: rule.overlapGroup } : {}),
    };
    const policy = rule.amountPolicy ?? (rule.occurrence === "per-occurrence" ? "per-occurrence" : "fixed");
    if (policy === "range") {
      return { ...base, policy: "range", minAmount: 1, maxAmount: rule.maxDeduction, step: 1 };
    }
    if (policy === "per-occurrence") {
      return { ...base, policy: "per-occurrence", unitAmount: rule.deduction!, maxAmount: rule.maxDeduction };
    }
    return { ...base, policy: "fixed", amount: rule.deduction! };
  };

  const upgradeBonus = (rule: HybridRubricV1["bonusRules"][number]): AdjustmentRuleV2 => {
    const base = {
      id: rule.id,
      name: rule.name,
      condition: rule.condition,
      evidenceRequired: rule.evidenceRequired,
      ...(rule.overlapGroup ? { overlapGroup: rule.overlapGroup } : {}),
    };
    if (rule.occurrence === "per-occurrence") {
      return { ...base, policy: "per-occurrence", unitAmount: rule.bonus, maxAmount: rule.maxBonus };
    }
    return { ...base, policy: "fixed", amount: rule.bonus };
  };

  if (rubric.mode === "additive") {
    return {
      schemaVersion: "2.0",
      mode: "additive",
      totalScore: rubric.totalScore,
      criteria: rubric.criteria.map((criterion) => upgradeCriterion(criterion, rubric.partialCreditAllowed)),
    };
  }
  if (rubric.mode === "deductive") {
    return {
      schemaVersion: "2.0",
      mode: "deductive",
      totalScore: rubric.totalScore,
      rules: rubric.rules.map(upgradeDeduction),
      overlapGroups: rubric.overlapGroups.map((group) => ({ ...group })),
    };
  }
  return {
    schemaVersion: "2.0",
    mode: "hybrid",
    totalScore: rubric.totalScore,
    criteria: rubric.criteria.map((criterion) => upgradeCriterion(criterion, rubric.partialCreditAllowed)),
    bonusRules: rubric.bonusRules.map(upgradeBonus),
    deductionRules: rubric.deductionRules.map(upgradeDeduction),
    overlapGroups: rubric.overlapGroups.map((group) => ({ ...group })),
  };
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
