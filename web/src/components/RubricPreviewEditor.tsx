import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rubricLevelLabel, rubricLevelTone, rubricPreviewSections } from "../pages/rubric-page-model";
import { useToast } from "./ToastProvider";

export type RubricMode = "additive" | "deductive" | "hybrid";
export type ScorePolicy = "exact-level" | "range" | "continuous";

export interface RubricLevel { id: string; minScore: number; maxScore: number; condition: string }
export interface RubricCriterion { id: string; name: string; description: string; maxScore: number; scorePolicy: ScorePolicy; evidenceRequired: boolean; levels?: RubricLevel[] }
export type DeductionAmountPolicy = "fixed" | "per-occurrence" | "range";
export interface DeductionRule { id: string; name: string; condition: string; amountPolicy?: DeductionAmountPolicy; deduction?: number; maxDeduction: number; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string }
export interface BonusRule { id: string; name: string; condition: string; bonus: number; maxBonus: number; occurrence: "once" | "per-occurrence"; evidenceRequired: boolean; overlapGroup?: string }
export interface OverlapGroup { id: string; aggregation: "highest-only" | "sum" }

export type RubricValue =
  | { schemaVersion: "1.0"; mode: "additive"; totalScore: number; partialCreditAllowed: boolean; criteria: RubricCriterion[] }
  | { schemaVersion: "1.0"; mode: "deductive"; totalScore: number; rules: DeductionRule[]; overlapGroups: OverlapGroup[] }
  | { schemaVersion: "1.0"; mode: "hybrid"; totalScore: number; partialCreditAllowed: boolean; criteria: RubricCriterion[]; bonusRules: BonusRule[]; deductionRules: DeductionRule[]; overlapGroups: OverlapGroup[] };

