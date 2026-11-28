import { gradingItemLabel } from "../../pages/grading-page-model.js";

export const LOW_CONFIDENCE_DISPLAY_THRESHOLD = 0.7;

export const QUICK_REVIEW_NOTES = [
  "已核对低置信度项与原文，确认评分无误",
  "已逐项核对评分依据，同意当前评分结果",
] as const;

export const QUICK_EDIT_NOTES = [
  "已核对原文，按评分标准微调分值",
  "结合学生作答细节人工修订评分理由与分值",
] as const;

export type ConfidenceSummaryLike = {
  overall: number;
  minimum: number;
  lowCount?: number | undefined;
  lowConfidenceCount?: number | undefined;
};

export type GradingResultSummaryInput = {
  score: { earned: number; possible: number };
  confidence: ConfidenceSummaryLike;
  review: { requiresReview: boolean; reasons: string[] };
  decisions: Record<string, unknown>;
};

export type DecisionEntryKey = "criteria" | "deductions" | "bonuses" | "scoreCaps";

export type DecisionEntry = {
  key: DecisionEntryKey;
  index: number;
  item: Record<string, unknown>;
};

export type EvidenceJumpTarget =
  | {
      key: string;
      kind: "text";
      itemLabel: string;
      path: string;
      startLine: number;
      endLine: number;
      quote: string;
      nonce: number;
    }
  | {
      key: string;
      kind: "image";
      itemLabel: string;
      path: string;
      explanation: string;
      nonce: number;
    };

export type EvidenceJumpPayload =
  | Omit<Extract<EvidenceJumpTarget, { kind: "text" }>, "nonce">
  | Omit<Extract<EvidenceJumpTarget, { kind: "image" }>, "nonce">;

const DECISION_KEYS: readonly DecisionEntryKey[] = ["criteria", "deductions", "bonuses", "scoreCaps"];

export function decisionEntries(decisions: Record<string, unknown>): DecisionEntry[] {
  return DECISION_KEYS.flatMap((key) =>
    Array.isArray(decisions[key])
      ? (decisions[key] as Array<Record<string, unknown>>).map((item, index) => ({ key, index, item }))
      : [],
  );
}

export function resolveLowConfidenceCount(confidence: ConfidenceSummaryLike): number {
  return confidence.lowCount ?? confidence.lowConfidenceCount ?? 0;
}

export function isAttentionDecisionItem(
  item: Record<string, unknown>,
  threshold = LOW_CONFIDENCE_DISPLAY_THRESHOLD,
): boolean {
  const confidence = Number(item.confidence ?? 1);
  return (Number.isFinite(confidence) && confidence < threshold) || item.evidenceInsufficient === true;
}

export function partitionDecisionEvidence(
  evidence: ReadonlyArray<Record<string, unknown>>,
): {
  citations: Array<Record<string, unknown>>;
  analyses: Array<Record<string, unknown>>;
} {
  const citations: Array<Record<string, unknown>> = [];
  const analyses: Array<Record<string, unknown>> = [];
  for (const entry of evidence) {
    if (entry.kind === "analysis") analyses.push(entry);
    else citations.push(entry);
  }
  return { citations, analyses };
}

export function nextStepHint(
  mode: "single" | "batch",
  confirmed: boolean,
  requiresReview: boolean,
  confirmationMode?: "auto" | "manual",
): string {
  if (confirmed) {
    if (confirmationMode === "auto") {
      return mode === "single"
        ? "本份作业整体置信度达标（≥ 85%），系统已自动确认；可直接导出 JSON / Markdown，或按需创建结果修订。"
        : "本份作业整体置信度达标（≥ 85%），系统已自动确认；可查看依据或前往单份批改页修订。";
    }
    return mode === "single"
      ? "成绩已人工正式确认，可直接导出 JSON / Markdown，或按需创建结果修订。"
      : "本份成绩已人工确认，可点击右上角切换下一份或返回导出成绩。";
  }
  if (requiresReview) {
    return mode === "single"
      ? "下一步：勾选上方待复核事项并填写复核备注后，点击确认发布；如需调整分值，可点击人工修订。"
      : "下一步：勾选待复核事项并填写复核备注后，点击确认并继续下一份；如需改分请先点击修改评分结果。";
  }
  return mode === "single"
    ? "下一步：各项判断置信度正常，可直接确认发布；也可按需展开分项得分与依据核对。"
    : "下一步：各项判断置信度正常，可直接确认并继续下一份；也可按需展开分项核对。";
}

export interface GradingResultOverviewSummary {
  earned: number;
  possible: number;
  scorePercent: number;
  overallConfidencePercent: number;
  minimumConfidencePercent: number;
  lowConfidenceCount: number;
  totalItems: number;
  attentionItemCount: number;
  requiresReview: boolean;
  statusLabel: string;
  statusTone: "confirmed" | "review" | "ready";
  nextStep: string;
}

