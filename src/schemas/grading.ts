import { z } from "zod";
import type { Rubric } from "./rubric.js";
import {
  calculateNormalizedRubricScore,
  normalizeRubric,
  resolveCriterionLevelId,
  toUnits,
  validateStepAligned,
  type NormalizedAdjustmentRule,
  type NormalizedCriterion,
} from "./rubric-engine.js";

const identifierSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const scoreSchema = z.number().finite().nonnegative().refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8, "Scores support at most two decimal places");
const confidenceSchema = z.number().finite().min(0).max(1);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const explanationSchema = z.string().trim().min(1).max(4_000);

export const textEvidenceSchema = z.object({
  kind: z.literal("text"),
  path: z.string().trim().min(1).max(240),
  heading: z.string().trim().min(1).max(240),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  quote: z.string().trim().min(1).max(500),
});

export const imageEvidenceSchema = z.object({
  kind: z.literal("image"),
  path: z.string().trim().min(1).max(240),
  explanation: explanationSchema,
});

export const analysisEvidenceSchema = z.object({
  kind: z.literal("analysis"),
  observation: explanationSchema,
  rubricBasis: explanationSchema,
  scoreJustification: explanationSchema,
});

export const gradingEvidenceSchema = z.discriminatedUnion("kind", [analysisEvidenceSchema, textEvidenceSchema, imageEvidenceSchema]);

const commonDecision = {
  reason: explanationSchema,
  evidence: z.array(gradingEvidenceSchema).max(20),
  evidenceInsufficient: z.boolean().optional(),
  confidence: confidenceSchema,
  confidenceReason: z.string().trim().min(1).max(1_000).optional(),
};

export const criterionDecisionSchema = z.object({
  criterionId: identifierSchema,
  selectedLevelId: identifierSchema.optional(),
  score: scoreSchema,
  ...commonDecision,
});

export const deductionDecisionSchema = z.object({
  ruleId: identifierSchema,
  triggered: z.boolean(),
  deduction: scoreSchema,
  occurrences: z.number().int().positive().max(1_000).optional(),
  ...commonDecision,
});

export const bonusDecisionSchema = z.object({
  ruleId: identifierSchema,
  triggered: z.boolean(),
  bonus: scoreSchema,
  occurrences: z.number().int().positive().max(1_000).optional(),
  ...commonDecision,
});

export const scoreCapDecisionSchema = z.object({
  ruleId: identifierSchema,
  triggered: z.boolean(),
  ...commonDecision,
});

const narrativeFields = {
  strengths: z.array(z.string().trim().min(1).max(1_000)).max(20),
  improvements: z.array(z.string().trim().min(1).max(1_000)).max(20),
  warnings: z.array(z.string().trim().min(1).max(1_000)).max(20),
};

const additiveDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("additive"),
  criteria: z.array(criterionDecisionSchema).max(40),
  scoreCaps: z.array(scoreCapDecisionSchema).max(20).optional(),
  ...narrativeFields,
});

const deductiveDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("deductive"),
  deductions: z.array(deductionDecisionSchema).max(80),
  scoreCaps: z.array(scoreCapDecisionSchema).max(20).optional(),
  ...narrativeFields,
});

const hybridDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("hybrid"),
  criteria: z.array(criterionDecisionSchema).max(40),
  bonuses: z.array(bonusDecisionSchema).max(40),
  deductions: z.array(deductionDecisionSchema).max(80),
  scoreCaps: z.array(scoreCapDecisionSchema).max(20).optional(),
  ...narrativeFields,
});

export const gradingDraftSchema = z.discriminatedUnion("mode", [additiveDraftSchema, deductiveDraftSchema, hybridDraftSchema]);

export type GradingEvidence = z.infer<typeof gradingEvidenceSchema>;
export type GradingDraft = z.infer<typeof gradingDraftSchema>;

export interface LockedSubmission {
  path: string;
  lineCount: number;
  hash: string;
  lines: string[];
  assetPaths?: string[];
}

export interface GradingResult {
  schemaVersion: "1.0";
  mode: Rubric["mode"];
  submissionHash: string;
  score: { earned: number; possible: number };
  confidence: { overall: number; minimum: number; lowCount: number };
  review: { requiresReview: boolean; reasons: ReviewReason[] };
  decisions: GradingDraft;
}

export type ReviewReason = "LOW_CONFIDENCE" | "EVIDENCE_INSUFFICIENT" | "CONVERSION_WARNING" | "NEAR_PASSING_BOUNDARY";

export class GradingResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingResultValidationError";
  }
}