export interface RubricEditFocusTarget {
  key: string;
  nonce: number;
}

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };
const policyLabel: Record<ScorePolicy, string> = { continuous: "连续评分", range: "区间评分", "exact-level": "等级定分" };

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
  // Prefer the first card visible inside or intersecting the top edge of the scroll viewport
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

  const hasPolicyRow = rubric.mode === "additive" || rubric.mode === "hybrid";
  const showInlineExpandAll = !onLevelToggleStateChange && levelRowKeys.length > 0;

  return <article className="rubric-document" ref={rootRef}>
    <header><div><span>{modeLabel[rubric.mode]}</span><h3>评分量表</h3></div><strong>{rubric.totalScore} 分</strong></header>
    {(hasPolicyRow || showInlineExpandAll) && (
      <div className="rubric-document-bar">
        {hasPolicyRow ? (
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
  onChange: (rubric: RubricValue) => void;
  focusTarget?: RubricEditFocusTarget;
}) {
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

  const updateCriteria = (criteria: RubricCriterion[]) => onChange({ ...rubric, criteria } as RubricValue);
  const removeWithUndo = (label: string, nextRubric: RubricValue) => {
    const snapshot = structuredClone(rubric);
    onChange(nextRubric);
    toast.info(`已删除“${label}”`, {
      action: { label: "撤销", onClick: () => onChange(snapshot) },
      durationMs: 6000,
    });
  };
  const criteriaTotal = rubric.mode === "additive" || rubric.mode === "hybrid"
    ? Number(rubric.criteria.reduce((sum, item) => sum + (Number.isFinite(item.maxScore) ? item.maxScore : 0), 0).toFixed(2))
    : undefined;
  const totalDiff = criteriaTotal !== undefined ? Number((criteriaTotal - rubric.totalScore).toFixed(2)) : 0;

  return <div className="rubric-structured-editor" ref={editorRootRef}>
    <div className="rubric-editor-summary">
      <label>评分制度<input value={modeLabel[rubric.mode]} readOnly /></label>
      <label>总分<input value={rubric.totalScore} readOnly /></label>
      {(rubric.mode === "additive" || rubric.mode === "hybrid") && (
        <label className="rubric-checkbox rubric-summary-toggle">
          <input type="checkbox" checked={rubric.partialCreditAllowed} onChange={(event) => onChange({ ...rubric, partialCreditAllowed: event.target.checked })} />
          允许部分得分
        </label>
      )}
    </div>
    {criteriaTotal !== undefined && <div className={`rubric-total-check ${totalDiff === 0 ? "matched" : "mismatched"}`} role="status">
      <span>当前各评分项最高分合计 <strong>{criteriaTotal}</strong> / {rubric.totalScore} 分</span>
      {totalDiff !== 0 && <small>{totalDiff > 0 ? `超出总分 ${totalDiff} 分，请调低分值` : `还差 ${Math.abs(totalDiff)} 分，请补足分值`}</small>}
    </div>}
    {(rubric.mode === "additive" || rubric.mode === "hybrid") && (
      <CriteriaEditor
        editorRootRef={editorRootRef}
        criteria={rubric.criteria}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={updateCriteria}
        onRemove={(index) => removeWithUndo(rubric.criteria[index]?.name || `项目 ${index + 1}`, { ...rubric, criteria: rubric.criteria.filter((_, itemIndex) => itemIndex !== index) } as RubricValue)}
        onRemoveLevel={(criterionIndex, levelIndex) => {
          const targetCriterion = rubric.criteria[criterionIndex];
          const targetLevel = targetCriterion?.levels?.[levelIndex];
          const nextCriteria = rubric.criteria.map((criterion, idx) => idx === criterionIndex
            ? { ...criterion, levels: (criterion.levels ?? []).filter((_, lIdx) => lIdx !== levelIndex) }
            : criterion);
          removeWithUndo(targetLevel?.id || `等级 ${levelIndex + 1}`, { ...rubric, criteria: nextCriteria } as RubricValue);
        }}
      />
    )}
    {rubric.mode === "deductive" && <DeductionRulesEditor
      title="扣分规则"
      rules={rubric.rules}
      focusTarget={focusTarget}
      focusedKey={focusedKey}
      onChange={(rules) => onChange({ ...rubric, rules })}
      onRemove={(index) => removeWithUndo(rubric.rules[index]?.name || `规则 ${index + 1}`, { ...rubric, rules: rubric.rules.filter((_, itemIndex) => itemIndex !== index) })}
    />}
    {rubric.mode === "hybrid" && <>
      <BonusRulesEditor
        rules={rubric.bonusRules}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={(bonusRules) => onChange({ ...rubric, bonusRules })}
        onRemove={(index) => removeWithUndo(rubric.bonusRules[index]?.name || `加分规则 ${index + 1}`, { ...rubric, bonusRules: rubric.bonusRules.filter((_, itemIndex) => itemIndex !== index) })}
      />
      <DeductionRulesEditor
        title="扣分规则"
        rules={rubric.deductionRules}
        focusTarget={focusTarget}
        focusedKey={focusedKey}
        onChange={(deductionRules) => onChange({ ...rubric, deductionRules })}
        onRemove={(index) => removeWithUndo(rubric.deductionRules[index]?.name || `扣分规则 ${index + 1}`, { ...rubric, deductionRules: rubric.deductionRules.filter((_, itemIndex) => itemIndex !== index) })}
      />
    </>}
    {rubric.mode !== "additive" && <OverlapGroupsEditor
      groups={rubric.overlapGroups}
      focusedKey={focusedKey}
      onChange={(overlapGroups) => onChange({ ...rubric, overlapGroups } as RubricValue)}
      onRemove={(index) => removeWithUndo(rubric.overlapGroups[index]?.id || `重叠组 ${index + 1}`, { ...rubric, overlapGroups: rubric.overlapGroups.filter((_, itemIndex) => itemIndex !== index) } as RubricValue)}
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
  criteria: RubricCriterion[];
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (criteria: RubricCriterion[]) => void;
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

  const update = (index: number, value: RubricCriterion) => onChange(criteria.map((criterion, itemIndex) => itemIndex === index ? value : criterion));

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
    onChange([...criteria, { id: `criterion_${nextIndex + 1}`, name: "新评分项目", description: "评价核心要点与表达质量。", maxScore: 1, scorePolicy: "range", evidenceRequired: true }]);
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
            <span className="rubric-card-meta-pill">{criterion.maxScore} 分 · {policyLabel[criterion.scorePolicy]}{levelCount > 0 ? ` · ${levelCount} 档` : ""}</span>
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
            <NumberField label="最高分" value={criterion.maxScore} onChange={(maxScore) => update(index, { ...criterion, maxScore })} />
            <label>评分方式<select value={criterion.scorePolicy} onChange={(event) => update(index, changeCriterionPolicy(criterion, event.target.value as ScorePolicy))}><option value="continuous">连续评分</option><option value="range">区间评分</option><option value="exact-level">等级定分</option></select></label>
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
              <strong>评分等级 ({levelCount})</strong>
              <div className="rubric-section-actions">
                {levelCount > 1 && criterion.scorePolicy !== "exact-level" && (
                  <button
                    type="button"
                    className="rubric-ghost-btn"
                    title="按当前各档位上限自动从 0 分到最高分无缝衔接"
                    onClick={() => update(index, { ...criterion, levels: autoAlignLevelRanges(criterion.levels ?? [], criterion.maxScore) })}
                  >
                    自动衔接区间
                  </button>
                )}
                <button
                  type="button"
                  className="rubric-ghost-btn"
                  title="一键生成优/良/中/合格/不合格 5 档模板"
                  onClick={() => update(index, { ...criterion, levels: buildFiveTierTemplate(criterion.id, criterion.maxScore, criterion.scorePolicy) })}
                >
                  套用 5 档模板
                </button>
                <button
                  type="button"
                  onClick={() => update(index, {
                    ...criterion,
                    levels: [
                      ...(criterion.levels ?? []),
                      {
                        id: `level_${levelCount + 1}`,
                        minScore: criterion.scorePolicy === "exact-level" ? criterion.maxScore : 0,
                        maxScore: criterion.maxScore,
                        condition: "请填写该等级的可观察条件。",
                      },
                    ],
                  })}
                >
                  ＋ 添加等级
                </button>
              </div>
            </div>

            {(criterion.levels ?? []).map((level, levelIndex) => {
              const tone = rubricLevelTone(level, criterion.maxScore);
              const isExact = criterion.scorePolicy === "exact-level";
              return <div className={`rubric-level-editor-card compact ${tone}`} key={levelIndex}>
                <div className="rubric-level-compact-row">
                  <span className="rubric-level-badge">{rubricLevelLabel(level.id)}</span>
                  {isExact ? (
                    <div className="rubric-level-score-inline">
                      <span>分值</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label="等级分值"
                        value={level.minScore}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          updateLevel(criterion, levelIndex, { ...level, minScore: v, maxScore: v }, (next) => update(index, next));
                        }}
                      />
                      <span>分</span>
                    </div>
                  ) : (
                    <div className="rubric-level-score-inline">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label="最低分"
                        value={level.minScore}
                        onChange={(e) => updateLevel(criterion, levelIndex, { ...level, minScore: Number(e.target.value) }, (next) => update(index, next))}
                      />
                      <span>–</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label="最高分"
                        value={level.maxScore}
                        onChange={(e) => updateLevel(criterion, levelIndex, { ...level, maxScore: Number(e.target.value) }, (next) => update(index, next))}
                      />
                      <span>分</span>
                    </div>
                  )}
                  <button type="button" className="rubric-level-delete" onClick={() => onRemoveLevel(index, levelIndex)}>删除</button>
                </div>

                <textarea
                  className="rubric-level-condition-input"
                  rows={2}
                  aria-label="达成条件"
                  placeholder="请填写该等级的可观察达成条件…"
                  value={level.condition}
                  onChange={(event) => updateLevel(criterion, levelIndex, { ...level, condition: event.target.value }, (next) => update(index, next))}
                />

                <details className="rubric-level-tech">
                  <summary>标识：{level.id}</summary>
                  <input
                    aria-label="等级标识"
                    value={level.id}
                    onChange={(event) => updateLevel(criterion, levelIndex, { ...level, id: event.target.value }, (next) => update(index, next))}
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

function DeductionRulesEditor({
  title,
  rules,
  focusTarget,
  focusedKey,
  onChange,
  onRemove,
}: {
  title: string;
  rules: DeductionRule[];
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (rules: DeductionRule[]) => void;
  onRemove(index: number): void;
}) {
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (!focusTarget?.key.startsWith("deduction:")) return;
    const idx = Number.parseInt(focusTarget.key.slice("deduction:".length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < rules.length) {
      setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
    }
  }, [focusTarget, rules.length]);

  const update = (index: number, value: DeductionRule) => onChange(rules.map((rule, itemIndex) => itemIndex === index ? value : rule));
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>{title} ({rules.length})</h4><button type="button" onClick={() => {
    const idx = rules.length;
    onChange([...rules, { id: `deduction_${idx + 1}`, name: "新扣分规则", condition: "请填写触发条件。", amountPolicy: "range", maxDeduction: 1, occurrence: "once", evidenceRequired: true }]);
    setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
  }}>＋ 添加规则</button></div>{rules.map((rule, index) => {
    const policy = deductionAmountPolicy(rule);
    const isCollapsed = Boolean(collapsedMap[index]);
    const anchorKey = `deduction:${index}`;
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
          <span className="rubric-card-meta-pill">最多扣 {rule.maxDeduction} 分</span>
        </button>
        <div className="rubric-card-toolbar">
          <button type="button" className="rubric-mini-btn danger" onClick={() => onRemove(index)}>删除</button>
        </div>
      </div>
      {!isCollapsed && <div className="rubric-editor-card-body">
        <div className="rubric-editor-grid">
          <Field label="名称" value={rule.name} onChange={(name) => update(index, { ...rule, name })} />
          <label>扣分方式<select value={policy} onChange={(event) => update(index, changeDeductionPolicy(rule, event.target.value as DeductionAmountPolicy))}><option value="fixed">固定一次扣分</option><option value="per-occurrence">按次扣分</option><option value="range">自由区间扣分</option></select></label>
          {policy !== "range" && <NumberField label={policy === "fixed" ? "固定扣分" : "每次扣分"} value={rule.deduction ?? 1} onChange={(deduction) => update(index, { ...rule, deduction })} />}
          <NumberField label="扣分上限" value={rule.maxDeduction} step="1" onChange={(maxDeduction) => update(index, { ...rule, maxDeduction })} />
        </div>
        <label>触发条件<textarea rows={2} value={rule.condition} onChange={(event) => update(index, { ...rule, condition: event.target.value })} /></label>
        <DeductionRuleOptions rule={rule} onChange={(next) => update(index, next)} />
        <details className="rubric-advanced-field"><summary>高级设置（技术标识：{rule.id}）</summary><Field label="技术标识（自动生成）" value={rule.id} onChange={(id) => update(index, { ...rule, id })} /></details>
      </div>}
    </article>;
  })}</section>;
}

function BonusRulesEditor({
  rules,
  focusTarget,
  focusedKey,
  onChange,
  onRemove,
}: {
  rules: BonusRule[];
  focusTarget?: RubricEditFocusTarget | undefined;
  focusedKey?: string | undefined;
  onChange: (rules: BonusRule[]) => void;
  onRemove(index: number): void;
}) {
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (!focusTarget?.key.startsWith("bonus:")) return;
    const idx = Number.parseInt(focusTarget.key.slice("bonus:".length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < rules.length) {
      setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
    }
  }, [focusTarget, rules.length]);

  const update = (index: number, value: BonusRule) => onChange(rules.map((rule, itemIndex) => itemIndex === index ? value : rule));
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>加分规则 ({rules.length})</h4><button type="button" onClick={() => {
    const idx = rules.length;
    onChange([...rules, { id: `bonus_${idx + 1}`, name: "新加分规则", condition: "请填写触发条件。", bonus: 1, maxBonus: 1, occurrence: "once", evidenceRequired: true }]);
    setCollapsedMap((prev) => ({ ...prev, [idx]: false }));
  }}>＋ 添加规则</button></div>{rules.map((rule, index) => {
    const isCollapsed = Boolean(collapsedMap[index]);
    const anchorKey = `bonus:${index}`;
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
          <span className="rubric-card-meta-pill">最多加 {rule.maxBonus} 分</span>
        </button>
        <div className="rubric-card-toolbar">
          <button type="button" className="rubric-mini-btn danger" onClick={() => onRemove(index)}>删除</button>
        </div>
      </div>
      {!isCollapsed && <div className="rubric-editor-card-body">
        <div className="rubric-editor-grid">
          <Field label="名称" value={rule.name} onChange={(name) => update(index, { ...rule, name })} />
          <NumberField label="每次加分" value={rule.bonus} onChange={(bonus) => update(index, { ...rule, bonus })} />
          <NumberField label="加分上限" value={rule.maxBonus} onChange={(maxBonus) => update(index, { ...rule, maxBonus })} />
        </div>
        <label>触发条件<textarea rows={2} value={rule.condition} onChange={(event) => update(index, { ...rule, condition: event.target.value })} /></label>
        <RuleOptions rule={rule} onChange={(next) => update(index, next)} />
        <details className="rubric-advanced-field"><summary>高级设置（技术标识：{rule.id}）</summary><Field label="技术标识（自动生成）" value={rule.id} onChange={(id) => update(index, { ...rule, id })} /></details>
      </div>}
    </article>;
  })}</section>;
}

function RuleOptions<T extends DeductionRule | BonusRule>({ rule, onChange }: { rule: T; onChange: (rule: T) => void }) {
  return <div className="rubric-rule-options"><label>计算方式<select value={rule.occurrence} onChange={(event) => onChange({ ...rule, occurrence: event.target.value as T["occurrence"] })}><option value="once">仅一次</option><option value="per-occurrence">按次计算</option></select></label><Field label="重叠组（可选）" value={rule.overlapGroup ?? ""} onChange={(overlapGroup) => onChange(withOverlapGroup(rule, overlapGroup))} /><label className="rubric-checkbox"><input type="checkbox" checked={rule.evidenceRequired} onChange={(event) => onChange({ ...rule, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label></div>;
}

function DeductionRuleOptions({ rule, onChange }: { rule: DeductionRule; onChange: (rule: DeductionRule) => void }) {
  const policy = deductionAmountPolicy(rule);
  return <div className="rubric-rule-options">{policy === "range" ? <label>计算方式<input value="按严重程度在整数区间内扣分" readOnly /></label> : <label>计算方式<input value={policy === "fixed" ? "触发时固定扣一次" : "按出现次数累计"} readOnly /></label>}<Field label="重叠组（可选）" value={rule.overlapGroup ?? ""} onChange={(overlapGroup) => onChange(withOverlapGroup(rule, overlapGroup))} /><label className="rubric-checkbox"><input type="checkbox" checked={rule.evidenceRequired} onChange={(event) => onChange({ ...rule, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label></div>;
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
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>重叠规则组</h4><button type="button" onClick={() => onChange([...groups, { id: `group_${groups.length + 1}`, aggregation: "highest-only" }])}>＋ 添加组</button></div>{groups.map((group, index) => {
    const anchorKey = `group:${index}`;
    return <div className={`rubric-overlap-row ${focusedKey === anchorKey ? "is-jump-focused" : ""}`} data-anchor-key={anchorKey} key={index}><Field label="组 ID" value={group.id} onChange={(id) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, id } : item))} /><label>聚合方式<select value={group.aggregation} onChange={(event) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, aggregation: event.target.value as OverlapGroup["aggregation"] } : item))}><option value="highest-only">仅取最高项</option><option value="sum">累计</option></select></label><button type="button" onClick={() => onRemove(index)}>删除</button></div>;
  })}</section>;
}

function Field({ label, value, onChange, className }: { label: string; value: string; onChange: (value: string) => void; className?: string }) {
  return <label className={className}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, onChange, step = "0.01" }: { label: string; value: number; onChange: (value: number) => void; step?: string }) {
  return <label>{label}<input type="number" min="0" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function deductionAmountPolicy(rule: DeductionRule): DeductionAmountPolicy {
  return rule.amountPolicy ?? (rule.occurrence === "per-occurrence" ? "per-occurrence" : "fixed");
}

function changeDeductionPolicy(rule: DeductionRule, amountPolicy: DeductionAmountPolicy): DeductionRule {
  if (amountPolicy === "range") {
    const { deduction: _deduction, ...rest } = rule;
    return { ...rest, amountPolicy, occurrence: "once" };
  }
  const deduction = rule.deduction ?? Math.min(1, rule.maxDeduction);
  return { ...rule, amountPolicy, deduction, occurrence: amountPolicy === "fixed" ? "once" : "per-occurrence" };
}

function changeCriterionPolicy(criterion: RubricCriterion, scorePolicy: ScorePolicy): RubricCriterion {
  if (scorePolicy === "exact-level") {
    const levels = (criterion.levels ?? []).map((lvl) => ({ ...lvl, minScore: lvl.maxScore }));
    return { ...criterion, scorePolicy, ...(criterion.levels ? { levels } : {}) };
  }
  return { ...criterion, scorePolicy };
}

function checkCriterionInlineIssue(criterion: RubricCriterion): string | undefined {
  const levels = criterion.levels ?? [];
  if (criterion.scorePolicy !== "continuous" && levels.length === 0) {
    return "当前评分方式必须至少包含 1 个评分等级（可点击右侧“套用 5 档模板”快速生成）。";
  }
  if (levels.length === 0) return undefined;
  const seenIds = new Set<string>();
  for (const level of levels) {
    if (seenIds.has(level.id)) return `等级标识“${level.id}”重复，请在标识处修改为唯一值。`;
    seenIds.add(level.id);
    if (level.minScore > level.maxScore || level.maxScore > criterion.maxScore) {
      return `等级“${rubricLevelLabel(level.id)}”的分值区间 [${level.minScore}, ${level.maxScore}] 超出当前项目上限 ${criterion.maxScore}。`;
    }
    if (criterion.scorePolicy === "exact-level" && level.minScore !== level.maxScore) {
      return `等级定分模式下，“${rubricLevelLabel(level.id)}”需设为单一分值。`;
    }
  }
  if (criterion.scorePolicy === "exact-level") return undefined;

  const sorted = [...levels].sort((a, b) => a.minScore - b.minScore);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  if (Math.round(first.minScore * 100) !== 0 || Math.round(last.maxScore * 100) !== Math.round(criterion.maxScore * 100)) {
    return `等级区间需从 0 分覆盖至最高分 ${criterion.maxScore} 分（可点击“自动衔接区间”一键修复）。`;
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.round(sorted[i - 1]!.maxScore * 100) + 1 !== Math.round(sorted[i]!.minScore * 100)) {
      return `等级区间存在空档或重叠（${sorted[i - 1]!.maxScore} 与 ${sorted[i]!.minScore}），可点击“自动衔接区间”一键修复。`;
    }
  }
  return undefined;
}

function autoAlignLevelRanges(levels: RubricLevel[], maxScore: number): RubricLevel[] {
  if (levels.length === 0) return levels;
  const maxUnits = Math.max(100, Math.round(maxScore * 100));
  const sorted = [...levels].sort((a, b) => a.minScore - b.minScore);
  const aligned: RubricLevel[] = [];
  let cursorUnits = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i]!;
    const isLast = i === sorted.length - 1;
    let upperUnits = isLast ? maxUnits : Math.round(item.maxScore * 100);
    if (!isLast) {
      upperUnits = Math.max(cursorUnits, Math.min(maxUnits - (sorted.length - 1 - i), upperUnits));
    }
    aligned.push({
      ...item,
      minScore: Number((cursorUnits / 100).toFixed(2)),
      maxScore: Number((upperUnits / 100).toFixed(2)),
    });
    cursorUnits = Math.min(maxUnits, upperUnits + 1);
  }
  return aligned;
}