export function summarizeGradingResult(
  result: GradingResultSummaryInput,
  input: { mode: "single" | "batch"; confirmed: boolean; confirmationMode?: "auto" | "manual" },
): GradingResultOverviewSummary {
  const entries = decisionEntries(result.decisions);
  const lowConfidenceCount = resolveLowConfidenceCount(result.confidence);
  const attentionItemCount = entries.filter(({ item }) => isAttentionDecisionItem(item)).length;
  const possible = result.score.possible;
  const earned = result.score.earned;
  const scorePercent = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  const overallConfidencePercent = Math.round(result.confidence.overall * 100);
  const minimumConfidencePercent = Math.round(result.confidence.minimum * 100);
  const requiresReview = result.review.requiresReview;

  const statusTone: "confirmed" | "review" | "ready" = input.confirmed
    ? "confirmed"
    : requiresReview
      ? "review"
      : "ready";
  const statusLabel = input.confirmed
    ? input.confirmationMode === "auto"
      ? "已自动确认"
      : "已人工确认"
    : requiresReview
      ? "待复核"
      : "可确认发布";

  return {
    earned,
    possible,
    scorePercent,
    overallConfidencePercent,
    minimumConfidencePercent,
    lowConfidenceCount,
    totalItems: entries.length,
    attentionItemCount,
    requiresReview,
    statusLabel,
    statusTone,
    nextStep: nextStepHint(input.mode, input.confirmed, requiresReview, input.confirmationMode),
  };
}

export function collectCitedLineNumbers(decisions: Record<string, unknown>): Set<number> {
  const lines = new Set<number>();
  for (const { item } of decisionEntries(decisions)) {
    const evidence = Array.isArray(item.evidence)
      ? (item.evidence as Array<Record<string, unknown>>)
      : [];
    for (const entry of evidence) {
      if (entry.kind !== "text") continue;
      const start = Number(entry.startLine);
      const end = Number(entry.endLine);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
      for (let line = start; line <= end; line += 1) lines.add(line);
    }
  }
  return lines;
}

export function splitLineHighlightSegments(
  line: string,
  quote: string,
): Array<{ text: string; highlighted: boolean }> {
  if (!line) return [{ text: "", highlighted: false }];
  const candidates = quote
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (candidates.length === 0) return [{ text: line, highlighted: false }];

  for (const candidate of candidates) {
    const idx = line.indexOf(candidate);
    if (idx !== -1) {
      const segments: Array<{ text: string; highlighted: boolean }> = [];
      if (idx > 0) segments.push({ text: line.slice(0, idx), highlighted: false });
      segments.push({ text: line.slice(idx, idx + candidate.length), highlighted: true });
      if (idx + candidate.length < line.length) {
        segments.push({ text: line.slice(idx + candidate.length), highlighted: false });
      }
      return segments;
    }
  }
  return [{ text: line, highlighted: false }];
}

type NamedRubricLike = {
  criteria?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  rules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  deductionRules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  bonusRules?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
  scoreCaps?: ReadonlyArray<{ id?: string | undefined; name: string }> | undefined;
};

export function collectAllEvidenceTargets(
  decisions: Record<string, unknown>,
  rubric?: NamedRubricLike,
): EvidenceJumpPayload[] {
  const targets: EvidenceJumpPayload[] = [];
  const entries = decisionEntries(decisions);
  const capsById = new Map((rubric?.scoreCaps ?? []).map((item) => [item.id ?? "", item.name]));

  entries.forEach(({ key, item }, index) => {
    const evidence = Array.isArray(item.evidence)
      ? (item.evidence as Array<Record<string, unknown>>)
      : [];
    const { citations } = partitionDecisionEvidence(evidence);
    const id = String(item.criterionId ?? item.ruleId ?? "");
    const itemLabel = (key === "scoreCaps" ? capsById.get(id) : undefined) ?? gradingItemLabel(rubric, id, index);

    citations.forEach((entry, evidenceIndex) => {
      const evidenceKey = `${key}:${id || index}:${evidenceIndex}`;
      if (entry.kind === "image") {
        targets.push({
          key: evidenceKey,
          kind: "image",
          itemLabel,
          path: String(entry.path ?? ""),
          explanation: String(entry.explanation ?? ""),
        });
      } else {
        const startLine = Number(entry.startLine ?? 1);
        const endLine = Number(entry.endLine ?? startLine);
        targets.push({
          key: evidenceKey,
          kind: "text",
          itemLabel,
          path: String(entry.path ?? ""),
          startLine,
          endLine,
          quote: String(entry.quote ?? ""),
        });
      }
    });
  });

  return targets;
}
