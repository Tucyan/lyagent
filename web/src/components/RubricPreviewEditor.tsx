import { rubricPreviewSections } from "../pages/rubric-page-model";

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

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };

export function RubricDocument({ rubric }: { rubric: RubricValue }) {
  const sections = rubricPreviewSections(rubric);
  return <article className="rubric-document">
    <header><div><span>{modeLabel[rubric.mode]}</span><h3>评分量表</h3></div><strong>{rubric.totalScore} 分</strong></header>
    {(rubric.mode === "additive" || rubric.mode === "hybrid") && <p className="rubric-document-policy">{rubric.partialCreditAllowed ? "允许部分得分" : "不允许部分得分"}</p>}
    {sections.map((section) => <section className="rubric-document-section" key={section.title}>
      <h4>{section.title}</h4>
      <div className="rubric-scorecard">{section.rows.map((row, index) => <article key={`${section.title}-${index}`}>
        <div><strong>{row.title}</strong><span>{row.score}</span></div>
        <p>{row.description}</p>
        <small>{row.detail}</small>
        {row.levels && <div className="rubric-preview-levels">{row.levels.map((level) => <div key={level.id}><strong>{level.id}</strong><span>{level.score}</span><p>{level.condition}</p></div>)}</div>}
      </article>)}</div>
    </section>)}
  </article>;
}

export function RubricEditor({ rubric, onChange }: { rubric: RubricValue; onChange: (rubric: RubricValue) => void }) {
  const updateCriteria = (criteria: RubricCriterion[]) => onChange({ ...rubric, criteria } as RubricValue);
  return <div className="rubric-structured-editor">
    <div className="rubric-editor-summary"><label>评分制度<input value={modeLabel[rubric.mode]} readOnly /></label><label>总分<input value={rubric.totalScore} readOnly /></label></div>
    {(rubric.mode === "additive" || rubric.mode === "hybrid") && <>
      <label className="rubric-checkbox"><input type="checkbox" checked={rubric.partialCreditAllowed} onChange={(event) => onChange({ ...rubric, partialCreditAllowed: event.target.checked })} />允许部分得分</label>
      <CriteriaEditor criteria={rubric.criteria} onChange={updateCriteria} />
    </>}
    {rubric.mode === "deductive" && <DeductionRulesEditor title="扣分规则" rules={rubric.rules} onChange={(rules) => onChange({ ...rubric, rules })} />}
    {rubric.mode === "hybrid" && <>
      <BonusRulesEditor rules={rubric.bonusRules} onChange={(bonusRules) => onChange({ ...rubric, bonusRules })} />
      <DeductionRulesEditor title="扣分规则" rules={rubric.deductionRules} onChange={(deductionRules) => onChange({ ...rubric, deductionRules })} />
    </>}
    {rubric.mode !== "additive" && <OverlapGroupsEditor groups={rubric.overlapGroups} onChange={(overlapGroups) => onChange({ ...rubric, overlapGroups } as RubricValue)} />}
  </div>;
}

