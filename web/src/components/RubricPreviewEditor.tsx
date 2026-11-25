import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  inferCriterionStep,
  normalizeRubric,
  toUnits,
  validateStepAligned,
  type AnyRubricLike,
  type NormalizedScoreCap,
  type ScoreStep,
} from "../../../src/schemas/rubric-engine.js";
import { rubricLevelLabel, rubricLevelTone, rubricPreviewSections } from "../pages/rubric-page-model";
import { useToast } from "./ToastProvider";

export type RubricMode = "additive" | "deductive" | "hybrid";
export type ScoringType = "levels" | "scored";
export type RulePolicy = "fixed" | "per-occurrence" | "range";

export interface DiscreteLevel {
  id: string;
  label?: string;
  score: number;
  condition: string;
}

export interface ScoredLevel {
  id: string;
  label?: string;
  minScore: number;
  maxScore: number;
  condition: string;
}

export type RubricCriterionV2 =
  | {
      id: string;
      name: string;
      description: string;
      maxScore: number;
      scoringType: "levels";
      evidenceRequired: boolean;
      levels: DiscreteLevel[];
    }
  | {
      id: string;
      name: string;
      description: string;
      maxScore: number;
      scoringType: "scored";
      step: ScoreStep;
      evidenceRequired: boolean;
      levels?: ScoredLevel[];
    };

export type AdjustmentRuleV2 =
  | {
      id: string;
      name: string;
      condition: string;
      policy: "fixed";
      amount: number;
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
      minAmount?: number;
      maxAmount: number;
      step: ScoreStep;
      evidenceRequired: boolean;
      overlapGroup?: string;
    };

export interface OverlapGroup {
  id: string;
  aggregation: "highest-only" | "sum";
}

export type RubricV2Value =
  | {
      schemaVersion: "2.0";
      mode: "additive";
      totalScore: number;
      criteria: RubricCriterionV2[];
      scoreCaps?: NormalizedScoreCap[];
    }
  | {
      schemaVersion: "2.0";
      mode: "deductive";
      totalScore: number;
      rules: AdjustmentRuleV2[];
      scoreCaps?: NormalizedScoreCap[];
      overlapGroups: OverlapGroup[];
    }
  | {
      schemaVersion: "2.0";
      mode: "hybrid";
      totalScore: number;
      criteria: RubricCriterionV2[];
      bonusRules: AdjustmentRuleV2[];
      deductionRules: AdjustmentRuleV2[];
      scoreCaps?: NormalizedScoreCap[];
      overlapGroups: OverlapGroup[];
    };

export type RubricValue = AnyRubricLike;

export interface RubricEditFocusTarget {
  key: string;
  nonce: number;
}

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };
const scoringTypeLabel: Record<ScoringType, string> = { levels: "按档定分", scored: "区间打分" };
const STEP_OPTIONS: ScoreStep[] = [1, 0.5, 0.1, 0.01];

interface ScrollAnchorSnapshot {
  container: HTMLElement;
  anchorKey: string;
  offsetTop: number;
}

function findScrollContainer(origin: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = origin?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function captureAnchorInContainer(rootEl: HTMLElement | null): ScrollAnchorSnapshot | null {
  if (!rootEl || typeof window === "undefined") return null;
  const container = findScrollContainer(rootEl);
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const anchors = [...rootEl.querySelectorAll<HTMLElement>("[data-anchor-key]")];
  for (const el of anchors) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > containerRect.top + 8) {
      const anchorKey = el.dataset.anchorKey;
      if (anchorKey) {
        return { container, anchorKey, offsetTop: rect.top - containerRect.top };
      }
    }
  }
  return null;
}

