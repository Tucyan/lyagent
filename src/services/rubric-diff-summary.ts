import type { Rubric } from "../schemas/rubric.js";
import { normalizeRubric } from "../schemas/rubric-engine.js";

const modeName: Record<Rubric["mode"], string> = {
  additive: "加分制",
  deductive: "减分制",
  hybrid: "混合制",
};

const scoringTypeName: Record<"levels" | "scored", string> = {
  levels: "按档定分",
  scored: "区间打分",
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
  const nextNorm = normalizeRubric(next);
  if (!previous) {
    const parts: string[] = [];
    if (nextNorm.mode === "additive" || nextNorm.mode === "hybrid") {
      const names = nextNorm.criteria.map((item) => `${item.name}（${item.maxScore} 分）`);
      parts.push(`包含 ${nextNorm.criteria.length} 项评分项目（${sampleNames(names)}）`);
    }
    if (nextNorm.mode === "deductive") {
      parts.push(`包含 ${nextNorm.deductionRules.length} 条扣分规则`);
    } else if (nextNorm.mode === "hybrid") {
      if (nextNorm.bonusRules.length > 0) parts.push(`${nextNorm.bonusRules.length} 条加分规则`);
      if (nextNorm.deductionRules.length > 0) parts.push(`${nextNorm.deductionRules.length} 条扣分规则`);
    }
    if (nextNorm.scoreCaps.length > 0) {
      parts.push(`${nextNorm.scoreCaps.length} 条总分封顶规则`);
    }
    return `评分表草稿已更新为 v${version}（${modeName[nextNorm.mode]}，总分 ${nextNorm.totalScore} 分），${parts.join("、")}。可在右侧预览完整量表，或点击“人工编辑”微调细节。`;
  }

  const prevNorm = normalizeRubric(previous);
  const bullets: string[] = [];

  if (prevNorm.mode !== nextNorm.mode) {
    bullets.push(`评分制度由「${modeName[prevNorm.mode]}」调整为「${modeName[nextNorm.mode]}」`);
  }
  if (prevNorm.totalScore !== nextNorm.totalScore) {
    bullets.push(`总分由 ${nextNorm.totalScore} 分调整为 ${nextNorm.totalScore} 分`);
  }

  if (
    prevNorm.partialCreditAllowed !== undefined &&
    nextNorm.partialCreditAllowed !== undefined &&
    prevNorm.partialCreditAllowed !== nextNorm.partialCreditAllowed
  ) {
    bullets.push(nextNorm.partialCreditAllowed ? "已开启允许部分得分" : "已关闭部分得分");
  }

  if (prevNorm.criteria.length > 0 || nextNorm.criteria.length > 0) {
    const prevById = new Map(prevNorm.criteria.map((item) => [item.id, item]));
    const nextById = new Map(nextNorm.criteria.map((item) => [item.id, item]));

    const added = nextNorm.criteria.filter((item) => !prevById.has(item.id)).map((item) => item.name);
    const removed = prevNorm.criteria.filter((item) => !nextById.has(item.id)).map((item) => item.name);
    if (added.length > 0) bullets.push(`新增评分项目：${sampleNames(added)}`);
    if (removed.length > 0) bullets.push(`移除评分项目：${sampleNames(removed)}`);

    const policyChanges: string[] = [];
    const scoreChanges: string[] = [];
    const detailChanges: string[] = [];

    for (const item of nextNorm.criteria) {
      const before = prevById.get(item.id);
      if (!before) continue;
      if (before.scoringType !== item.scoringType || (item.scoringType === "scored" && before.step !== item.step)) {
        policyChanges.push(`${item.name}（${scoringTypeName[before.scoringType]} → ${scoringTypeName[item.scoringType]}）`);
      }
      if (before.maxScore !== item.maxScore) {
        scoreChanges.push(`${item.name}（${before.maxScore} → ${item.maxScore} 分）`);
      }
      const levelsChanged = JSON.stringify(before.levels) !== JSON.stringify(item.levels);
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

  if (JSON.stringify(prevNorm.deductionRules) !== JSON.stringify(nextNorm.deductionRules)) {
    bullets.push(`更新了扣分规则（当前共 ${nextNorm.deductionRules.length} 条）`);
  }

  if (JSON.stringify(prevNorm.bonusRules) !== JSON.stringify(nextNorm.bonusRules)) {
    bullets.push(`更新了加分规则（当前共 ${nextNorm.bonusRules.length} 条）`);
  }

  if (JSON.stringify(prevNorm.scoreCaps) !== JSON.stringify(nextNorm.scoreCaps)) {
    bullets.push(`更新了条件总分封顶规则（当前共 ${nextNorm.scoreCaps.length} 条）`);
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
