# Course Agent

面向 Windows 的本地课程辅助软件，提供课程资料库、带引用的课程答疑、评分表设计、作业批改、教师复核与成绩导出。

## 使用与开发

开发环境为 Windows 11、Node.js 24.x、npm 和 PowerShell。开发启动、模型配置与 Docling 转换器准备见[本地开发指南](.docs/development.md)。发布包通过包内的 `start-course-agent.bat` 启动，启动器负责本地 Web 服务与转换器。

首次打开页面后配置模型，再创建课程。资料导入需要教师确认发布；评分表需要教师确认冻结；批改结果需要教师复核确认。密钥使用 Windows 当前用户 DPAPI 保存在 Workspace 外。

## 文档

- [从解压开始的逐步图文使用说明](docs/acceptance/2026-10-08-step-by-step-usage.md)：真实 DeepSeek 示例操作、复核与导出。
- [真实交互验证报告](docs/acceptance/2026-10-08-real-interaction-report.md)：截图证据、源码修复和未验证范围。
- [工程文档入口](.docs/README.md)：架构、存储、开发、测试与运行安全。
- [里程碑与用户验收范围](docs/superpowers/plans/2026-08-02-course-agent-milestones.md)：各阶段状态与验收条件。
- [Windows 发布包前端验收](docs/acceptance/windows-release-frontend-state-sync.md)：页面切换、会话恢复和操作状态检查。

项目当前仍处于里程碑验收阶段，具体交付范围以验收计划为准。