export function finalizeGradingDraft(input: {
  rubric: Rubric;
  submission: LockedSubmission;
  draft: unknown;
  lowConfidenceThreshold?: number;
  passingScore?: number;
  nearPassingMargin?: number;
}): GradingResult {
  const parsedDraft = gradingDraftSchema.parse(input.draft);
  const normalized = normalizeRubric(input.rubric);
  if (parsedDraft.mode !== normalized.mode) throw new GradingResultValidationError("Grading draft mode does not match the frozen rubric");
  const submission = parseSubmission(input.submission);
  const threshold = input.lowConfidenceThreshold ?? 0.7;

  const scoreCapDecisions = parsedDraft.scoreCaps ?? [];
  if (normalized.scoreCaps.length > 0 || scoreCapDecisions.length > 0) {
    assertCompleteIds(
      normalized.scoreCaps.map(({ id }) => id),
      scoreCapDecisions.map(({ ruleId }) => ruleId),
      "every score cap rule",
    );
    const capMap = new Map(scoreCapDecisions.map((decision) => [decision.ruleId, decision]));
    for (const cap of normalized.scoreCaps) {
      const decision = capMap.get(cap.id)!;
      validateDecisionEvidence(decision, cap.evidenceRequired && decision.triggered, submission);
    }
  }
  const scoreCapsInput = Object.fromEntries(scoreCapDecisions.map((decision) => [decision.ruleId, decision.triggered]));
  const scoreCapWeights = normalized.scoreCaps.map((cap) => {
    const decision = scoreCapDecisions.find(({ ruleId }) => ruleId === cap.id)!;
    return { confidence: decision.confidence, weight: Math.max(1, normalized.totalScore - cap.maxTotalScore) };
  });

  let draft: GradingDraft = parsedDraft;
  let earned: number;
  let weightedConfidence: Array<{ confidence: number; weight: number }>;
  if (normalized.mode === "additive" && parsedDraft.mode === "additive") {
    assertCompleteIds(normalized.criteria.map(({ id }) => id), parsedDraft.criteria.map(({ criterionId }) => criterionId), "every rubric criterion");
    const decisions = new Map(parsedDraft.criteria.map((decision) => [decision.criterionId, decision]));
    const resolvedCriteria = parsedDraft.criteria.map((decision) => {
      const criterion = normalized.criteria.find(({ id }) => id === decision.criterionId)!;
      const resolved = validateAndResolveCriterionDecision(criterion, decision);
      validateDecisionEvidence(resolved, criterion.evidenceRequired, submission);
      return resolved;
    });
    draft = { ...parsedDraft, criteria: resolvedCriteria };
    earned = calculateNormalizedRubricScore(normalized, {
      criteria: Object.fromEntries(resolvedCriteria.map((decision) => [decision.criterionId, decision.score])),
      scoreCaps: scoreCapsInput,
    });
    weightedConfidence = [
      ...normalized.criteria.map((criterion) => ({ confidence: decisions.get(criterion.id)!.confidence, weight: criterion.maxScore })),
      ...scoreCapWeights,
    ];
  } else if (normalized.mode === "deductive" && parsedDraft.mode === "deductive") {
    assertCompleteIds(normalized.deductionRules.map(({ id }) => id), parsedDraft.deductions.map(({ ruleId }) => ruleId), "every rubric rule");
    const decisions = new Map(parsedDraft.deductions.map((decision) => [decision.ruleId, decision]));
    for (const rule of normalized.deductionRules) {
      const decision = decisions.get(rule.id)!;
      validateAdjustmentAmount(decision.triggered, decision.deduction, decision.occurrences, rule);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    earned = calculateNormalizedRubricScore(normalized, {
      deductions: Object.fromEntries(parsedDraft.deductions.map((decision) => [decision.ruleId, decision.triggered ? decision.deduction : 0])),
      scoreCaps: scoreCapsInput,
    });
    weightedConfidence = [
      ...normalized.deductionRules.map((rule) => ({ confidence: decisions.get(rule.id)!.confidence, weight: rule.maxAmount })),
      ...scoreCapWeights,
    ];
  } else if (normalized.mode === "hybrid" && parsedDraft.mode === "hybrid") {
    assertCompleteIds(normalized.criteria.map(({ id }) => id), parsedDraft.criteria.map(({ criterionId }) => criterionId), "every rubric criterion");
    assertCompleteIds(normalized.bonusRules.map(({ id }) => id), parsedDraft.bonuses.map(({ ruleId }) => ruleId), "every bonus rule");
    assertCompleteIds(normalized.deductionRules.map(({ id }) => id), parsedDraft.deductions.map(({ ruleId }) => ruleId), "every deduction rule");
    const criteriaMap = new Map(parsedDraft.criteria.map((decision) => [decision.criterionId, decision]));
    const bonuses = new Map(parsedDraft.bonuses.map((decision) => [decision.ruleId, decision]));
    const deductions = new Map(parsedDraft.deductions.map((decision) => [decision.ruleId, decision]));
    const resolvedCriteria = parsedDraft.criteria.map((decision) => {
      const criterion = normalized.criteria.find(({ id }) => id === decision.criterionId)!;
      const resolved = validateAndResolveCriterionDecision(criterion, decision);
      validateDecisionEvidence(resolved, criterion.evidenceRequired, submission);
      return resolved;
    });
    for (const rule of normalized.bonusRules) {
      const decision = bonuses.get(rule.id)!;
      validateAdjustmentAmount(decision.triggered, decision.bonus, decision.occurrences, rule);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    for (const rule of normalized.deductionRules) {
      const decision = deductions.get(rule.id)!;
      validateAdjustmentAmount(decision.triggered, decision.deduction, decision.occurrences, rule);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    draft = { ...parsedDraft, criteria: resolvedCriteria };
    earned = calculateNormalizedRubricScore(normalized, {
      criteria: Object.fromEntries(resolvedCriteria.map((decision) => [decision.criterionId, decision.score])),
      bonuses: Object.fromEntries(parsedDraft.bonuses.map((decision) => [decision.ruleId, decision.triggered ? decision.bonus : 0])),
      deductions: Object.fromEntries(parsedDraft.deductions.map((decision) => [decision.ruleId, decision.triggered ? decision.deduction : 0])),
      scoreCaps: scoreCapsInput,
    });
    weightedConfidence = [
      ...normalized.criteria.map((rule) => ({ confidence: criteriaMap.get(rule.id)!.confidence, weight: rule.maxScore })),
      ...normalized.bonusRules.map((rule) => ({ confidence: bonuses.get(rule.id)!.confidence, weight: rule.maxAmount })),
      ...normalized.deductionRules.map((rule) => ({ confidence: deductions.get(rule.id)!.confidence, weight: rule.maxAmount })),
      ...scoreCapWeights,
    ];
  } else {
    throw new GradingResultValidationError("Grading draft mode does not match the frozen rubric");
  }

  const confidences = weightedConfidence.map(({ confidence }) => confidence);
  const weightTotal = weightedConfidence.reduce((sum, item) => sum + item.weight, 0);
  const overall = weightTotal === 0 ? 0 : weightedConfidence.reduce((sum, item) => sum + item.confidence * item.weight, 0) / weightTotal;
  const lowCount = confidences.filter((confidence) => confidence < threshold).length;
  const reasons = new Set<ReviewReason>();
  if (lowCount > 0) reasons.add("LOW_CONFIDENCE");
  if (allDecisions(draft).some((decision) => decision.evidenceInsufficient === true)) reasons.add("EVIDENCE_INSUFFICIENT");
  if (draft.warnings.length > 0) reasons.add("CONVERSION_WARNING");
  if (input.passingScore !== undefined && Math.abs(earned - input.passingScore) <= (input.nearPassingMargin ?? 2)) reasons.add("NEAR_PASSING_BOUNDARY");

  return {
    schemaVersion: "1.0",
    mode: draft.mode,
    submissionHash: submission.hash,
    score: { earned, possible: normalized.totalScore },
    confidence: { overall: round(overall), minimum: round(Math.min(...confidences)), lowCount },
    review: { requiresReview: reasons.size > 0, reasons: [...reasons] },
    decisions: draft,
  };
}

function parseSubmission(submission: LockedSubmission): Required<LockedSubmission> {
  if (!submission.path || !Number.isInteger(submission.lineCount) || submission.lineCount < 1 || submission.lines.length !== submission.lineCount || !hashSchema.safeParse(submission.hash).success) {
    throw new GradingResultValidationError("Locked submission metadata is invalid");
  }
  return { ...submission, assetPaths: submission.assetPaths ?? [] };
}

function validateAndResolveCriterionDecision(
  criterion: NormalizedCriterion,
  decision: z.infer<typeof criterionDecisionSchema>,
): z.infer<typeof criterionDecisionSchema> {
  if (decision.score > criterion.maxScore) {
    throw new GradingResultValidationError(`Score for ${criterion.id} exceeds its maximum`);
  }
  if (criterion.scoringType === "levels") {
    if (decision.selectedLevelId) {
      const level = criterion.levels.find(({ id }) => id === decision.selectedLevelId);
      if (!level) throw new GradingResultValidationError(`Selected level for ${criterion.id} is not in the frozen rubric`);
      if (toUnits(decision.score) !== toUnits(level.minScore)) {
        throw new GradingResultValidationError(`Score for ${criterion.id} must equal its exact level score`);
      }
      return decision;
    }
    const matched = resolveCriterionLevelId(criterion, decision.score);
    if (!matched) throw new GradingResultValidationError(`A valid level is required for ${criterion.id}`);
    return { ...decision, selectedLevelId: matched };
  }

  if (criterion.binaryOnly && toUnits(decision.score) !== 0 && toUnits(decision.score) !== toUnits(criterion.maxScore)) {
    throw new GradingResultValidationError(`Partial credit is not allowed for ${criterion.id}`);
  }
  if (!validateStepAligned(decision.score, criterion.step)) {
    throw new GradingResultValidationError(`Score for ${criterion.id} must align with step ${criterion.step}`);
  }
  const resolvedLevelId = resolveCriterionLevelId(criterion, decision.score);
  const { selectedLevelId: _ignored, ...rest } = decision;
  return resolvedLevelId ? { ...rest, selectedLevelId: resolvedLevelId } : rest;
}

function validateAdjustmentAmount(
  triggered: boolean,
  amount: number,
  occurrences: number | undefined,
  rule: NormalizedAdjustmentRule,
): void {
  if ((!triggered && amount !== 0) || amount > rule.maxAmount) {
    throw new GradingResultValidationError(`Amount for ${rule.id} is inconsistent with its triggered state or maximum`);
  }
  if (!triggered) {
    if (occurrences !== undefined) {
      throw new GradingResultValidationError(`Occurrences for ${rule.id} must be omitted when not triggered`);
    }
    return;
  }
  if (rule.policy === "fixed") {
    if (toUnits(amount) !== toUnits(rule.amount)) {
      throw new GradingResultValidationError(`Amount for ${rule.id} does not match the frozen fixed amount`);
    }
    return;
  }
  if (rule.policy === "per-occurrence") {
    if (amount === 0 || toUnits(amount) % toUnits(rule.unitAmount) !== 0) {
      throw new GradingResultValidationError(`Amount for ${rule.id} does not match the frozen occurrence increment`);
    }
    if (occurrences !== undefined) {
      const expectedUnits = Math.min(toUnits(rule.unitAmount) * occurrences, toUnits(rule.maxAmount));
      if (toUnits(amount) !== expectedUnits) {
        throw new GradingResultValidationError(`Occurrences for ${rule.id} does not match its submitted amount`);
      }
    }
    return;
  }
  // range
  if (amount <= 0 || toUnits(amount) < toUnits(rule.minAmount) || !validateStepAligned(amount, rule.step)) {
    throw new GradingResultValidationError(
      rule.step === 1
        ? `Amount for ${rule.id} must be a positive integer within the frozen range`
        : `Amount for ${rule.id} must be within the frozen range with step ${rule.step}`,
    );
  }
}

function validateDecisionEvidence(decision: { evidence: GradingEvidence[]; evidenceInsufficient?: boolean | undefined }, required: boolean, submission: Required<LockedSubmission>): void {
  if (required && decision.evidence.length === 0 && decision.evidenceInsufficient !== true) {
    throw new GradingResultValidationError("Required evidence must be supplied or marked insufficient");
  }
  for (const item of decision.evidence) {
    if (item.kind === "text") {
      if (item.path !== submission.path || item.startLine > item.endLine || item.endLine > submission.lineCount) {
        throw new GradingResultValidationError("Text evidence must belong to the current locked submission and valid line range");
      }
      const citedLines = submission.lines.slice(item.startLine - 1, item.endLine).join("\n");
      if (!citedLines.includes(item.quote)) throw new GradingResultValidationError("Text evidence quote must occur in the cited submission lines");
    } else if (item.kind === "image" && !submission.assetPaths.includes(item.path)) {
      throw new GradingResultValidationError("Image evidence must belong to the current locked submission");
    }
  }
}

function assertCompleteIds(expected: string[], actual: string[], label: string): void {
  if (new Set(actual).size !== actual.length || expected.length !== actual.length || expected.some((id) => !actual.includes(id))) {
    throw new GradingResultValidationError(`A decision is required for ${label}`);
  }
}

function allDecisions(draft: GradingDraft): Array<{ evidenceInsufficient?: boolean | undefined }> {
  const caps = draft.scoreCaps ?? [];
  if (draft.mode === "additive") return [...draft.criteria, ...caps];
  if (draft.mode === "deductive") return [...draft.deductions, ...caps];
  return [...draft.criteria, ...draft.bonuses, ...draft.deductions, ...caps];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
