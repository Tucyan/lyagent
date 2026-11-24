# Antigravity 工作交接记录（2026-10-07）

## 目标

本轮工作目标是对项目进行实际试用和 UX review，重点检查交互流程、错误提示和用户恢复路径。交付物包括：

- 面向试用用户的明确中文提示，避免暴露底层异常、内部路径、错误码和警告文本；
- 从 Release 解压开始的详细使用说明；
- 带截图的实际交互验证报告；
- 源码、测试和构建验证结果。

本记录用于将未完成工作交给 Antigravity，不能代替最终验收报告。

## Git 状态

- 当前分支：`main`
- 当前 HEAD：`a0d8bf0 fix: integrate bounded agent runs and recoverable Windows workflows`
- `origin/main`：`4b03cdd`
- `main` 比 `origin/main` 超前 1 个提交；本轮 UX 修改尚未提交，也尚未推送。
- 已合入的分支历史包括 `codex/fix-confirmed-windows-issues`、`master`、`codex/m3-rubric-designer` 和 `codex/windows-release-bundle`。
- 用户没有明确要求推送前，不要推送。需要推送时使用已登录 `Tucyan` 账户的 GitHub CLI。

当前未提交文件由本轮 UX 工作产生，禁止丢弃：

```text
scripts/run-batch-grading-acceptance-server.ts
scripts/run-ux-acceptance-server.ts
src/schemas/user-feedback.ts
tests/api-errors.test.ts
tests/grading-page-model.test.ts
web/src/lib/api.ts
web/src/pages/CourseQaPage.tsx
web/src/pages/DashboardPage.tsx
web/src/pages/GradingBatchPage.tsx
web/src/pages/GradingBatchReviewPage.tsx
web/src/pages/GradingPage.tsx
web/src/pages/KnowledgeLibraryPage.tsx
web/src/pages/ModelSettingsPage.tsx
web/src/pages/RubricPage.tsx
web/src/pages/grading-page-model.ts
docs/superpowers/plans/2026-10-07-trial-experience.md
docs/acceptance/screenshots/2026-10-07/
```

## 已完成

### 代码与回归

- 增加 `src/schemas/user-feedback.ts`，将错误码、字段路径、评分表问题、低置信度和证据不足转换为中文且可操作的提示。
- 更新 `web/src/lib/api.ts`：用户可见文本不再包含错误码、内部字段路径、`sessionIds`、绝对路径、密钥片段、`ECONNRESET` 或非 JSON 响应原文；`ApiError.code` 和 `issuePaths` 仍保留给程序内部使用。
- 已接入课程答疑、Dashboard、评分表、单份批改、批量批改、批量 Review、课程资料库、模型设置和批改单页状态模型。
- 取消竞态已有回归测试，覆盖取消后迟到工具写入的所有权保护。
- UX 定向测试已通过：`tests/api-errors.test.ts`、`tests/grading-page-model.test.ts`，共 21 项。

### 已验证命令

UX 改动前的基线：

```text
npm run check       通过：81 个测试文件，563 个测试，2 个真实模型测试跳过
npm run build       通过
```

UX 定向测试最近一次通过：

```text
npm test -- --run tests/api-errors.test.ts tests/grading-page-model.test.ts
21 tests passed
```

注意：最近一次构建有 Vite 前端 bundle 超过 500 kB 的提示。本轮范围是试用交互和提示，不要把这个性能建议扩大成新的任务。

### Release 与存储基线

旧 Release 位于：

```text
.worktrees/windows-release-bundle/release/
```

full 包：`course-agent-v0.1.0-win-x64-full.zip`

- SHA-256：`863f6e7010baf41ea0e5fdf9a5845ae20c7446550a490003be32d46d24429348`
- 已使用 `C:\Program Files\WinRAR\WinRAR.exe` 解压，耗时 202.49 秒，退出码 0。
- 99,488 个校验清单文件存在，8 个关键文件 SHA-256 匹配。
- 完整解压目录：`C:\Users\ALmerb\AppData\Local\Temp\course-agent-winrar-full-20261007-194931`
- 旧 slim 包的 SHA-256 与校验文件不一致，不得作为可靠发布物。
- 详细基线：[2026-10-07-storage-release-baseline.md](2026-10-07-storage-release-baseline.md)