function buildFiveTierTemplate(criterionId: string, maxScore: number, policy: ScorePolicy): RubricLevel[] {
  const prefix = criterionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "item";
  const maxUnits = Math.max(100, Math.round(maxScore * 100));
  if (policy === "exact-level") {
    const ratios = [1, 0.8, 0.6, 0.4, 0];
    const defs = [
      { suffix: "excellent", condition: "全面满足全部要求，表现突出" },
      { suffix: "good", condition: "满足主要要求，质量较好" },
      { suffix: "medium", condition: "基本符合要求，部分细节待完善" },
      { suffix: "pass", condition: "勉强达到基本要求" },
      { suffix: "fail", condition: "未达基本要求或严重缺失" },
    ];
    return defs.map((d, i) => {
      const score = Number(((Math.round(maxUnits * ratios[i]!)) / 100).toFixed(2));
      return { id: `${prefix}_${d.suffix}`, minScore: score, maxScore: score, condition: d.condition };
    });
  }

  const cuts = [0.2, 0.4, 0.6, 0.8];
  const bounds = cuts.map((r) => Math.round(maxUnits * r));
  const specs = [
    { suffix: "excellent", minU: Math.min(maxUnits, bounds[3]! + 1), maxU: maxUnits, condition: "表现优秀，逻辑清晰完整，重点突出" },
    { suffix: "good", minU: Math.min(maxUnits, bounds[2]! + 1), maxU: bounds[3]!, condition: "表现良好，覆盖主要要求，表述较清晰" },
    { suffix: "medium", minU: Math.min(maxUnits, bounds[1]! + 1), maxU: bounds[2]!, condition: "达到中等水平，核心内容基本合理" },
    { suffix: "pass", minU: Math.min(maxUnits, bounds[0]! + 1), maxU: bounds[1]!, condition: "勉强及格，内容较单薄或存在明显疏漏" },
    { suffix: "fail", minU: 0, maxU: bounds[0]!, condition: "不合格，内容严重缺失或偏离要求" },
  ];
  return specs.map((s) => ({
    id: `${prefix}_${s.suffix}`,
    minScore: Number((Math.min(s.minU, s.maxU) / 100).toFixed(2)),
    maxScore: Number((s.maxU / 100).toFixed(2)),
    condition: s.condition,
  }));
}

function withOverlapGroup<T extends { overlapGroup?: string }>(rule: T, overlapGroup: string): T {
  const trimmed = overlapGroup.trim();
  if (trimmed) return { ...rule, overlapGroup: trimmed };
  const copy = { ...rule };
  delete copy.overlapGroup;
  return copy;
}

function updateLevel(criterion: RubricCriterion, levelIndex: number, level: RubricLevel, apply: (criterion: RubricCriterion) => void): void {
  const levels = (criterion.levels ?? []).map((item, idx) => idx === levelIndex ? level : item);
  apply({ ...criterion, levels });
}
