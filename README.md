# Course Agent

教师工作台运行于 Windows，提供课程资料库、带引用的答疑、评分标准设计、单份和批量批改、教师复核及成绩导出。独立学生端运行于 Windows 或 Linux，提供授权课程资料与限额答疑。

## 使用与开发

开发环境为 Windows 11、Node.js 24.x、npm 和 PowerShell。开发启动、模型配置与 Docling 转换器准备见[本地开发指南](.docs/development.md)。发布包通过包内的 `start-course-agent.bat` 启动，启动器负责本地 Web 服务与转换器。

首次打开页面后配置模型，再创建课程。资料导入需要教师确认发布；评分表需要教师确认冻结；批改结果需要教师复核确认。密钥使用 Windows 当前用户 DPAPI 保存在 Workspace 外。

## 文档

- [使用说明书](docs/使用说明书.md)：从新建课程、资料发布、课程答疑、评分量表共创到单份/批量批改与导出完整操作指南。
- [深度真实使用与体验测试报告（2026-11-25）](docs/acceptance/2026-11-25-deep-ux-test-report.md)：真实教师端全流程测试记录与发现的 UI/逻辑问题清单。
- [工程文档入口](.docs/README.md)：架构、存储、开发、测试与运行安全。
- [里程碑与用户验收范围](docs/superpowers/plans/2026-08-02-course-agent-milestones.md)：各阶段状态与验收条件。
- [Windows 发布包前端验收](docs/acceptance/windows-release-frontend-state-sync.md)：页面切换、会话恢复和操作状态检查。
- [历史文档归档](docs/archive/README.md)：早期真实使用回归、试用说明、阶段计划和验证报告。

项目当前仍处于里程碑验收阶段，具体交付范围以验收计划为准。
