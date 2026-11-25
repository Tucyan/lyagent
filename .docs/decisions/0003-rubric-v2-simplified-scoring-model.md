# ADR-0003：评分表 2.0 精简计分模型与只读兼容策略

- 状态：Accepted
- 日期：2026-11-25
- 补充：[ADR-0002](0002-rubric-canonical-model.md)

## 背景

`schemaVersion: "1.0"` 在迭代中累积了多组交叉概念与冗余字段：全局 `partialCreditAllowed` 与单项 `scorePolicy` 冲突；`range` 强迫按 `0.01` 分无缝拼接导致反直觉的 `0–1.99` 区间与高出错率；扣分规则同时维护 `amountPolicy` 与 `occurrence` 且与奖励规则不对称；`range` 扣分硬编码只允许整数；条件总分封顶依赖 Prompt 口算；`selectedLevelId` 强校验在教师复核跨档改分时容易阻断保存。

## 决策

1. **精简 `schemaVersion: "2.0"` 结构**：
   - 主体评分项移除顶层全局 `partialCreditAllowed`，收口为两种策略：`levels`（按档定分，离散分值，含 0/满分二档场景）与 `scored`（区间/连续打分，显式声明步长 `step: 1 | 0.5 | 0.1 | 0.01`，默认 `0.5`，参考分档不重叠即可，按 `step` 判定衔接）。
   - 扣分规则与奖励规则统一为单一判别字段 `policy` 的 `AdjustmentRule`：`fixed`（`amount`）、`per-occurrence`（`unitAmount` + `maxAmount`）、`range`（`minAmount?` + `maxAmount` + `step`），删除冗余的 `occurrence` 字段并解除区间扣分的整数硬限制。
   - 新增可选一等规则 `scoreCaps`（`{ id, name, condition, maxTotalScore, evidenceRequired }`），条件总分封顶由程序直接执行 `Math.min(earned, maxTotalScore)`。
2. **前后端共享零依赖规则引擎**：抽离 [rubric-engine.ts](../../src/schemas/rubric-engine.ts)，统一处理 `1.0`/`2.0` 归一化、程序算分、步长校验与 `selectedLevelId` 自动推导，供后端批改校验与前端编辑器共用。
3. **历史冻结版本只读兼容**：既有 `1.0` 冻结 `rubric-vN.json` 保持不可变、不改写磁盘与 SHA-256 哈希；基于 `1.0` 冻结版本创建修订时通过 `upgradeRubricV1ToV2` 在新草稿中无损升级为 `2.0`。

## 影响

- `src/schemas/rubric-v1.ts` 只读冻结保留 `1.0` Schema；`src/schemas/rubric.ts` 维护 `2.0` Schema、校验与升级函数。
- 批改复核时程序根据 `score` 自动同步 `selectedLevelId`，`DecisionEditor` 直接按冻结规则渲染定档选择、步长输入、固定/按次步进器与实时总分预览。
- Agent Tool Schema 与 Prompt 大幅精简，不再要求模型计算 `0.01` 拼接或口算封顶差额。

## 重新评估条件

若未来需要引入非线性权重公式、跨题目依赖计分或自定义脚本评分时，再评估是否需要新的 Schema 主版本。