function CriteriaEditor({ criteria, onChange }: { criteria: RubricCriterion[]; onChange: (criteria: RubricCriterion[]) => void }) {
  const update = (index: number, value: RubricCriterion) => onChange(criteria.map((criterion, itemIndex) => itemIndex === index ? value : criterion));
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>评分项目</h4><button type="button" onClick={() => onChange([...criteria, { id: `criterion_${criteria.length + 1}`, name: "新评分项目", description: "请填写可观察的评分说明。", maxScore: 1, scorePolicy: "continuous", evidenceRequired: true }])}>＋ 添加项目</button></div>
    {criteria.map((criterion, index) => <article className="rubric-editor-card" key={`${criterion.id}-${index}`}>
      <div className="rubric-editor-card-heading"><strong>项目 {index + 1}</strong><button type="button" onClick={() => onChange(criteria.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>
      <div className="rubric-editor-grid"><Field label="ID" value={criterion.id} onChange={(id) => update(index, { ...criterion, id })} /><Field label="名称" value={criterion.name} onChange={(name) => update(index, { ...criterion, name })} /><NumberField label="最高分" value={criterion.maxScore} onChange={(maxScore) => update(index, { ...criterion, maxScore })} /><label>评分方式<select value={criterion.scorePolicy} onChange={(event) => update(index, { ...criterion, scorePolicy: event.target.value as ScorePolicy })}><option value="continuous">连续评分</option><option value="range">区间评分</option><option value="exact-level">等级定分</option></select></label></div>
      <label>评分说明<textarea value={criterion.description} onChange={(event) => update(index, { ...criterion, description: event.target.value })} /></label>
      <label className="rubric-checkbox"><input type="checkbox" checked={criterion.evidenceRequired} onChange={(event) => update(index, { ...criterion, evidenceRequired: event.target.checked })} />评分时必须提供分析依据</label>
      {(criterion.levels?.length ?? 0) > 0 && <div className="rubric-levels"><strong>评分等级</strong>{criterion.levels!.map((level, levelIndex) => <div className="rubric-level-row" key={`${level.id}-${levelIndex}`}><Field label="等级" value={level.id} onChange={(id) => updateLevel(criterion, levelIndex, { ...level, id }, (next) => update(index, next))} /><NumberField label="最低分" value={level.minScore} onChange={(minScore) => updateLevel(criterion, levelIndex, { ...level, minScore }, (next) => update(index, next))} /><NumberField label="最高分" value={level.maxScore} onChange={(maxScore) => updateLevel(criterion, levelIndex, { ...level, maxScore }, (next) => update(index, next))} /><Field label="达成条件" value={level.condition} onChange={(condition) => updateLevel(criterion, levelIndex, { ...level, condition }, (next) => update(index, next))} /><button type="button" onClick={() => update(index, { ...criterion, levels: criterion.levels!.filter((_, itemIndex) => itemIndex !== levelIndex) })}>删除等级</button></div>)}</div>}
      {criterion.scorePolicy !== "continuous" && <button type="button" onClick={() => update(index, { ...criterion, levels: [...(criterion.levels ?? []), { id: `level_${(criterion.levels?.length ?? 0) + 1}`, minScore: 0, maxScore: criterion.maxScore, condition: "请填写该等级的可观察条件。" }] })}>＋ 添加评分等级</button>}
    </article>)}
  </section>;
}

function DeductionRulesEditor({ title, rules, onChange }: { title: string; rules: DeductionRule[]; onChange: (rules: DeductionRule[]) => void }) {
  const update = (index: number, value: DeductionRule) => onChange(rules.map((rule, itemIndex) => itemIndex === index ? value : rule));
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>{title}</h4><button type="button" onClick={() => onChange([...rules, { id: `deduction_${rules.length + 1}`, name: "新扣分规则", condition: "请填写触发条件。", amountPolicy: "range", maxDeduction: 1, occurrence: "once", evidenceRequired: true }])}>＋ 添加规则</button></div>{rules.map((rule, index) => {
    const policy = deductionAmountPolicy(rule);
    return <article className="rubric-editor-card" key={`${rule.id}-${index}`}><div className="rubric-editor-card-heading"><strong>规则 {index + 1}</strong><button type="button" onClick={() => onChange(rules.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div><div className="rubric-editor-grid"><Field label="ID" value={rule.id} onChange={(id) => update(index, { ...rule, id })} /><Field label="名称" value={rule.name} onChange={(name) => update(index, { ...rule, name })} /><label>扣分方式<select value={policy} onChange={(event) => update(index, changeDeductionPolicy(rule, event.target.value as DeductionAmountPolicy))}><option value="fixed">固定一次扣分</option><option value="per-occurrence">按次扣分</option><option value="range">自由区间扣分</option></select></label>{policy !== "range" && <NumberField label={policy === "fixed" ? "固定扣分" : "每次扣分"} value={rule.deduction ?? 1} onChange={(deduction) => update(index, { ...rule, deduction })} />}<NumberField label="扣分上限" value={rule.maxDeduction} step="1" onChange={(maxDeduction) => update(index, { ...rule, maxDeduction })} /></div><label>触发条件<textarea value={rule.condition} onChange={(event) => update(index, { ...rule, condition: event.target.value })} /></label><DeductionRuleOptions rule={rule} onChange={(next) => update(index, next)} /></article>;
  })}</section>;
}

function BonusRulesEditor({ rules, onChange }: { rules: BonusRule[]; onChange: (rules: BonusRule[]) => void }) {
  const update = (index: number, value: BonusRule) => onChange(rules.map((rule, itemIndex) => itemIndex === index ? value : rule));
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>加分规则</h4><button type="button" onClick={() => onChange([...rules, { id: `bonus_${rules.length + 1}`, name: "新加分规则", condition: "请填写触发条件。", bonus: 1, maxBonus: 1, occurrence: "once", evidenceRequired: true }])}>＋ 添加规则</button></div>{rules.map((rule, index) => <article className="rubric-editor-card" key={`${rule.id}-${index}`}><div className="rubric-editor-card-heading"><strong>规则 {index + 1}</strong><button type="button" onClick={() => onChange(rules.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div><div className="rubric-editor-grid"><Field label="ID" value={rule.id} onChange={(id) => update(index, { ...rule, id })} /><Field label="名称" value={rule.name} onChange={(name) => update(index, { ...rule, name })} /><NumberField label="每次加分" value={rule.bonus} onChange={(bonus) => update(index, { ...rule, bonus })} /><NumberField label="加分上限" value={rule.maxBonus} onChange={(maxBonus) => update(index, { ...rule, maxBonus })} /></div><label>触发条件<textarea value={rule.condition} onChange={(event) => update(index, { ...rule, condition: event.target.value })} /></label><RuleOptions rule={rule} onChange={(next) => update(index, next)} /></article>)}</section>;
}

function RuleOptions<T extends DeductionRule | BonusRule>({ rule, onChange }: { rule: T; onChange: (rule: T) => void }) {
  return <div className="rubric-rule-options"><label>计算方式<select value={rule.occurrence} onChange={(event) => onChange({ ...rule, occurrence: event.target.value as T["occurrence"] })}><option value="once">仅一次</option><option value="per-occurrence">按次计算</option></select></label><Field label="重叠组（可选）" value={rule.overlapGroup ?? ""} onChange={(overlapGroup) => onChange(withOverlapGroup(rule, overlapGroup))} /><label className="rubric-checkbox"><input type="checkbox" checked={rule.evidenceRequired} onChange={(event) => onChange({ ...rule, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label></div>;
}

function DeductionRuleOptions({ rule, onChange }: { rule: DeductionRule; onChange: (rule: DeductionRule) => void }) {
  const policy = deductionAmountPolicy(rule);
  return <div className="rubric-rule-options">{policy === "range" ? <label>计算方式<input value="按严重程度在整数区间内扣分" readOnly /></label> : <label>计算方式<input value={policy === "fixed" ? "触发时固定扣一次" : "按出现次数累计"} readOnly /></label>}<Field label="重叠组（可选）" value={rule.overlapGroup ?? ""} onChange={(overlapGroup) => onChange(withOverlapGroup(rule, overlapGroup))} /><label className="rubric-checkbox"><input type="checkbox" checked={rule.evidenceRequired} onChange={(event) => onChange({ ...rule, evidenceRequired: event.target.checked })} />必须提供评分分析依据</label></div>;
}

function OverlapGroupsEditor({ groups, onChange }: { groups: OverlapGroup[]; onChange: (groups: OverlapGroup[]) => void }) {
  return <section className="rubric-editor-section"><div className="rubric-editor-section-heading"><h4>重叠规则组</h4><button type="button" onClick={() => onChange([...groups, { id: `group_${groups.length + 1}`, aggregation: "highest-only" }])}>＋ 添加组</button></div>{groups.map((group, index) => <div className="rubric-overlap-row" key={`${group.id}-${index}`}><Field label="组 ID" value={group.id} onChange={(id) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, id } : item))} /><label>聚合方式<select value={group.aggregation} onChange={(event) => onChange(groups.map((item, itemIndex) => itemIndex === index ? { ...item, aggregation: event.target.value as OverlapGroup["aggregation"] } : item))}><option value="highest-only">仅取最高项</option><option value="sum">累计</option></select></label><button type="button" onClick={() => onChange(groups.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>)}</section>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
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

function updateLevel(criterion: RubricCriterion, index: number, value: RubricLevel, onChange: (criterion: RubricCriterion) => void): void {
  onChange({ ...criterion, levels: (criterion.levels ?? []).map((level, levelIndex) => levelIndex === index ? value : level) });
}

function withOverlapGroup<T extends DeductionRule | BonusRule>(rule: T, overlapGroup: string): T {
  if (overlapGroup.trim()) return { ...rule, overlapGroup };
  const { overlapGroup: _removed, ...rest } = rule;
  return rest as T;
}