不要再次解压这个已验证的 full 包，也不要把旧 Release 当作当前源码产物。WinRAR 规则和超时交接规则已写入根目录 `AGENTS.md`。

当前有两套 Workspace，不能混用：

```text
开发 Workspace：workspace/
正式启动器 Workspace：C:\Users\ALmerb\AppData\Local\CourseAgent\workspace
```

开发 Workspace 有 6 个批改会话，包含转换失败、等待转换器和命名失败状态；SQLite `quick_check` 通过，但当前源码读取其 active release 时返回 `Knowledge release integrity validation failed`，需要继续定位。正式启动器 Workspace 有 7 个批改会话、1 个已完成批次，active release 和 8 篇正文均通过校验，SQLite `quick_check` 通过。后续验证不得写入真实 Workspace。

## 实际试用进度

确定性合成验收服务脚本：`scripts/run-ux-acceptance-server.ts`

服务地址：`http://127.0.0.1:3017`

合成数据目录：`C:\Users\ALmerb\AppData\Local\Temp\course-agent-ux-acceptance`

服务数据包含：

- `试用示例课程`：已有 active release；
- `尚未发布资料的课程`：没有 active release；
- 冻结评分表；
- 两个合成学生报告。

已实际验证：

1. Dashboard 显示两门课程；
2. 已发布课程显示 active release；
3. 未发布资料课程显示“当前课程尚未发布资料，请先到课程资料库发布后再开始答疑”，输入框和发送按钮禁用；
4. 课程答疑课程切换正常。

现有截图：

```text
docs/acceptance/screenshots/2026-10-07/01-dashboard.png
```

尚未完成的浏览器截图和报告内容：未发布资料答疑页、课程资料库、评分表创建与错误校验、单份批改、批量上传、Review、正式确认和导出。

## Antigravity 接续顺序

1. 先检查 `http://127.0.0.1:3017` 是否仍在运行；结束时只停止本验收服务，不能按名称杀掉所有 Node 进程。
2. 阅读 `.docs/README.md` 以及本记录；检查根目录 `AGENTS.md` 的 WinRAR、长命令和数据边界规则。
3. 搜索并修复剩余直接展示原始错误的代码：

   ```powershell
   rg -n "error\.message|errorMessage|lastErrorCode|event\.message|\{reason\}|\{problem\.message\}|response\.statusText" web/src
   ```

   重点确认 `GradingBatchPage.tsx` 上传项错误、`GradingPage.tsx` 作业名称/转换/会话操作错误、`GradingBatchReviewPage.tsx` 复核原因和 `RubricPage.tsx` 评分表问题均使用中文恢复提示。

4. 完成确定性服务上的剩余浏览器交互，并把截图保存到 `docs/acceptance/screenshots/2026-10-07/`。
5. 新增详细使用说明：`docs/acceptance/2026-10-07-trial-usage.md`。内容从校验 ZIP SHA-256、WinRAR 解压到全新目录开始，覆盖启动 BAT、转换器就绪、打开本地页面、模型设置、创建课程、导入并发布资料、评分表、上传作业、Review、正式确认和导出。
6. 新增实际交互报告：`docs/acceptance/2026-10-07-trial-report.md`。明确区分已实际操作、自动化测试、确定性合成 Agent 和真实模型；真实模型未使用，用户验收状态为 `pending`。
7. 重新执行并记录：

   ```powershell
   npm run typecheck
   npm test -- --run tests/api-errors.test.ts tests/grading-page-model.test.ts
   npm run check
   npm run build
   ```

8. 确认文档、截图和代码后提交：

   ```powershell
   git add src web tests scripts docs
   git commit -m "fix: improve trial error guidance"
   ```

## 重要边界

- 不修改真实学生正文、密钥或正式启动器 Workspace 数据。
- 不把超时或失败的解压目录当成发布验收环境。
- 长时间命令、下载或权限命令最多尝试 3 次；超时后交给用户。
- 当前里程碑未经用户明确验收，不开始新的产品里程碑。
- 修改行为时先补失败测试；交付前必须通过 `npm run check` 和 `npm run build`。

## 当前交付状态

状态：`in_progress`

已具备：UX 错误提示改造、确定性验收服务、Release/存储基线、初始截图和本交接记录。

待完成：剩余页面错误文案复核、完整截图、详细使用说明、实际交互报告、最终测试和提交。

