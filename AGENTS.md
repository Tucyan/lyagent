# AGENTS.md

本文件适用于整个仓库。开始工作前先阅读`.docs/README.md`，再按任务类型选择下列文档；不要把本文件扩展成架构说明书。

## 文档索引与使用时机

| 文档 | 什么时候查看 | 什么时候修改 |
|---|---|---|
|`.docs/architecture.md`|跨层调用、新Agent/Tool/Service、发布流程|组件职责、依赖方向或系统边界改变时|
|`.docs/domain-and-storage.md`|领域对象、状态机、Workspace或SQLite变更|对象含义、目录结构、Schema或一致性规则改变时|
|`.docs/development.md`|首次上手、环境配置、添加模块、排查本地问题|命令、依赖、配置或开发流程改变时|
|`.docs/testing.md`|写功能、修Bug、准备交付|测试分层、fixture或验收门槛改变时|
|`.docs/operations-and-security.md`|文件访问、密钥、日志、恢复、企业微信|安全边界、运行方式、恢复或数据保留策略改变时|
|`.docs/decisions/`|准备改变长期架构选择时|出现影响多个模块且难以撤销的新决策时新增ADR|
|`plan.md`|确认产品范围和目标架构时|产品范围、里程碑或验收目标改变时|
|`docs/superpowers/plans/`|执行具体阶段任务时|创建或更新该阶段的可执行计划时|
|`docs/superpowers/plans/2026-08-02-course-agent-milestones.md`|开始、交付或验收任何里程碑时|里程碑范围或用户验收规则改变时|

## 必须保持的边界

- Agent只做语义判断；身份、路径、版本、分数、状态和幂等由程序控制。
- 文件访问必须经过受控Workspace/Service，不能向Agent暴露任意本地路径。
- 答疑只能读取当前active knowledge release，不能读取staging。
- JSON结果是批改事实来源；`summary.csv`必须可重建。
- 密钥、完整学生正文和敏感会话不得进入仓库或普通日志。
- 当前里程碑未经用户明确验收，不得开始下一里程碑的产品功能。

## 修改、维护与验证

- 先写或更新失败测试，再实现最小变更；保持TypeScript ESM的`.js`导入约定。
- 修改行为时，在同一变更中更新受影响文档；文档只描述当前事实，未来工作写入`plan.md`或阶段计划。
- 避免在多份文档复制Schema、命令或规则；指定一个事实来源，其余位置只链接。
- 提交前运行`npm run check`和`npm run build`。若只改文档，仍需检查Markdown链接、代码围栏和示例格式。
