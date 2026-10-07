# 项目文档入口

`.docs`保存长期有效、与当前代码同步的工程知识，目标是让新开发者能快速理解边界并安全修改系统。

## 阅读顺序

首次进入项目建议依次阅读：

1. 根目录[README.md](../README.md)（使用入口）；
2. `AGENTS.md`；
3. 本文；
4. `architecture.md`；
5. `domain-and-storage.md`；
6. `development.md`；
7. 与任务相关的测试、运行或安全文档。

## 文档索引

- [architecture.md](architecture.md)：当前架构、目标边界和依赖规则。
- [domain-and-storage.md](domain-and-storage.md)：领域对象、状态机、Workspace和SQLite职责。
- [development.md](development.md)：本地开发、配置、代码组织和常见问题。
- [testing.md](testing.md)：测试分层、fixture和验收门槛。
- [operations-and-security.md](operations-and-security.md)：运行、日志、恢复、密钥和数据安全。
- [decisions/README.md](decisions/README.md)：长期架构决策索引。

## 文档边界

| 位置 | 记录内容 |
|---|---|
|`.docs/`|已经采用的工程约束和当前系统事实|
|`plan.md`|产品范围、目标设计和里程碑|
|`docs/superpowers/plans/`|阶段性的可执行实施步骤|
|代码与测试|精确接口、Schema和可运行行为的最终事实来源|
|Git历史|变更过程；不在`.docs`维护流水账|

当文档与代码冲突时，先通过测试确认真实行为，再在同一变更中修正文档或代码。不要让“计划中的设计”伪装成“已经实现”。

## 维护规则

- 每份文档只承担一种职责，优先链接，不复制大段内容。
- 只记录能指导开发决策的信息；删除过期描述，不追加更正日志。
- 命令必须可复制执行；路径和类型名必须与仓库一致。
- 架构图保持小而稳定，细节由代码和测试表达。
- 只有影响多个模块、长期存在且难以撤销的选择才创建ADR。
- 功能变更合并前，作者负责更新相关文档；纯重构若不改变行为，不需要制造文档改动。
