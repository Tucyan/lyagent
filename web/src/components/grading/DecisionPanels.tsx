import { useMemo } from "react";
import {
  computeDecisionScorePreview,
  normalizeRubric,
  resolveCriterionLevelId,
  toUnits,
  validateDecisionDraftLocally,
  type AnyRubricLike,
  type NormalizedAdjustmentRule,
  type NormalizedCriterion,
  type NormalizedScoreCap,
} from "../../../../src/schemas/rubric-engine.js";
import { gradingItemLabel } from "../../pages/grading-page-model";
import { rubricLevelLabel } from "../../pages/rubric-page-model";

function decisionEntries(decisions: Record<string, unknown>) {
  return ["criteria", "deductions", "bonuses", "scoreCaps"].flatMap((key) =>
    Array.isArray(decisions[key])
      ? (decisions[key] as Array<Record<string, unknown>>).map(
          (item, index) => ({ key, index, item }),
        )
      : [],
  );
}

export function DecisionCards({
  decisions,
  sessionId,
  rubric,
  expandEvidence,
}: {
  decisions: Record<string, unknown>;
  sessionId: string;
  rubric?: AnyRubricLike;
  expandEvidence?: boolean;
}) {
  const normalized = useMemo(() => (rubric ? normalizeRubric(rubric) : undefined), [rubric]);
  const criteriaById = useMemo(
    () => new Map((normalized?.criteria ?? []).map((item) => [item.id, item])),
    [normalized],
  );
  const capsById = useMemo(
    () => new Map((normalized?.scoreCaps ?? []).map((item) => [item.id, item])),
    [normalized],
  );

  return (
    <section className="decision-list">
      {decisionEntries(decisions).map(({ key, item }, index) => {
        const evidence = Array.isArray(item.evidence)
          ? (item.evidence as Array<Record<string, unknown>>)
          : [];
        const id = String(item.criterionId ?? item.ruleId ?? "");
        const criterion = key === "criteria" ? criteriaById.get(id) : undefined;
        const cap = key === "scoreCaps" ? capsById.get(id) : undefined;
        const selectedLevel =
          typeof item.selectedLevelId === "string" && criterion
            ? criterion.levels.find((level) => level.id === item.selectedLevelId)
            : undefined;
        const levelBadge = selectedLevel
          ? selectedLevel.label ?? rubricLevelLabel(selectedLevel.id)
          : undefined;
        const badgeText =
          key === "scoreCaps"
            ? item.triggered
              ? `封顶 ≤ ${cap?.maxTotalScore ?? "?"} 分`
              : "未触发封顶"
            : item.score !== undefined
              ? `${item.score} 分${levelBadge ? ` · ${levelBadge}` : ""}`
              : item.deduction !== undefined
                ? item.triggered === false
                  ? "未扣分"
                  : `扣 ${item.deduction} 分`
                : item.bonus !== undefined
                  ? item.triggered === false
                    ? "未加分"
                    : `加 ${item.bonus} 分`
                  : "";
        return (
          <article key={`${key}-${id || index}`}>
            <div>
              <strong>
                {cap?.name ?? gradingItemLabel(rubric, id, index)}
              </strong>
              <span>{badgeText}</span>
            </div>
            <p>{String(item.reason ?? "")}</p>
            <small>
              置信度 {Math.round(Number(item.confidence ?? 0) * 100)}% ·
              分析依据 {evidence.length} 条
            </small>
            {evidence.length > 0 && (
              <details open={expandEvidence}>
                <summary>查看评分分析依据</summary>
                {evidence.map((entry, evidenceIndex) => (
                  <div
                    className="grading-evidence"
                    key={`${String(entry.path ?? entry.kind)}-${evidenceIndex}`}
                  >
                    {entry.kind === "analysis" ? (
                      <>
                        <strong>模型分析论据</strong>
                        <p>
                          <b>作业表现：</b>
                          {String(entry.observation ?? "")}
                        </p>
                        <p>
                          <b>标准对应：</b>
                          {String(entry.rubricBasis ?? "")}
                        </p>
                        <p>
                          <b>分值理由：</b>
                          {String(entry.scoreJustification ?? "")}
                        </p>
                      </>
                    ) : entry.kind === "image" ? (
                      <>
                        <img
                          src={`/api/grading/sessions/${sessionId}/assets/${encodeURIComponent(String(entry.path).replace(/^assets\//, ""))}`}
                          alt="评分佐证"
                        />
                        <p>{String(entry.explanation ?? "")}</p>
                      </>
                    ) : (
                      <>
                        <code>
                          {String(entry.path)}:{String(entry.startLine)}-
                          {String(entry.endLine)}
                        </code>
                        <blockquote>{String(entry.quote ?? "")}</blockquote>
                      </>
                    )}
                  </div>
                ))}
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function DecisionEditor({
  decisions,
  onChange,
  rubric,
  baselineScore,
}: {
  decisions: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  rubric?: AnyRubricLike;
  baselineScore?: number;
}) {
  const normalized = useMemo(() => (rubric ? normalizeRubric(rubric) : undefined), [rubric]);
  const criteriaById = useMemo(
    () => new Map((normalized?.criteria ?? []).map((item) => [item.id, item])),
    [normalized],
  );
  const deductionsById = useMemo(
    () => new Map((normalized?.deductionRules ?? []).map((item) => [item.id, item])),
    [normalized],
  );
  const bonusesById = useMemo(
    () => new Map((normalized?.bonusRules ?? []).map((item) => [item.id, item])),
    [normalized],
  );
  const capsById = useMemo(
    () => new Map((normalized?.scoreCaps ?? []).map((item) => [item.id, item])),
    [normalized],
  );

  const preview = useMemo(
    () => (rubric ? computeDecisionScorePreview(rubric, decisions) : undefined),
    [rubric, decisions],
  );
  const inlineErrors = useMemo(
    () => (rubric ? validateDecisionDraftLocally(rubric, decisions) : {}),
    [rubric, decisions],
  );

  const patchItem = (
    key: string,
    index: number,
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const next = structuredClone(decisions);
    const items = next[key] as Array<Record<string, unknown>>;
    items[index] = updater({ ...items[index] });
    onChange(next);
  };

  const updateField = (key: string, index: number, field: string, value: unknown) => {
    patchItem(key, index, (current) => ({ ...current, [field]: value }));
  };

  const updateCriterionScore = (
    index: number,
    criterion: NormalizedCriterion | undefined,
    score: number,
    explicitLevelId?: string,
  ) => {
    patchItem("criteria", index, (current) => {
      const next: Record<string, unknown> = { ...current, score };
      if (criterion) {
        const resolved = explicitLevelId ?? resolveCriterionLevelId(criterion, score);
        if (resolved) next.selectedLevelId = resolved;
        else delete next.selectedLevelId;
      }
      return next;
    });
  };

  const toggleRuleTriggered = (
    key: "deductions" | "bonuses",
    index: number,
    amountField: "deduction" | "bonus",
    rule: NormalizedAdjustmentRule | undefined,
    triggered: boolean,
  ) => {
    patchItem(key, index, (current) => {
      const next: Record<string, unknown> = { ...current, triggered };
      if (!triggered) {
        next[amountField] = 0;
        delete next.occurrences;
        return next;
      }
      if (!rule) return next;
      if (rule.policy === "fixed") {
        next[amountField] = rule.amount;
        delete next.occurrences;
      } else if (rule.policy === "per-occurrence") {
        const existingCount = typeof current.occurrences === "number" && current.occurrences >= 1
          ? current.occurrences
          : 1;
        const maxCount = Math.max(1, Math.floor(toUnits(rule.maxAmount) / Math.max(1, toUnits(rule.unitAmount))));
        const count = Math.min(existingCount, maxCount);
        next.occurrences = count;
        next[amountField] = Number((Math.min(toUnits(rule.unitAmount) * count, toUnits(rule.maxAmount)) / 100).toFixed(2));
      } else {
        const existingAmount = Number(current[amountField]);
        next[amountField] = Number.isFinite(existingAmount) && existingAmount >= rule.minAmount && existingAmount <= rule.maxAmount
          ? existingAmount
          : rule.minAmount;
        delete next.occurrences;
      }
      return next;
    });
  };

  const updateOccurrences = (
    key: "deductions" | "bonuses",
    index: number,
    amountField: "deduction" | "bonus",
    rule: Extract<NormalizedAdjustmentRule, { policy: "per-occurrence" }>,
    count: number,
  ) => {
    const maxCount = Math.max(1, Math.floor(toUnits(rule.maxAmount) / Math.max(1, toUnits(rule.unitAmount))));
    const clamped = Math.min(maxCount, Math.max(1, Math.round(count)));
    const amount = Number((Math.min(toUnits(rule.unitAmount) * clamped, toUnits(rule.maxAmount)) / 100).toFixed(2));
    patchItem(key, index, (current) => ({
      ...current,
      triggered: true,
      occurrences: clamped,
      [amountField]: amount,
    }));
  };

  const delta =
    preview && baselineScore !== undefined
      ? Number((preview.earned - baselineScore).toFixed(2))
      : undefined;

  return (
    <section className="decision-list decision-editor">
      {preview && (
        <div className="decision-editor-summary" role="status">
          <span>
            预计总分：<strong>{preview.earned} / {preview.possible}</strong>
          </span>
          {delta !== undefined && delta !== 0 && (
            <small className={delta > 0 ? "is-positive" : "is-negative"}>
              较当前草稿 {delta > 0 ? `+${delta}` : delta} 分
            </small>
          )}
        </div>
      )}
      {decisionEntries(decisions).map(({ key, index, item }) => {
        const id = String(item.criterionId ?? item.ruleId ?? "");
        const errorKey = `${key}:${id}`;
        const inlineError = inlineErrors[errorKey];
        const criterion = key === "criteria" ? criteriaById.get(id) : undefined;
        const rule =
          key === "deductions"
            ? deductionsById.get(id)
            : key === "bonuses"
              ? bonusesById.get(id)
              : undefined;
        const cap: NormalizedScoreCap | undefined = key === "scoreCaps" ? capsById.get(id) : undefined;

        return (
          <article key={`${key}-${index}`} className={inlineError ? "has-inline-error" : undefined}>
            <div className="decision-editor-heading">
              <strong>{cap?.name ?? gradingItemLabel(rubric, id, index)}</strong>
              {criterion && <small>满分 {criterion.maxScore} 分</small>}
              {rule && (
                <small>
                  {rule.policy === "fixed"
                    ? `固定 ${rule.amount} 分`
                    : rule.policy === "per-occurrence"
                      ? `${rule.unitAmount} 分/次 · 上限 ${rule.maxAmount} 分`
                      : `${rule.minAmount}–${rule.maxAmount} 分 · 步长 ${rule.step}`}
                </small>
              )}
              {cap && <small>封顶 ≤ {cap.maxTotalScore} 分</small>}
            </div>

            {key === "criteria" && (
              <CriterionScoreControl
                criterion={criterion}
                score={Number(item.score ?? 0)}
                selectedLevelId={typeof item.selectedLevelId === "string" ? item.selectedLevelId : undefined}
                onChange={(score, levelId) => updateCriterionScore(index, criterion, score, levelId)}
              />
            )}

            {(key === "deductions" || key === "bonuses") && (
              <AdjustmentRuleControl
                kind={key === "deductions" ? "deduction" : "bonus"}
                rule={rule}
                triggered={Boolean(item.triggered)}
                amount={Number(item[key === "deductions" ? "deduction" : "bonus"] ?? 0)}
                occurrences={typeof item.occurrences === "number" ? item.occurrences : undefined}
                onToggle={(triggered) =>
                  toggleRuleTriggered(
                    key,
                    index,
                    key === "deductions" ? "deduction" : "bonus",
                    rule,
                    triggered,
                  )
                }
                onChangeAmount={(amount) =>
                  updateField(key, index, key === "deductions" ? "deduction" : "bonus", amount)
                }
                onChangeOccurrences={(count) => {
                  if (rule?.policy === "per-occurrence") {
                    updateOccurrences(
                      key,
                      index,
                      key === "deductions" ? "deduction" : "bonus",
                      rule,
                      count,
                    );
                  }
                }}
              />
            )}

            {key === "scoreCaps" && (
              <label className="decision-trigger-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(item.triggered)}
                  onChange={(event) => updateField(key, index, "triggered", event.target.checked)}
                />
                触发总分封顶{cap ? `（总分不超过 ${cap.maxTotalScore} 分）` : ""}
              </label>
            )}

            {inlineError && (
              <p className="decision-inline-error" role="alert">
                {inlineError}
              </p>
            )}

            <label>
              理由
              <textarea
                value={String(item.reason ?? "")}
                onChange={(event) => updateField(key, index, "reason", event.target.value)}
              />
            </label>
            <label>
              置信度
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={Number(item.confidence ?? 0)}
                onChange={(event) => updateField(key, index, "confidence", Number(event.target.value))}
              />
            </label>
          </article>
        );
      })}
    </section>
  );
}

function CriterionScoreControl({
  criterion,
  score,
  selectedLevelId,
  onChange,
}: {
  criterion: NormalizedCriterion | undefined;
  score: number;
  selectedLevelId?: string | undefined;
  onChange: (score: number, levelId?: string) => void;
}) {
  if (!criterion) {
    return (
      <label>
        得分
        <input
          type="number"
          min="0"
          step="0.01"
          value={score}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    );
  }

  if (criterion.scoringType === "levels") {
    const activeId = selectedLevelId ?? resolveCriterionLevelId(criterion, score);
    return (
      <div className="decision-level-picker" role="group" aria-label="选择评分等级">
        <span>选择等级</span>
        <div className="decision-level-chips">
          {criterion.levels.map((level) => {
            const label = level.label ?? rubricLevelLabel(level.id);
            const active = activeId === level.id;
            return (
              <button
                key={level.id}
                type="button"
                className={`decision-level-chip${active ? " is-active" : ""}`}
                aria-pressed={active}
                title={level.condition}
                onClick={() => onChange(level.minScore, level.id)}
              >
                <strong>{label}</strong>
                <span>{level.minScore} 分</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (criterion.binaryOnly) {
    return (
      <div className="decision-level-picker" role="group" aria-label="选择是否得分">
        <span>得分（仅 0 分或满分）</span>
        <div className="decision-level-chips">
          {[0, criterion.maxScore].map((option) => {
            const active = toUnits(score) === toUnits(option);
            return (
              <button
                key={option}
                type="button"
                className={`decision-level-chip${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => onChange(option)}
              >
                {option === 0 ? "0 分（未达标）" : `${option} 分（满分）`}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const matchedLevelId = resolveCriterionLevelId(criterion, score);
  return (
    <div className="decision-scored-control">
      <label>
        得分（0–{criterion.maxScore} 分，步长 {criterion.step}）
        <input
          type="number"
          min="0"
          max={criterion.maxScore}
          step={criterion.step}
          value={score}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      {criterion.levels.length > 0 && (
        <div className="decision-level-chips" aria-label="参考分档">
          {criterion.levels.map((level) => {
            const label = level.label ?? rubricLevelLabel(level.id);
            const active = matchedLevelId === level.id;
            const rangeText = level.minScore === level.maxScore
              ? `${level.minScore} 分`
              : `${level.minScore}–${level.maxScore} 分`;
            return (
              <button
                key={level.id}
                type="button"
                className={`decision-level-chip${active ? " is-active" : ""}`}
                aria-pressed={active}
                title={level.condition}
                onClick={() => onChange(level.maxScore, level.id)}
              >
                <strong>{label}</strong>
                <span>{rangeText}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdjustmentRuleControl({
  kind,
  rule,
  triggered,
  amount,
  occurrences,
  onToggle,
  onChangeAmount,
  onChangeOccurrences,
}: {
  kind: "deduction" | "bonus";
  rule: NormalizedAdjustmentRule | undefined;
  triggered: boolean;
  amount: number;
  occurrences?: number | undefined;
  onToggle: (triggered: boolean) => void;
  onChangeAmount: (amount: number) => void;
  onChangeOccurrences: (count: number) => void;
}) {
  const actionLabel = kind === "deduction" ? "扣分" : "加分";
  return (
    <div className="decision-rule-control">
      <label className="decision-trigger-toggle">
        <input
          type="checkbox"
          checked={triggered}
          onChange={(event) => onToggle(event.target.checked)}
        />
        触发规则
      </label>

      {triggered && rule?.policy === "fixed" && (
        <p className="decision-fixed-amount">
          已触发：固定{actionLabel} <strong>{rule.amount} 分</strong>
        </p>
      )}

      {triggered && rule?.policy === "per-occurrence" && (() => {
        const unitUnits = Math.max(1, toUnits(rule.unitAmount));
        const maxCount = Math.max(1, Math.floor(toUnits(rule.maxAmount) / unitUnits));
        const currentCount = occurrences ?? Math.max(1, Math.min(maxCount, Math.round(toUnits(amount) / unitUnits)));
        return (
          <div className="decision-occurrence-stepper">
            <span>触发次数</span>
            <div className="decision-stepper-row">
              <button
                type="button"
                disabled={currentCount <= 1}
                aria-label="减少次数"
                onClick={() => onChangeOccurrences(currentCount - 1)}
              >
                −
              </button>
              <strong>{currentCount} 次</strong>
              <button
                type="button"
                disabled={currentCount >= maxCount}
                aria-label="增加次数"
                onClick={() => onChangeOccurrences(currentCount + 1)}
              >
                +
              </button>
              <small>
                × {rule.unitAmount} 分 = {amount} 分（上限 {rule.maxAmount} 分）
              </small>
            </div>
          </div>
        );
      })()}

      {triggered && (!rule || rule.policy === "range") && (
        <label>
          {actionLabel}
          {rule?.policy === "range" ? `（${rule.minAmount}–${rule.maxAmount} 分，步长 ${rule.step}）` : ""}
          <input
            type="number"
            min={rule?.policy === "range" ? rule.minAmount : 0}
            max={rule?.policy === "range" ? rule.maxAmount : undefined}
            step={rule?.policy === "range" ? rule.step : 0.01}
            value={amount}
            onChange={(event) => onChangeAmount(Number(event.target.value))}
          />
        </label>
      )}
    </div>
  );
}