function useScrollAnchorRestore(rootRef: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const pendingAnchorRef = useRef<ScrollAnchorSnapshot | null>(null);

  const captureBeforeChange = () => {
    pendingAnchorRef.current = captureAnchorInContainer(rootRef.current);
  };

  useLayoutEffect(() => {
    const snap = pendingAnchorRef.current;
    if (!snap) return;
    pendingAnchorRef.current = null;
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-anchor-key="${CSS.escape(snap.anchorKey)}"]`);
    if (!target) return;
    const containerRect = snap.container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const delta = (targetRect.top - containerRect.top) - snap.offsetTop;
    if (Math.abs(delta) > 0.5) {
      snap.container.scrollTop += delta;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return captureBeforeChange;
}

export function toEditableV2(rubric: AnyRubricLike): RubricV2Value {
  if (rubric.schemaVersion === "2.0") return rubric as RubricV2Value;
  const normalized = normalizeRubric(rubric);
  const criteria: RubricCriterionV2[] = normalized.criteria.map((criterion) => {
    if (criterion.binaryOnly) {
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
    if (criterion.scoringType === "levels") {
      return {
        id: criterion.id,
        name: criterion.name,
        description: criterion.description,
        maxScore: criterion.maxScore,
        scoringType: "levels",
        evidenceRequired: criterion.evidenceRequired,
        levels: criterion.levels.map((level) => ({
          id: level.id,
          ...(level.label ? { label: level.label } : {}),
          score: level.minScore,
          condition: level.condition,
        })),
      };
    }
    const step = inferCriterionStep(criterion.maxScore, criterion.levels);
    return {
      id: criterion.id,
      name: criterion.name,
      description: criterion.description,
      maxScore: criterion.maxScore,
      scoringType: "scored",
      step,
      evidenceRequired: criterion.evidenceRequired,
      ...(criterion.levels.length > 0 ? { levels: criterion.levels } : {}),
    };
  });
  const mapRule = (rule: ReturnType<typeof normalizeRubric>["deductionRules"][number]): AdjustmentRuleV2 => {
    const base = {
      id: rule.id,
      name: rule.name,
      condition: rule.condition,
      evidenceRequired: rule.evidenceRequired,
      ...(rule.overlapGroup ? { overlapGroup: rule.overlapGroup } : {}),
    };
    if (rule.policy === "fixed") return { ...base, policy: "fixed", amount: rule.amount };
    if (rule.policy === "per-occurrence") return { ...base, policy: "per-occurrence", unitAmount: rule.unitAmount, maxAmount: rule.maxAmount };
    return { ...base, policy: "range", minAmount: rule.minAmount, maxAmount: rule.maxAmount, step: rule.step };
  };
  const caps = normalized.scoreCaps.length > 0 ? { scoreCaps: normalized.scoreCaps } : {};
  if (normalized.mode === "additive") {
    return { schemaVersion: "2.0", mode: "additive", totalScore: normalized.totalScore, criteria, ...caps };
  }
  if (normalized.mode === "deductive") {
    return {
      schemaVersion: "2.0",
      mode: "deductive",
      totalScore: normalized.totalScore,
      rules: normalized.deductionRules.map(mapRule),
      overlapGroups: normalized.overlapGroups,
      ...caps,
    };
  }
  return {
    schemaVersion: "2.0",
    mode: "hybrid",
    totalScore: normalized.totalScore,
    criteria,
    bonusRules: normalized.bonusRules.map(mapRule),
    deductionRules: normalized.deductionRules.map(mapRule),
    overlapGroups: normalized.overlapGroups,
    ...caps,
  };
}

export interface RubricDocumentHandle {
  toggleAllLevels: () => void;
}

export function RubricDocument({
  rubric,
  activeTargetKey,
  onSelectTarget,
  docRef,
  onLevelToggleStateChange,
}: {
  rubric: RubricValue;
  activeTargetKey?: string;
  onSelectTarget?: (targetKey: string) => void;
  docRef?: React.RefObject<RubricDocumentHandle | null>;
  onLevelToggleStateChange?: (state: { total: number; allExpanded: boolean }) => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const sections = rubricPreviewSections(rubric);
  const levelRowKeys = useMemo(
    () =>
      sections.flatMap((section, sIdx) =>
        section.rows
          .map((row, rIdx) => (row.levels && row.levels.length > 0 ? row.targetKey ?? `${sIdx}:${rIdx}` : null))
          .filter((key): key is string => Boolean(key)),
      ),
    [sections],
  );
  const [expandedLevels, setExpandedLevels] = useState<Record<string, boolean>>({});
  const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
  const captureBeforeChange = useScrollAnchorRestore(rootRef, [expandedLevels]);

  const allLevelsExpanded =
    levelRowKeys.length > 0 && levelRowKeys.every((key) => Boolean(expandedLevels[key]));

  const toggleAllLevels = () => {
    captureBeforeChange();
    const nextOpen = !allLevelsExpanded;
    const nextMap: Record<string, boolean> = {};
    for (const key of levelRowKeys) nextMap[key] = nextOpen;
    setExpandedLevels(nextMap);
  };

  useImperativeHandle(docRef, () => ({ toggleAllLevels }));

  useEffect(() => {
    onLevelToggleStateChange?.({ total: levelRowKeys.length, allExpanded: allLevelsExpanded });
  }, [allLevelsExpanded, levelRowKeys.length, onLevelToggleStateChange]);

  const showLegacyPartialRow =
    rubric.schemaVersion === "1.0" &&
    (rubric.mode === "additive" || rubric.mode === "hybrid") &&
    rubric.partialCreditAllowed !== undefined;
  const showInlineExpandAll = !onLevelToggleStateChange && levelRowKeys.length > 0;

  return <article className="rubric-document" ref={rootRef}>
    <header><div><span>{modeLabel[rubric.mode]}</span><h3>评分量表</h3></div><strong>{rubric.totalScore} 分</strong></header>
    {(showLegacyPartialRow || showInlineExpandAll) && (
      <div className="rubric-document-bar">
        {showLegacyPartialRow ? (
          <p className="rubric-document-policy">{rubric.partialCreditAllowed ? "允许部分得分" : "不允许部分得分"}</p>
        ) : <span />}
        {showInlineExpandAll && (
          <button
            type="button"
            className="rubric-expand-all-btn"
            onClick={toggleAllLevels}
          >
            {allLevelsExpanded ? "收起全部细则" : `展开全部细则 (${levelRowKeys.length})`}
          </button>
        )}
      </div>
    )}
    {sections.map((section, sIdx) => <section className="rubric-document-section" key={section.title}>
      <h4>{section.title}</h4>
      <div className="rubric-scorecard">{section.rows.map((row, index) => {
        const rowKey = row.targetKey ?? `${sIdx}:${index}`;
        const isLevelsOpen = Boolean(expandedLevels[rowKey]);
        const isDescriptionOpen = Boolean(expandedDescriptions[rowKey]);
        const isSelected = Boolean(activeTargetKey && row.targetKey && activeTargetKey === row.targetKey);
        return <article
          key={`${section.title}-${index}`}
          data-anchor-key={rowKey}
          className={`${onSelectTarget && row.targetKey ? "is-selectable" : ""} ${isSelected ? "is-selected-target" : ""}`}
        >
          <div className="rubric-scorecard-head">
            <strong>{row.title}</strong>
            <div className="rubric-scorecard-head-right">
              <span>{row.score}</span>
              {onSelectTarget && row.targetKey && (
                <button
                  type="button"
                  className="rubric-jump-edit-btn"
                  title="在左侧定位并编辑此项"
                  onClick={() => onSelectTarget(row.targetKey!)}
                >
                  ✎ 编辑
                </button>
              )}
            </div>
          </div>
          <small>{row.detail}</small>
          {row.levels ? (
            <>
              <div className="rubric-card-toggle-row">
                {row.description.trim() && (
                  <button
                    type="button"
                    className={`rubric-description-toggle${isDescriptionOpen ? " is-open" : ""}`}
                    aria-expanded={isDescriptionOpen}
                    onClick={() => setExpandedDescriptions((prev) => ({ ...prev, [rowKey]: !isDescriptionOpen }))}
                  >
                    查看评分说明摘要
                  </button>
                )}
                <button
                  type="button"
                  className={`rubric-levels-toggle${isLevelsOpen ? " is-open" : ""}`}
                  aria-expanded={isLevelsOpen}
                  onClick={() => setExpandedLevels((prev) => ({ ...prev, [rowKey]: !isLevelsOpen }))}
                >
                  {isLevelsOpen ? "收起评分细则" : `展开评分细则（${row.levels.length} 档）`}
                </button>
              </div>
              {row.description.trim() && (
                <p className="rubric-description-body" hidden={!isDescriptionOpen}>{row.description}</p>
              )}
              <div className="rubric-preview-levels" hidden={!isLevelsOpen}>{row.levels.map((level) => <div className={`rubric-level-card ${level.tone}`} data-level-id={level.id} title={level.id} key={level.id}><span className="rubric-level-badge">{level.label}</span><span className="rubric-level-score">{level.score}</span><p>{level.condition}</p></div>)}</div>
            </>
          ) : (
            <p>{row.description}</p>
          )}
        </article>;
      })}</div>
    </section>)}
  </article>;
}

export function RubricEditor({
  rubric,
  onChange,
  focusTarget,
}: {
  rubric: RubricValue;
  onChange: (rubric: RubricV2Value) => void;
  focusTarget?: RubricEditFocusTarget;
}) {
  const editable = useMemo(() => toEditableV2(rubric), [rubric]);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [focusedKey, setFocusedKey] = useState<string>();

  useEffect(() => {
    if (!focusTarget) return;
    setFocusedKey(focusTarget.key);
    const timer = window.setTimeout(() => {
      const targetEl = editorRootRef.current?.querySelector<HTMLElement>(`[data-anchor-key="${CSS.escape(focusTarget.key)}"]`);
      targetEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 30);
    const clearTimer = window.setTimeout(() => setFocusedKey(undefined), 1800);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clearTimer);
    };
  }, [focusTarget]);

  const updateCriteria = (criteria: RubricCriterionV2[]) => onChange({ ...editable, criteria } as RubricV2Value);
  const updateScoreCaps = (scoreCaps: NormalizedScoreCap[]) => {
    if (scoreCaps.length === 0) {
      const { scoreCaps: _removed, ...rest } = editable;
      onChange(rest as RubricV2Value);
    } else {
      onChange({ ...editable, scoreCaps } as RubricV2Value);
    }
  };
  const removeWithUndo = (label: string, nextRubric: RubricV2Value) => {
    const snapshot = structuredClone(editable);
    onChange(nextRubric);
    toast.info(`已删除“${label}”`, {
      action: { label: "撤销", onClick: () => onChange(snapshot) },
      durationMs: 6000,
    });
  };
  const criteriaTotal = editable.mode === "additive" || editable.mode === "hybrid"
    ? Number(editable.criteria.reduce((sum, item) => sum + (Number.isFinite(item.maxScore) ? item.maxScore : 0), 0).toFixed(2))
    : undefined;
  const totalDiff = criteriaTotal !== undefined ? Number((criteriaTotal - editable.totalScore).toFixed(2)) : 0;

  return <div className="rubric-structured-editor" ref={editorRootRef}>
    <div className="rubric-editor-summary">
      <label>评分制度<input value={modeLabel[editable.mode]} readOnly /></label>
      <label>总分<input value={editable.totalScore} readOnly /></label>
    </div>
    {criteriaTotal !== undefined && <div className={`rubric-total-check ${totalDiff === 0 ? "matched" : "mismatched"}`} role="status">
      <span>当前各评分项最高分合计 <strong>{criteriaTotal}</strong> / {editable.totalScore} 分</span>
      {totalDiff !== 0 && <small>{totalDiff > 0 ? `超出总分 ${totalDiff} 分，请调低分值` : `还差 ${Math.abs(totalDiff)} 分，请补足分值`}</small>}
    </div>}
    {(editable.mode === "additive" || editable.mode === "hybrid") && (
      <CriteriaEditor
        editorRootRef={editorRootRef}
        criteria={editable.criteria}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={updateCriteria}
        onRemove={(index) => removeWithUndo(editable.criteria[index]?.name || `项目 ${index + 1}`, { ...editable, criteria: editable.criteria.filter((_, itemIndex) => itemIndex !== index) } as RubricV2Value)}
        onRemoveLevel={(criterionIndex, levelIndex) => {
          const targetCriterion = editable.criteria[criterionIndex];
          const targetLevel = targetCriterion?.levels?.[levelIndex];
          const nextCriteria = editable.criteria.map((criterion, idx) => {
            if (idx !== criterionIndex) return criterion;
            if (criterion.scoringType === "levels") {
              return { ...criterion, levels: criterion.levels.filter((_, lIdx) => lIdx !== levelIndex) };
            }
            const nextLevels = (criterion.levels ?? []).filter((_, lIdx) => lIdx !== levelIndex);
            return { ...criterion, ...(nextLevels.length > 0 ? { levels: nextLevels } : {}) };
          });
          removeWithUndo(targetLevel?.label || targetLevel?.id || `等级 ${levelIndex + 1}`, { ...editable, criteria: nextCriteria } as RubricV2Value);
        }}
      />
    )}
    {editable.mode === "deductive" && <AdjustmentRulesEditor
      kind="deduction"
      title="扣分规则"
      rules={editable.rules}
      focusTarget={focusTarget}
      focusedKey={focusedKey}
      onChange={(rules) => onChange({ ...editable, rules })}
      onRemove={(index) => removeWithUndo(editable.rules[index]?.name || `规则 ${index + 1}`, { ...editable, rules: editable.rules.filter((_, itemIndex) => itemIndex !== index) })}
    />}
    {editable.mode === "hybrid" && <>
      <AdjustmentRulesEditor
        kind="bonus"
        title="加分规则"
        rules={editable.bonusRules}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={(bonusRules) => onChange({ ...editable, bonusRules })}
        onRemove={(index) => removeWithUndo(editable.bonusRules[index]?.name || `加分规则 ${index + 1}`, { ...editable, bonusRules: editable.bonusRules.filter((_, itemIndex) => itemIndex !== index) })}
      />
      <AdjustmentRulesEditor
        kind="deduction"
        title="扣分规则"
        rules={editable.deductionRules}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={(deductionRules) => onChange({ ...editable, deductionRules })}
        onRemove={(index) => removeWithUndo(editable.deductionRules[index]?.name || `扣分规则 ${index + 1}`, { ...editable, deductionRules: editable.deductionRules.filter((_, itemIndex) => itemIndex !== index) })}
      />
    </>}
    <ScoreCapsEditor
      caps={editable.scoreCaps ?? []}
      totalScore={editable.totalScore}
      focusTarget={focusTarget}
      focusedKey={focusedKey}
      onChange={updateScoreCaps}
      onRemove={(index) => {
        const list = editable.scoreCaps ?? [];
        const nextCaps = list.filter((_, itemIndex) => itemIndex !== index);
        const nextRubric = nextCaps.length > 0 ? { ...editable, scoreCaps: nextCaps } : (() => { const { scoreCaps: _s, ...rest } = editable; return rest; })();
        removeWithUndo(list[index]?.name || `封顶规则 ${index + 1}`, nextRubric as RubricV2Value);
      }}
    />
    {editable.mode !== "additive" && <OverlapGroupsEditor
      groups={editable.overlapGroups}
      focusedKey={focusedKey}
      onChange={(overlapGroups) => onChange({ ...editable, overlapGroups } as RubricV2Value)}
      onRemove={(index) => removeWithUndo(editable.overlapGroups[index]?.id || `重叠组 ${index + 1}`, { ...editable, overlapGroups: editable.overlapGroups.filter((_, itemIndex) => itemIndex !== index) } as RubricV2Value)}
    />}
  </div>;
}

function CriteriaEditor({
  editorRootRef,
  criteria,
  focusTarget,
  focusedKey,
  onChange,
  onRemove,
  onRemoveLevel,
}: {
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  criteria: RubricCriterionV2[];
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (criteria: RubricCriterionV2[]) => void;
  onRemove(index: number): void;
  onRemoveLevel(criterionIndex: number, levelIndex: number): void;
}) {
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    if (criteria.length > 2) {
      for (let i = 1; i < criteria.length; i += 1) initial[i] = true;
    }
    return initial;
  });

  const captureBeforeChange = useScrollAnchorRestore(editorRootRef, [collapsedMap]);

  useEffect(() => {
    if (!focusTarget?.key.startsWith("criterion:")) return;
    const idx = Number.parseInt(focusTarget.key.slice("criterion:".length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < criteria.length) {
      setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
    }
  }, [focusTarget, criteria.length]);

  const allCollapsed = useMemo(
    () => criteria.length > 0 && criteria.every((_, idx) => Boolean(collapsedMap[idx])),
    [criteria, collapsedMap],
  );

  const update = (index: number, value: RubricCriterionV2) =>
    onChange(criteria.map((criterion, itemIndex) => (itemIndex === index ? value : criterion)));

  const moveCriterion = (from: number, to: number) => {
    if (to < 0 || to >= criteria.length) return;
    const next = [...criteria];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
    setCollapsedMap({});
  };

  const toggleAll = () => {
    captureBeforeChange();
    const nextState = !allCollapsed;
    const nextMap: Record<number, boolean> = {};
    for (let i = 0; i < criteria.length; i += 1) nextMap[i] = nextState;
    setCollapsedMap(nextMap);
  };

  const addCriterion = () => {
    const nextIndex = criteria.length;
    onChange([
      ...criteria,
      {
        id: `criterion_${nextIndex + 1}`,
        name: "新评分项目",
        description: "评价核心要点与表达质量。",
        maxScore: 10,
        scoringType: "scored",
        step: 0.5,
        evidenceRequired: true,
      },
    ]);
    setCollapsedMap((prev) => ({ ...prev, [nextIndex]: false }));
  };

  return <section className="rubric-editor-section">
    <div className="rubric-editor-section-heading">
      <h4>评分项目 ({criteria.length})</h4>
      <div className="rubric-section-actions">
        {criteria.length > 1 && (
          <button type="button" className="rubric-ghost-btn" onClick={toggleAll}>
            {allCollapsed ? "全部展开" : "全部收起"}
          </button>
        )}
        <button type="button" onClick={addCriterion}>＋ 添加项目</button>
      </div>
    </div>

    {criteria.map((criterion, index) => {
      const isCollapsed = Boolean(collapsedMap[index]);
      const levelCount = criterion.levels?.length ?? 0;
      const issueHint = checkCriterionInlineIssue(criterion);
      const anchorKey = `criterion:${index}`;
      return <article
        className={`rubric-editor-card ${isCollapsed ? "is-collapsed" : ""} ${focusedKey === anchorKey ? "is-jump-focused" : ""}`}
        data-anchor-key={anchorKey}
        key={`${criterion.id}-${index}`}
      >
        <div className="rubric-editor-card-heading">
          <button
            type="button"
            className="rubric-collapse-trigger"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsedMap((prev) => ({ ...prev, [index]: !isCollapsed }))}
          >
            <span className="rubric-collapse-caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <strong>{criterion.name || `项目 ${index + 1}`}</strong>
            <span className="rubric-card-meta-pill">
              {criterion.maxScore} 分 · {scoringTypeLabel[criterion.scoringType]}
              {criterion.scoringType === "scored" ? ` · 步长 ${criterion.step}` : ""}
              {levelCount > 0 ? ` · ${levelCount} 档` : ""}
            </span>
            {issueHint && <span className="rubric-inline-issue-pill" title={issueHint}>需调整</span>}
          </button>
          <div className="rubric-card-toolbar">
            <button type="button" className="rubric-mini-btn" disabled={index === 0} title="上移项目" onClick={() => moveCriterion(index, index - 1)}>↑</button>
            <button type="button" className="rubric-mini-btn" disabled={index === criteria.length - 1} title="下移项目" onClick={() => moveCriterion(index, index + 1)}>↓</button>
            <button type="button" className="rubric-mini-btn danger" onClick={() => onRemove(index)}>删除</button>
          </div>
        </div>

        {!isCollapsed && <div className="rubric-editor-card-body">
          <div className="rubric-editor-grid">
            <Field className="rubric-field-full" label="名称" value={criterion.name} onChange={(name) => update(index, { ...criterion, name })} />
            <NumberField label="最高分" value={criterion.maxScore} step={criterion.scoringType === "scored" ? String(criterion.step) : "0.01"} onChange={(maxScore) => update(index, { ...criterion, maxScore })} />
            <label>评分方式
              <select
                value={criterion.scoringType}
                onChange={(event) => update(index, switchCriterionScoringType(criterion, event.target.value as ScoringType))}
              >
                <option value="scored">区间打分</option>
                <option value="levels">按档定分</option>
              </select>
            </label>
            {criterion.scoringType === "scored" && (
              <label>分值步长
                <select
                  value={criterion.step}
                  onChange={(event) => update(index, { ...criterion, step: Number(event.target.value) as ScoreStep })}
                >
                  {STEP_OPTIONS.map((step) => (
                    <option key={step} value={step}>{step} 分</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {levelCount > 0 ? (
            <details className="rubric-advanced-field">
              <summary>评分说明与技术标识（已分档，可选展开）</summary>
              <div className="rubric-advanced-stack">
                <label>总体评分说明<textarea rows={2} value={criterion.description} onChange={(event) => update(index, { ...criterion, description: event.target.value })} /></label>
                <Field label="技术标识（自动生成）" value={criterion.id} onChange={(id) => update(index, { ...criterion, id })} />
              </div>
            </details>
          ) : (
            <>
              <label>评分说明<textarea rows={2} value={criterion.description} onChange={(event) => update(index, { ...criterion, description: event.target.value })} /></label>
              <details className="rubric-advanced-field"><summary>高级设置（技术标识：{criterion.id}）</summary><Field label="技术标识（自动生成）" value={criterion.id} onChange={(id) => update(index, { ...criterion, id })} /></details>
            </>
          )}

          <label className="rubric-checkbox"><input type="checkbox" checked={criterion.evidenceRequired} onChange={(event) => update(index, { ...criterion, evidenceRequired: event.target.checked })} />评分时必须提供分析依据</label>

          {issueHint && <div className="rubric-inline-warning" role="status">{issueHint}</div>}

          <div className="rubric-levels">
            <div className="rubric-levels-toolbar">
              <strong>{criterion.scoringType === "levels" ? `固定评分档位 (${levelCount})` : `参考分档 (${levelCount})`}</strong>
              <div className="rubric-section-actions">
                {criterion.scoringType === "levels" && (
                  <button
                    type="button"
                    className="rubric-ghost-btn"
                    title="一键设为“0 分 / 满分”两档（全对才给分）"
                    onClick={() => update(index, { ...criterion, levels: buildBinaryLevelsTemplate(criterion.id, criterion.maxScore) })}
                  >
                    仅 0 / 满分
                  </button>
                )}
                <button
                  type="button"
                  className="rubric-ghost-btn"
                  title="一键生成优/良/中/合格/不合格 5 档模板"
                  onClick={() => update(index, applyFiveTierTemplate(criterion))}
                >
                  套用 5 档模板
                </button>
                <button
                  type="button"
                  onClick={() => update(index, addLevelToCriterion(criterion))}
                >
                  ＋ 添加档位
                </button>
              </div>
            </div>

            {criterion.scoringType === "levels"
              ? criterion.levels.map((level, levelIndex) => {
                  const tone = rubricLevelTone({ id: level.id, minScore: level.score, maxScore: level.score }, criterion.maxScore);
                  return <div className={`rubric-level-editor-card compact ${tone}`} key={levelIndex}>
                    <div className="rubric-level-compact-row">
                      <span className="rubric-level-badge">{level.label ?? rubricLevelLabel(level.id)}</span>
                      <div className="rubric-level-score-inline">
                        <span>分值</span>
                        <input
                          type="number"
                          min="0"
                          max={criterion.maxScore}
                          step="0.01"
                          aria-label="等级分值"
                          value={level.score}
                          onChange={(e) => {
                            const nextLevels = criterion.levels.map((item, lIdx) => lIdx === levelIndex ? { ...item, score: Number(e.target.value) } : item);
                            update(index, { ...criterion, levels: nextLevels });
                          }}
                        />
                        <span>分</span>
                      </div>
                      <button type="button" className="rubric-level-delete" onClick={() => onRemoveLevel(index, levelIndex)}>删除</button>
                    </div>
                    <textarea
                      className="rubric-level-condition-input"
                      rows={2}
                      aria-label="达成条件"
                      placeholder="请填写该档位的可观察达成条件…"
                      value={level.condition}
                      onChange={(event) => {
                        const nextLevels = criterion.levels.map((item, lIdx) => lIdx === levelIndex ? { ...item, condition: event.target.value } : item);
                        update(index, { ...criterion, levels: nextLevels });
                      }}
                    />
                    <details className="rubric-level-tech">
                      <summary>标识：{level.id}</summary>
                      <input
                        aria-label="等级标识"
                        value={level.id}
                        onChange={(event) => {
                          const nextLevels = criterion.levels.map((item, lIdx) => lIdx === levelIndex ? { ...item, id: event.target.value } : item);
                          update(index, { ...criterion, levels: nextLevels });
                        }}
                      />
                    </details>
                  </div>;
                })
              : (criterion.levels ?? []).map((level, levelIndex) => {
                  const tone = rubricLevelTone(level, criterion.maxScore);
                  return <div className={`rubric-level-editor-card compact ${tone}`} key={levelIndex}>
                    <div className="rubric-level-compact-row">
                      <span className="rubric-level-badge">{level.label ?? rubricLevelLabel(level.id)}</span>
                      <div className="rubric-level-score-inline">
                        <input
                          type="number"
                          min="0"
                          max={criterion.maxScore}
                          step={criterion.step}
                          aria-label="最低分"
                          value={level.minScore}
                          onChange={(e) => {
                            const nextLevels = updateScoredLevelBound(criterion.levels ?? [], levelIndex, "minScore", Number(e.target.value), criterion.step, criterion.maxScore);
                            update(index, { ...criterion, levels: nextLevels });
                          }}
                        />
                        <span>–</span>
                        <input
                          type="number"
                          min="0"
                          max={criterion.maxScore}
                          step={criterion.step}
                          aria-label="最高分"
                          value={level.maxScore}
                          onChange={(e) => {
                            const nextLevels = updateScoredLevelBound(criterion.levels ?? [], levelIndex, "maxScore", Number(e.target.value), criterion.step, criterion.maxScore);
                            update(index, { ...criterion, levels: nextLevels });
                          }}
                        />
                        <span>分</span>
                      </div>
                      <button type="button" className="rubric-level-delete" onClick={() => onRemoveLevel(index, levelIndex)}>删除</button>
                    </div>
                    <textarea
                      className="rubric-level-condition-input"
                      rows={2}
                      aria-label="达成条件"
                      placeholder="请填写该分数段的可观察参考标准…"
                      value={level.condition}
                      onChange={(event) => {
                        const nextLevels = (criterion.levels ?? []).map((item, lIdx) => lIdx === levelIndex ? { ...item, condition: event.target.value } : item);
                        update(index, { ...criterion, levels: nextLevels });
                      }}
                    />
                    <details className="rubric-level-tech">
                      <summary>标识：{level.id}</summary>
                      <input
                        aria-label="等级标识"
                        value={level.id}
                        onChange={(event) => {
                          const nextLevels = (criterion.levels ?? []).map((item, lIdx) => lIdx === levelIndex ? { ...item, id: event.target.value } : item);
                          update(index, { ...criterion, levels: nextLevels });
                        }}
                      />
                    </details>
                  </div>;
                })}
          </div>
        </div>}
      </article>;
    })}
  </section>;
}

function AdjustmentRulesEditor({
  kind,
  title,
  rules,
  focusTarget,
  focusedKey,
  onChange,
  onRemove,
}: {
  kind: "deduction" | "bonus";
  title: string;
  rules: AdjustmentRuleV2[];
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (rules: AdjustmentRuleV2[]) => void;
  onRemove(index: number): void;
}) {
  const action = kind === "deduction" ? "扣分" : "加分";
  const prefix = kind === "deduction" ? "deduction:" : "bonus:";
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!focusTarget?.key.startsWith(prefix)) return;
    const idx = Number.parseInt(focusTarget.key.slice(prefix.length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < rules.length) {
      setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
    }
  }, [focusTarget, prefix, rules.length]);

  const update = (index: number, value: AdjustmentRuleV2) =>
    onChange(rules.map((rule, itemIndex) => (itemIndex === index ? value : rule)));

  return <section className="rubric-editor-section">
    <div className="rubric-editor-section-heading">
      <h4>{title} ({rules.length})</h4>
      <button type="button" onClick={() => {
        const idx = rules.length;
        onChange([
          ...rules,
          {
            id: `${kind}_${idx + 1}`,
            name: `新${action}规则`,
            condition: "请填写明确、可观察的触发条件。",
            policy: "fixed",
            amount: 1,
            evidenceRequired: true,
          },
        ]);
        setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
      }}>＋ 添加规则</button>
    </div>
    {rules.map((rule, index) => {
      const isCollapsed = Boolean(collapsedMap[index]);
      const anchorKey = `${prefix}${index}`;
      const pillText = rule.policy === "fixed"
        ? `固定${action} ${rule.amount} 分`
        : rule.policy === "per-occurrence"
          ? `${rule.unitAmount} 分/次 · 最多 ${rule.maxAmount} 分`
          : `最多${action} ${rule.maxAmount} 分 · 步长 ${rule.step}`;
      return <article className={`rubric-editor-card ${isCollapsed ? "is-collapsed" : ""} ${focusedKey === anchorKey ? "is-jump-focused" : ""}`} data-anchor-key={anchorKey} key={index}>
        <div className="rubric-editor-card-heading">
          <button
            type="button"
            className="rubric-collapse-trigger"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsedMap((prev) => ({ ...prev, [index]: !isCollapsed }))}
          >
            <span className="rubric-collapse-caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <strong>{rule.name || `规则 ${index + 1}`}</strong>
            <span className="rubric-card-meta-pill">{pillText}</span>
          </button>
          <div className="rubric-card-toolbar">
            <button type="button" className="rubric-mini-btn danger" onClick={() => onRemove(index)}>删除</button>
          </div>
        </div>
        {!isCollapsed && <div className="rubric-editor-card-body">
          <div className="rubric-editor-grid">
            <Field label="名称" value={rule.name} onChange={(name) => update(index, { ...rule, name })} />
            <label>{action}方式
              <select
                value={rule.policy}
                onChange={(event) => update(index, switchRulePolicy(rule, event.target.value as RulePolicy))}
              >
                <option value="fixed">固定一次{action}</option>
                <option value="per-occurrence">按次累计{action}</option>
                <option value="range">自由区间{action}</option>
              </select>
            </label>
            {rule.policy === "fixed" && (
              <NumberField label={`固定${action}`} value={rule.amount} step="0.01" onChange={(amount) => update(index, { ...rule, amount })} />
            )}
            {rule.policy === "per-occurrence" && <>
              <NumberField label={`每次${action}`} value={rule.unitAmount} step="0.01" onChange={(unitAmount) => update(index, { ...rule, unitAmount })} />
              <NumberField label={`${action}上限`} value={rule.maxAmount} step="0.01" onChange={(maxAmount) => update(index, { ...rule, maxAmount })} />
            </>}
            {rule.policy === "range" && <>
              <NumberField label={`最高${action}`} value={rule.maxAmount} step={String(rule.step)} onChange={(maxAmount) => update(index, { ...rule, maxAmount })} />
              <label>步长
                <select
                  value={rule.step}
                  onChange={(event) => update(index, { ...rule, step: Number(event.target.value) as ScoreStep })}
                >
                  {STEP_OPTIONS.map((step) => (
                    <option key={step} value={step}>{step} 分</option>
                  ))}
                </select>
              </label>
            </>}
          </div>
          <label>触发条件<textarea rows={2} value={rule.condition} onChange={(event) => update(index, { ...rule, condition: event.target.value })} /></label>
          <div className="rubric-rule-options">
            <Field label="重叠组（可选）" value={rule.overlapGroup ?? ""} onChange={(overlapGroup) => update(index, withOverlapGroup(rule, overlapGroup))} />
            <label className="rubric-checkbox"><input type="checkbox" checked={rule.evidenceRequired} onChange={(event) => update(index, { ...rule, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label>
          </div>
          <details className="rubric-advanced-field"><summary>高级设置（技术标识：{rule.id}）</summary><Field label="技术标识（自动生成）" value={rule.id} onChange={(id) => update(index, { ...rule, id })} /></details>
        </div>}
      </article>;
    })}
  </section>;
}

function ScoreCapsEditor({
  caps,
  totalScore,
  focusTarget,
  focusedKey,
  onChange,
  onRemove,
}: {
  caps: NormalizedScoreCap[];
  totalScore: number;
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (caps: NormalizedScoreCap[]) => void;
  onRemove(index: number): void;
}) {
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!focusTarget?.key.startsWith("scoreCap:")) return;
    const idx = Number.parseInt(focusTarget.key.slice("scoreCap:".length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < caps.length) {
      setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
    }
  }, [focusTarget, caps.length]);

  const update = (index: number, value: NormalizedScoreCap) =>
    onChange(caps.map((cap, itemIndex) => (itemIndex === index ? value : cap)));

  return <section className="rubric-editor-section">
    <div className="rubric-editor-section-heading">
      <h4>条件总分封顶 ({caps.length})</h4>
      <button type="button" onClick={() => {
        const idx = caps.length;
        const defaultCap = Math.max(0, Number((totalScore * 0.5).toFixed(2)));
        onChange([
          ...caps,
          {
            id: `score_cap_${idx + 1}`,
            name: "严重缺陷总分封顶",
            condition: "请填写触发总分封顶的严重条件（如字数严重不足或仅有提纲）。",
            maxTotalScore: defaultCap,
            evidenceRequired: true,
          },
        ]);
        setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
      }}>＋ 添加封顶规则</button>
    </div>
    {caps.map((cap, index) => {
      const isCollapsed = Boolean(collapsedMap[index]);
      const anchorKey = `scoreCap:${index}`;
      return <article className={`rubric-editor-card ${isCollapsed ? "is-collapsed" : ""} ${focusedKey === anchorKey ? "is-jump-focused" : ""}`} data-anchor-key={anchorKey} key={index}>
        <div className="rubric-editor-card-heading">
          <button
            type="button"
            className="rubric-collapse-trigger"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsedMap((prev) => ({ ...prev, [index]: !isCollapsed }))}
          >
            <span className="rubric-collapse-caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <strong>{cap.name || `封顶规则 ${index + 1}`}</strong>
            <span className="rubric-card-meta-pill">总分 ≤ {cap.maxTotalScore} 分</span>
          </button>
          <div className="rubric-card-toolbar">
            <button type="button" className="rubric-mini-btn danger" onClick={() => onRemove(index)}>删除</button>
          </div>
        </div>
        {!isCollapsed && <div className="rubric-editor-card-body">
          <div className="rubric-editor-grid">
            <Field label="名称" value={cap.name} onChange={(name) => update(index, { ...cap, name })} />
            <NumberField label="封顶总分" value={cap.maxTotalScore} step="0.01" onChange={(maxTotalScore) => update(index, { ...cap, maxTotalScore })} />
          </div>
          <label>触发条件<textarea rows={2} value={cap.condition} onChange={(event) => update(index, { ...cap, condition: event.target.value })} /></label>
          <label className="rubric-checkbox"><input type="checkbox" checked={cap.evidenceRequired} onChange={(event) => update(index, { ...cap, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label>
          <details className="rubric-advanced-field"><summary>高级设置（技术标识：{cap.id}）</summary><Field label="技术标识（自动生成）" value={cap.id} onChange={(id) => update(index, { ...cap, id })} /></details>
        </div>}
      </article>;
    })}
  </section>;
}

function OverlapGroupsEditor({
  groups,
  focusedKey,
  onChange,
  onRemove,
}: {
  groups: OverlapGroup[];
  focusedKey?: string | undefined;
  onChange: (groups: OverlapGroup[]) => void;
  onRemove(index: number): void;
}) {
  return <section className="rubric-editor-section">
    <div className="rubric-editor-section-heading">
      <h4>重叠规则组</h4>
      <button type="button" onClick={() => onChange([...groups, { id: `group_${groups.length + 1}`, aggregation: "highest-only" }])}>＋ 添加组</button>
    </div>
    {groups.map((group, index) => {
      const anchorKey = `group:${index}`;
      return <div className={`rubric-overlap-row ${focusedKey === anchorKey ? "is-jump-focused" : ""}`} data-anchor-key={anchorKey} key={index}>
        <Field label="组 ID" value={group.id} onChange={(id) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, id } : item))} />
        <label>聚合方式
          <select value={group.aggregation} onChange={(event) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, aggregation: event.target.value as OverlapGroup["aggregation"] } : item))}>
            <option value="highest-only">仅取最高项</option>
            <option value="sum">累计</option>
          </select>
        </label>
        <button type="button" onClick={() => onRemove(index)}>删除</button>
      </div>;
    })}
  </section>;
}

function Field({ label, value, onChange, className }: { label: string; value: string; onChange: (value: string) => void; className?: string }) {
  return <label className={className}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, onChange, step = "0.01" }: { label: string; value: number; onChange: (value: number) => void; step?: string }) {
  return <label>{label}<input type="number" min="0" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function switchCriterionScoringType(criterion: RubricCriterionV2, nextType: ScoringType): RubricCriterionV2 {
  if (criterion.scoringType === nextType) return criterion;
  if (criterion.scoringType === "scored") {
    const existing = (criterion.levels ?? []).map((level) => ({
      id: level.id,
      ...(level.label ? { label: level.label } : {}),
      score: level.maxScore,
      condition: level.condition,
    }));
    return {
      id: criterion.id,
      name: criterion.name,
      description: criterion.description,
      maxScore: criterion.maxScore,
      scoringType: "levels",
      evidenceRequired: criterion.evidenceRequired,
      levels: existing.length > 0 ? existing : buildBinaryLevelsTemplate(criterion.id, criterion.maxScore),
    };
  }
  const step: ScoreStep = validateStepAligned(criterion.maxScore, 0.5) ? 0.5 : 0.01;
  return {
    id: criterion.id,
    name: criterion.name,
    description: criterion.description,
    maxScore: criterion.maxScore,
    scoringType: "scored",
    step,
    evidenceRequired: criterion.evidenceRequired,
    levels: buildFiveTierScoredTemplate(criterion.id, criterion.maxScore, step),
  };
}

function switchRulePolicy(rule: AdjustmentRuleV2, nextPolicy: RulePolicy): AdjustmentRuleV2 {
  if (rule.policy === nextPolicy) return rule;
  const base = {
    id: rule.id,
    name: rule.name,
    condition: rule.condition,
    evidenceRequired: rule.evidenceRequired,
    ...(rule.overlapGroup ? { overlapGroup: rule.overlapGroup } : {}),
  };
  const currentMax = rule.policy === "fixed" ? rule.amount : rule.maxAmount;
  const currentUnit = rule.policy === "fixed" ? rule.amount : rule.policy === "per-occurrence" ? rule.unitAmount : Math.min(1, rule.maxAmount);
  if (nextPolicy === "fixed") return { ...base, policy: "fixed", amount: currentUnit };
  if (nextPolicy === "per-occurrence") return { ...base, policy: "per-occurrence", unitAmount: currentUnit, maxAmount: Math.max(currentUnit, currentMax) };
  const step: ScoreStep = validateStepAligned(currentMax, 0.5) ? 0.5 : 0.01;
  return { ...base, policy: "range", maxAmount: currentMax, step };
}

function buildBinaryLevelsTemplate(criterionId: string, maxScore: number): DiscreteLevel[] {
  const prefix = criterionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "item";
  return [
    { id: `${prefix}_full`, label: "达标", score: maxScore, condition: "完整满足本项目全部要求" },
    { id: `${prefix}_zero`, label: "未达标", score: 0, condition: "未满足本项目要求" },
  ];
}

function applyFiveTierTemplate(criterion: RubricCriterionV2): RubricCriterionV2 {
  if (criterion.scoringType === "levels") {
    const prefix = criterion.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "item";
    const maxUnits = Math.max(100, toUnits(criterion.maxScore));
    const specs = [
      { suffix: "excellent", label: "优秀", ratio: 1, condition: "全面满足全部要求，表现突出" },
      { suffix: "good", label: "良好", ratio: 0.8, condition: "满足主要要求，质量较好" },
      { suffix: "medium", label: "中等", ratio: 0.6, condition: "基本符合要求，部分细节待完善" },
      { suffix: "pass", label: "合格", ratio: 0.4, condition: "勉强达到基本要求" },
      { suffix: "fail", label: "不合格", ratio: 0, condition: "未达基本要求或严重缺失" },
    ];
    return {
      ...criterion,
      levels: specs.map((spec) => ({
        id: `${prefix}_${spec.suffix}`,
        label: spec.label,
        score: Number((Math.round(maxUnits * spec.ratio) / 100).toFixed(2)),
        condition: spec.condition,
      })),
    };
  }
  return {
    ...criterion,
    levels: buildFiveTierScoredTemplate(criterion.id, criterion.maxScore, criterion.step),
  };
}

function buildFiveTierScoredTemplate(criterionId: string, maxScore: number, step: ScoreStep): ScoredLevel[] {
  const prefix = criterionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "item";
  const stepUnits = toUnits(step);
  const maxUnits = Math.max(stepUnits, toUnits(maxScore));
  const snap = (rawUnits: number) => Math.max(0, Math.min(maxUnits, Math.round(rawUnits / stepUnits) * stepUnits));
  const cuts = [0.2, 0.4, 0.6, 0.8].map((r) => snap(maxUnits * r));
  const specs = [
    { suffix: "excellent", label: "优秀", minU: Math.min(maxUnits, cuts[3]! + stepUnits), maxU: maxUnits, condition: "表现优秀，逻辑清晰完整，重点突出" },
    { suffix: "good", label: "良好", minU: Math.min(maxUnits, cuts[2]! + stepUnits), maxU: cuts[3]!, condition: "表现良好，覆盖主要要求，表述较清晰" },
    { suffix: "medium", label: "中等", minU: Math.min(maxUnits, cuts[1]! + stepUnits), maxU: cuts[2]!, condition: "达到中等水平，核心内容基本合理" },
    { suffix: "pass", label: "合格", minU: Math.min(maxUnits, cuts[0]! + stepUnits), maxU: cuts[1]!, condition: "勉强及格，内容较单薄或存在明显疏漏" },
    { suffix: "fail", label: "不合格", minU: 0, maxU: cuts[0]!, condition: "不合格，内容严重缺失或偏离要求" },
  ];
  return specs
    .filter((spec) => spec.minU <= spec.maxU)
    .map((spec) => ({
      id: `${prefix}_${spec.suffix}`,
      label: spec.label,
      minScore: Number((spec.minU / 100).toFixed(2)),
      maxScore: Number((spec.maxU / 100).toFixed(2)),
      condition: spec.condition,
    }));
}

function addLevelToCriterion(criterion: RubricCriterionV2): RubricCriterionV2 {
  const count = criterion.levels?.length ?? 0;
  if (criterion.scoringType === "levels") {
    return {
      ...criterion,
      levels: [
        ...criterion.levels,
        { id: `level_${count + 1}`, score: 0, condition: "请填写该档位的可观察条件。" },
      ],
    };
  }
  return {
    ...criterion,
    levels: [
      ...(criterion.levels ?? []),
      { id: `level_${count + 1}`, minScore: 0, maxScore: criterion.maxScore, condition: "请填写该分数段的可观察条件。" },
    ],
  };
}

function updateScoredLevelBound(
  levels: ScoredLevel[],
  levelIndex: number,
  field: "minScore" | "maxScore",
  nextValue: number,
  step: ScoreStep,
  maxScore: number,
): ScoredLevel[] {
  const stepUnits = toUnits(step);
  const maxUnits = toUnits(maxScore);
  const next = levels.map((item, idx) => (idx === levelIndex ? { ...item, [field]: nextValue } : { ...item }));
  // Auto-cascade adjacent bound by +step when levels are in ascending or descending order
  if (field === "maxScore" && Number.isFinite(nextValue)) {
    const nextMinUnits = Math.min(maxUnits, toUnits(nextValue) + stepUnits);
    const prevItem = next[levelIndex - 1];
    const nextItem = next[levelIndex + 1];
    if (nextItem && toUnits(nextItem.maxScore) > toUnits(nextValue)) {
      next[levelIndex + 1] = { ...nextItem, minScore: Number((nextMinUnits / 100).toFixed(2)) };
    } else if (prevItem && toUnits(prevItem.maxScore) > toUnits(nextValue)) {
      next[levelIndex - 1] = { ...prevItem, minScore: Number((nextMinUnits / 100).toFixed(2)) };
    }
  }
  return next;
}

function checkCriterionInlineIssue(criterion: RubricCriterionV2): string | undefined {
  if (criterion.scoringType === "levels") {
    if (criterion.levels.length === 0) return "按档定分至少需要 1 个档位（可点击“仅 0 / 满分”或“套用 5 档模板”）。";
    const seenIds = new Set<string>();
    const seenScores = new Set<number>();
    for (const level of criterion.levels) {
      if (seenIds.has(level.id)) return `档位标识“${level.id}”重复。`;
      seenIds.add(level.id);
      if (level.score > criterion.maxScore) return `档位“${level.label ?? rubricLevelLabel(level.id)}”的分值超出上限 ${criterion.maxScore}。`;
      const units = toUnits(level.score);
      if (seenScores.has(units)) return `存在相同分值（${level.score} 分）的重复档位。`;
      seenScores.add(units);
    }
    return undefined;
  }

  if (!validateStepAligned(criterion.maxScore, criterion.step)) {
    return `最高分 ${criterion.maxScore} 与步长 ${criterion.step} 不对齐。`;
  }
  const levels = criterion.levels ?? [];
  if (levels.length === 0) return undefined;
  const seenIds = new Set<string>();
  for (const level of levels) {
    if (seenIds.has(level.id)) return `档位标识“${level.id}”重复。`;
    seenIds.add(level.id);
    if (level.minScore > level.maxScore || level.maxScore > criterion.maxScore) {
      return `分档“${level.label ?? rubricLevelLabel(level.id)}”区间 [${level.minScore}, ${level.maxScore}] 超出上限 ${criterion.maxScore}。`;
    }
    if (!validateStepAligned(level.minScore, criterion.step) || !validateStepAligned(level.maxScore, criterion.step)) {
      return `分档“${level.label ?? rubricLevelLabel(level.id)}”边界与步长 ${criterion.step} 不对齐。`;
    }
  }
  const sorted = [...levels].sort((a, b) => a.minScore - b.minScore);
  for (let i = 1; i < sorted.length; i += 1) {
    if (toUnits(sorted[i - 1]!.maxScore) >= toUnits(sorted[i]!.minScore)) {
      return `参考分档存在重叠（${sorted[i - 1]!.maxScore} 与 ${sorted[i]!.minScore}）。`;
    }
  }
  return undefined;
}

function withOverlapGroup<T extends { overlapGroup?: string }>(rule: T, overlapGroup: string): T {
  const trimmed = overlapGroup.trim();
  if (trimmed) return { ...rule, overlapGroup: trimmed };
  const copy = { ...rule };
  delete copy.overlapGroup;
  return copy;
}
