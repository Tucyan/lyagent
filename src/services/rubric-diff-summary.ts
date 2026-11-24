import type { Rubric } from "../schemas/rubric.js";

const modeName: Record<Rubric["mode"], string> = {
  additive: "加分制",
  deductive: "减分制",
  hybrid: "混合制",
};

const policyName: Record<"exact-level" | "range" | "continuous", string> = {
  "exact-level": "等级定分",
  range: "区间评分",
  continuous: "连续评分",
};

function sampleNames(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).map((name) => `「${name}」`).join("、");
  return names.length > limit ? `${shown} 等 ${names.length} 项` : shown;
}

/**
 * Generates a deterministic, safe Simplified Chinese summary of a rubric draft update
 * without exposing source excerpts, prompts, or filesystem paths.
 */
export function summarizeRubricDraftUpdate(
  previous: Rubric | undefined,
  next: Rubric,
  version: number,
): string {
  if (!previous) {
    const parts: string[] = [];
    if (next.mode === "additive" || next.mode === "hybrid") {
      const names = next.criteria.map((item) => `${item.name}（${item.maxScore} 分）`);
      parts.push(`包含 ${next.criteria.length} 项评分项目（${sampleNames(names)}）`);
    }
    if (next.mode === "deductive") {
      parts.push(`包含 ${next.rules.length} 条扣分规则`);
    } else if (next.mode === "hybrid") {
      if (next.bonusRules.length > 0) parts.push(`${next.bonusRules.length} 条加分规则`);
      if (next.deductionRules.length > 0) parts.push(`${next.deductionRules.length} 条扣分规则`);
    }
    return `评分表草稿已更新为 v${version}（${modeName[next.mode]}，总分 ${next.totalScore} 分），${parts.join("、")}。可在右侧预览完整量表，或点击“人工编辑”微调细节。`;
  }

  const bullets: string[] = [];

  if (previous.mode !== next.mode) {
    bullets.push(`评分制度由「${modeName[previous.mode]}」调整为「${modeName[next.mode]}」`);
  }
  if (previous.totalScore !== next.totalScore) {
    bullets.push(`总分由 ${previous.totalScore} 分调整为 ${next.totalScore} 分`);
  }

  const prevPartial = previous.mode === "deductive" ? undefined : previous.partialCreditAllowed;
  const nextPartial = next.mode === "deductive" ? undefined : next.partialCreditAllowed;
  if (prevPartial !== undefined && nextPartial !== undefined && prevPartial !== nextPartial) {
    bullets.push(nextPartial ? "已开启允许部分得分" : "已关闭部分得分");
  }

  const prevCriteria = previous.mode === "deductive" ? [] : previous.criteria;
  const nextCriteria = next.mode === "deductive" ? [] : next.criteria;
  if (prevCriteria.length > 0 || nextCriteria.length > 0) {
    const prevById = new Map(prevCriteria.map((item) => [item.id, item]));
    const nextById = new Map(nextCriteria.map((item) => [item.id, item]));

    const added = nextCriteria.filter((item) => !prevById.has(item.id)).map((item) => item.name);
    const removed = prevCriteria.filter((item) => !nextById.has(item.id)).map((item) => item.name);
    if (added.length > 0) bullets.push(`新增评分项目：${sampleNames(added)}`);
    if (removed.length > 0) bullets.push(`移除评分项目：${sampleNames(removed)}`);

    const policyChanges: string[] = [];
    const scoreChanges: string[] = [];
    const detailChanges: string[] = [];

    for (const item of nextCriteria) {
      const before = prevById.get(item.id);
      if (!before) continue;
      if (before.scorePolicy !== item.scorePolicy) {
        policyChanges.push(`${item.name}（${policyName[before.scorePolicy]} → ${policyName[item.scorePolicy]}）`);
      }
      if (before.maxScore !== item.maxScore) {
        scoreChanges.push(`${item.name}（${before.maxScore} → ${item.maxScore} 分）`);
      }
      const levelsChanged = JSON.stringify(before.levels ?? []) !== JSON.stringify(item.levels ?? []);
      const descChanged = before.description !== item.description || before.name !== item.name || before.evidenceRequired !== item.evidenceRequired;
      if (levelsChanged || descChanged) {
        detailChanges.push(item.name);
      }
    }

    if (policyChanges.length > 0) {
      bullets.push(`调整了 ${policyChanges.length} 项评分方式：${sampleNames(policyChanges, 2)}`);
    }
    if (scoreChanges.length > 0) {
      bullets.push(`调整了 ${scoreChanges.length} 项分值上限：${sampleNames(scoreChanges, 2)}`);
    }
    if (detailChanges.length > 0 && policyChanges.length === 0 && scoreChanges.length === 0) {
      bullets.push(`更新了 ${detailChanges.length} 项评分说明或等级条件：${sampleNames(detailChanges, 2)}`);
    } else if (detailChanges.length > 0) {
      bullets.push(`同步更新了 ${detailChanges.length} 项的等级条件与评分说明`);
    }
  }

  const prevDeductions = previous.mode === "deductive" ? previous.rules : previous.mode === "hybrid" ? previous.deductionRules : [];
  const nextDeductions = next.mode === "deductive" ? next.rules : next.mode === "hybrid" ? next.deductionRules : [];
  if (JSON.stringify(prevDeductions) !== JSON.stringify(nextDeductions)) {
    bullets.push(`更新了扣分规则（当前共 ${nextDeductions.length} 条）`);
  }

  const prevBonuses = previous.mode === "hybrid" ? previous.bonusRules : [];
  const nextBonuses = next.mode === "hybrid" ? next.bonusRules : [];
  if (JSON.stringify(prevBonuses) !== JSON.stringify(nextBonuses)) {
    bullets.push(`更新了加分规则（当前共 ${nextBonuses.length} 条）`);
  }

  if (bullets.length === 0) {
    return `已更新为评分表草稿 v${version}，当前结构与分值已通过校验，可在右侧预览核对。`;
  }

  return [
    `已更新为评分表草稿 v${version}，本次主要调整：`,
    ...bullets.map((line) => `- ${line}`),
    "",
    "可在右侧直接预览核对，或继续提出调整要求。",
  ].join("\n");
}
