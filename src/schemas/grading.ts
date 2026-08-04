import { z } from "zod";
import { calculateRubricScore, type DeductionRule, type Rubric } from "./rubric.js";

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
  ...commonDecision,
});

export const bonusDecisionSchema = z.object({
  ruleId: identifierSchema,
  triggered: z.boolean(),
  bonus: scoreSchema,
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
  ...narrativeFields,
});

const deductiveDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("deductive"),
  deductions: z.array(deductionDecisionSchema).max(80),
  ...narrativeFields,
});

const hybridDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.literal("hybrid"),
  criteria: z.array(criterionDecisionSchema).max(40),
  bonuses: z.array(bonusDecisionSchema).max(40),
  deductions: z.array(deductionDecisionSchema).max(80),
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
  const draft = gradingDraftSchema.parse(input.draft);
  if (draft.mode !== input.rubric.mode) throw new GradingResultValidationError("Grading draft mode does not match the frozen rubric");
  const submission = parseSubmission(input.submission);
  const threshold = input.lowConfidenceThreshold ?? 0.7;

  let earned: number;
  let weightedConfidence: Array<{ confidence: number; weight: number }>;
  if (input.rubric.mode === "additive" && draft.mode === "additive") {
    assertCompleteIds(input.rubric.criteria.map(({ id }) => id), draft.criteria.map(({ criterionId }) => criterionId), "every rubric criterion");
    const decisions = new Map(draft.criteria.map((decision) => [decision.criterionId, decision]));
    for (const criterion of input.rubric.criteria) {
      const decision = decisions.get(criterion.id)!;
      validateCriterionScore(criterion, decision, input.rubric.partialCreditAllowed);
      validateDecisionEvidence(decision, criterion.evidenceRequired, submission);
    }
    earned = calculateRubricScore(input.rubric, { criteria: Object.fromEntries(draft.criteria.map((decision) => [decision.criterionId, decision.score])) });
    weightedConfidence = input.rubric.criteria.map((criterion) => ({ confidence: decisions.get(criterion.id)!.confidence, weight: criterion.maxScore }));
  } else if (input.rubric.mode === "deductive" && draft.mode === "deductive") {
    assertCompleteIds(input.rubric.rules.map(({ id }) => id), draft.deductions.map(({ ruleId }) => ruleId), "every rubric rule");
    const decisions = new Map(draft.deductions.map((decision) => [decision.ruleId, decision]));
    for (const rule of input.rubric.rules) {
      const decision = decisions.get(rule.id)!;
      validateDeductionAmount(decision.triggered, decision.deduction, rule);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    earned = calculateRubricScore(input.rubric, { deductions: Object.fromEntries(draft.deductions.map((decision) => [decision.ruleId, decision.triggered ? decision.deduction : 0])) });
    weightedConfidence = input.rubric.rules.map((rule) => ({ confidence: decisions.get(rule.id)!.confidence, weight: rule.maxDeduction }));
  } else if (input.rubric.mode === "hybrid" && draft.mode === "hybrid") {
    assertCompleteIds(input.rubric.criteria.map(({ id }) => id), draft.criteria.map(({ criterionId }) => criterionId), "every rubric criterion");
    assertCompleteIds(input.rubric.bonusRules.map(({ id }) => id), draft.bonuses.map(({ ruleId }) => ruleId), "every bonus rule");
    assertCompleteIds(input.rubric.deductionRules.map(({ id }) => id), draft.deductions.map(({ ruleId }) => ruleId), "every deduction rule");
    const criteria = new Map(draft.criteria.map((decision) => [decision.criterionId, decision]));
    const bonuses = new Map(draft.bonuses.map((decision) => [decision.ruleId, decision]));
    const deductions = new Map(draft.deductions.map((decision) => [decision.ruleId, decision]));
    for (const criterion of input.rubric.criteria) {
      const decision = criteria.get(criterion.id)!;
      validateCriterionScore(criterion, decision, input.rubric.partialCreditAllowed);
      validateDecisionEvidence(decision, criterion.evidenceRequired, submission);
    }
    for (const rule of input.rubric.bonusRules) {
      const decision = bonuses.get(rule.id)!;
      validateTriggeredAmount(decision.triggered, decision.bonus, rule.bonus, rule.maxBonus, rule.occurrence, rule.id);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    for (const rule of input.rubric.deductionRules) {
      const decision = deductions.get(rule.id)!;
      validateDeductionAmount(decision.triggered, decision.deduction, rule);
      validateDecisionEvidence(decision, rule.evidenceRequired && decision.triggered, submission);
    }
    earned = calculateRubricScore(input.rubric, {
      criteria: Object.fromEntries(draft.criteria.map((decision) => [decision.criterionId, decision.score])),
      bonuses: Object.fromEntries(draft.bonuses.map((decision) => [decision.ruleId, decision.triggered ? decision.bonus : 0])),
      deductions: Object.fromEntries(draft.deductions.map((decision) => [decision.ruleId, decision.triggered ? decision.deduction : 0])),
    });
    weightedConfidence = [
      ...input.rubric.criteria.map((rule) => ({ confidence: criteria.get(rule.id)!.confidence, weight: rule.maxScore })),
      ...input.rubric.bonusRules.map((rule) => ({ confidence: bonuses.get(rule.id)!.confidence, weight: rule.maxBonus })),
      ...input.rubric.deductionRules.map((rule) => ({ confidence: deductions.get(rule.id)!.confidence, weight: rule.maxDeduction })),
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
    score: { earned, possible: input.rubric.totalScore },
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

function validateCriterionScore(
  criterion: Extract<Rubric, { mode: "additive" | "hybrid" }>["criteria"][number],
  decision: z.infer<typeof criterionDecisionSchema>,
  partialCreditAllowed: boolean,
): void {
  if (decision.score > criterion.maxScore) throw new GradingResultValidationError(`Score for ${criterion.id} exceeds its maximum`);
  const levels = criterion.levels ?? [];
  if (criterion.scorePolicy !== "continuous" && !decision.selectedLevelId) throw new GradingResultValidationError(`A selected level is required for ${criterion.id}`);
  if (decision.selectedLevelId) {
    const level = levels.find(({ id }) => id === decision.selectedLevelId);
    if (!level) throw new GradingResultValidationError(`Selected level for ${criterion.id} is not in the frozen rubric`);
    if (decision.score < level.minScore || decision.score > level.maxScore) throw new GradingResultValidationError(`Score for ${criterion.id} is outside the selected level`);
    if (criterion.scorePolicy === "exact-level" && decision.score !== level.minScore) throw new GradingResultValidationError(`Score for ${criterion.id} must equal its exact level score`);
  }
  if (!partialCreditAllowed && decision.score !== 0 && decision.score !== criterion.maxScore && criterion.scorePolicy !== "exact-level") {
    throw new GradingResultValidationError(`Partial credit is not allowed for ${criterion.id}`);
  }
}

function validateTriggeredAmount(triggered: boolean, amount: number, increment: number, maximum: number, occurrence: "once" | "per-occurrence", id: string): void {
  if ((!triggered && amount !== 0) || amount > maximum) throw new GradingResultValidationError(`Amount for ${id} is inconsistent with its triggered state or maximum`);
  if (triggered && (amount === 0 || (occurrence === "once" ? amount !== increment : Math.round(amount * 100) % Math.round(increment * 100) !== 0))) {
    throw new GradingResultValidationError(`Amount for ${id} does not match the frozen occurrence increment`);
  }
}

function validateDeductionAmount(triggered: boolean, amount: number, rule: DeductionRule): void {
  if ((!triggered && amount !== 0) || amount > rule.maxDeduction) throw new GradingResultValidationError(`Amount for ${rule.id} is inconsistent with its triggered state or maximum`);
  if (!triggered) return;
  const policy = rule.amountPolicy ?? (rule.occurrence === "per-occurrence" ? "per-occurrence" : "fixed");
  if (policy === "range") {
    if (amount <= 0 || !Number.isInteger(amount)) throw new GradingResultValidationError(`Amount for ${rule.id} must be a positive integer within the frozen range`);
    return;
  }
  const deduction = rule.deduction;
  if (deduction === undefined) throw new GradingResultValidationError(`Frozen deduction ${rule.id} is missing its amount`);
  if (policy === "fixed" && amount !== deduction) throw new GradingResultValidationError(`Amount for ${rule.id} does not match the frozen fixed deduction`);
  if (policy === "per-occurrence" && (amount === 0 || Math.round(amount * 100) % Math.round(deduction * 100) !== 0)) {
    throw new GradingResultValidationError(`Amount for ${rule.id} does not match the frozen occurrence increment`);
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
  if (draft.mode === "additive") return draft.criteria;
  if (draft.mode === "deductive") return draft.deductions;
  return [...draft.criteria, ...draft.bonuses, ...draft.deductions];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
