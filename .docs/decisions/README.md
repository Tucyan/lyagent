# 架构决策记录

本目录记录影响多个模块、会长期存在且较难撤销的架构决策。小型实现选择、依赖升级和临时方案不创建ADR。

## 索引

| ADR | 状态 | 决策 |
|---|---|---|
|[0001](0001-filesystem-and-sqlite-boundary.md)|Accepted|业务内容使用文件，任务控制状态使用SQLite|
|[0002](0002-rubric-canonical-model.md)|Accepted|评分表以结构化JSON冻结，并支持混合计分制|

## 何时创建或修改

在改变存储边界、身份与权限模型、发布协议、核心依赖方向、部署形态或外部Provider抽象前，先阅读现有ADR。

- 已接受ADR不重写历史理由；决策改变时新增ADR并标记旧ADR被取代。
- 仅修正错别字、失效链接或事实错误时可以直接修改原ADR。
- ADR必须说明背景、决策、影响和重新评估条件，不记录完整实施步骤。

## 模板

```markdown
# ADR-NNNN：决策名称

- 状态：Proposed | Accepted | Superseded
- 日期：YYYY-MM-DD
- 取代：可选ADR编号

## 背景

## 决策

## 影响

## 重新评估条件
```
