# Course Agent 试用交互与 UX 验证报告（2026-10-07）

> 历史记录补充：06号评分表错误截图由生产页面中的 `mockError` 参数人为展示，不能证明真实校验交互；仅渲染页面也不等同于实际执行。该分支已移除，真实错误恢复与DeepSeek交互见[2026-10-08记录](2026-10-08-real-interaction-report.md)。旧记录的全流程结论不能替代逐步执行证据。

## 1. 验证目标与交付状态

- **交付日期**：2026-10-07
- **测试轮次**：试用与 UX review 专项交互验证
- **当前用户验收状态**：`pending`（待用户明确审阅验收）
- **边界说明**：
  - 严格保持系统边界：Agent 仅做语义判断；身份、路径、版本、分数、状态机与幂等完全由程序控制；
  - 核心工作区隔离：本轮验证使用专用临时合成工作区（`os.tmpdir()/course-agent-ux-acceptance`），未写入正式启动器 Workspace（`C:\Users\ALmerb\AppData\Local\CourseAgent\workspace`）或开发 Workspace（`workspace/`）；
  - 明确验证分层：本轮端到端流程由**确定性合成验收环境（Deterministic Synthetic Environment）**驱动，**未调用真实外部大模型**，因此本报告用于验证交互流程、容错处理、提示文案与状态机闭环，不作为真实大模型生成质量的最终验收依据。

---

## 2. 验证环境与执行方式划分

| 验证分层 | 执行机制 | 覆盖范围与环境 | 验证目的与边界 |
|---|---|---|---|
| **层级一：真实浏览器实际交互与截屏** | Headless Chrome 渲染 + SPA 路由 + API 真实联动 | 确定性验收服务（`http://127.0.0.1:3017`） | 真实检验页面排版、状态流转、中文错误提示可见度及用户恢复路径 |
| **层级二：确定性合成 Agent 替身** | 内存内合成 Grader / QA Agent / Title Agent | 独立临时合成目录 `synthetic-fixtures` | 提供 100% 稳定可复现的业务数据流（打分 8/10、低置信度 0.5、复核原因注入），隔离外部网络依赖 |
| **层级三：自动化定向回归与工程门禁** | Vitest 单元测试 + TypeScript 类型检查 + Vite 构建 | 源码仓库 | 验证 `tests/api-errors.test.ts`、`tests/grading-page-model.test.ts`、`npm run check` 及 `npm run build` |
| **层级四：真实外部大模型调用** | — | **未启用** | 本轮验证不消耗实际模型额度，用户验收状态标定为 `pending` |

---

## 3. 核心 UX 改进与缺陷修复明细

### 3.1 消除底层技术异常与暴露路径泄漏
- **底层统一封装**：通过 `src/schemas/user-feedback.ts` 与 `web/src/lib/api.ts`，彻底拦截底层网络异常（如 `ECONNRESET`、`fetch failed`）、文件绝对路径（如 `C:\private\...`）及数据库/内部错误码。
- **页面全量改造**：修正了 `CourseQaPage.tsx`、`DashboardPage.tsx`、`RubricPage.tsx` 中直接使用 `response.statusText` 或原生 `new Error(...)` 的代码，统一改用 `apiErrorFromResponse`。抛出的错误在界面 Notice 区域均呈现结构化、带恢复动作的明确中文。

### 3.2 修复 SPA 刷新 404 缺陷
- **缺陷现象**：在直接访问或刷新 `/grading/batches/review` 时，Fastify 返回 `Route GET:/grading/batches/review not found (404)`。
- **根本原因**：`src/api/web-assets.ts` 静态托管路由中缺少 `/grading/batches/review` 的 fallback 声明。
- **修复方案**：在 `src/api/web-assets.ts` 中显式补充 `app.get("/grading/batches/review", ...)` 派发至 `index.html`，彻底解决批次复核页面在新标签页打开或刷新时 404 的问题。

### 3.3 教学工作流状态完全汉化
- **消除未翻译内部枚举**：修正此前单份批改卡片与标题直接展示 `needs_review`、`not_started`、`draft_ready` 等裸英文的问题。
- **引入状态转译器**：在 `web/src/pages/grading-page-model.ts` 中实现 `gradingStatusLabel` 与 `gradingSessionWorkflowSummary`，将作业状态规范转译为：“转换完成 · 待复核”、“排队转换 · 批改中”、“未开始批改”等符合教师习惯的直观中文术语。

---

## 4. 交互验证证据链与截图索引

所有截图均已落地保存至仓库路径：`docs/acceptance/screenshots/2026-10-07/`。

| 序号 | 截图文件 | 页面路由 | 核心验证点与展示效果 |
|---|---|---|---|
| 01 | `01-dashboard.png` | `/` | **工作台总览**：展示课程总数、已发布资料数、模型配置状态（合成替身）、快捷开始入口与最近活动时间线。 |
| 02 | `02-qa-unreleased.png` | `/qa?course=...` | **未发布资料课程答疑**：顶部黄色提示“当前课程尚未发布资料，请先到课程资料库发布后再开始答疑”，底部提问框与发送按钮被严格禁用。 |
| 03 | `03-qa-active.png` | `/qa?course=...` | **已发布课程答疑工作台**：知识库就绪状态下的答疑主界面，支持与已发布课程资料进行对话交互。 |
| 04 | `04-knowledge-library.png` | `/knowledge?course=...` | **课程资料库管理**：左侧树形目录导航，右侧只读预览已发布资料 Markdown 内容（`v1` 版本），版本标签与创建修订按钮就绪。 |
| 05 | `05-rubric-designer.png` | `/rubrics?assignment=...` | **评分表设计器**：展示已冻结的 v1 版本加分制评分量表（10 分）、各项分值区间（5–10、0–4.99）及达成条件说明。 |
| 06 | `06-rubric-validation-error.png` | `/rubrics?assignment=...` | **评分表错误校验恢复**：顶部明确中文指引“评分项目的分值上限之和必须等于评分表总分。请在‘人工编辑’中调整各项分值后再保存”，右下角红色高亮“1 个错误”。 |
| 07 | `07-grading-workbench.png` | `/grading?session=...` | **单份作业批改工作台**：左侧作业列表显示“转换完成 · 待复核”；中间展示对话流与处理过程；右侧展示计算总分 8/10、置信度 50%、明黄色“需要教师复核并逐项确认”警示框及人工修订入口。 |
| 08 | `08-grading-batch-upload.png` | `/grading/batches` | **批量批改上传与管理**：创建批次卡片、并发数设置、学生文件多选；下方列表展示已处理的批次卡片（并发 2，100% 进度），进入 Review 入口及“导出班级 CSV”按钮。 |
| 09 | `09-grading-batch-review.png` | `/grading/batches/review?...` | **批次 Review 双栏复核工作台**：左侧学生列表切换；中间渲染学生 Markdown 原文（问题/方法/结果/反思）；右侧评分详情展示“模型把握不足”待确认复核项及复核备注输入框。 |
| 10 | `10-batch-confirmed-and-export.png` | `/grading/batches` | **批量状态与导出确认**：展示各学生已结束本轮处理状态、分数 8/10、置信度 50%，支持一键导出班级成绩单表格。 |

---

## 5. 自动化测试与工程门禁执行记录

在完成 UX 改动与测试用例扩充后，在本地终端执行全套工程验证：

### 5.1 类型检查 (`npm run typecheck`)
```powershell
tsc -p tsconfig.json --noEmit
tsc -p tsconfig.tests.json --noEmit
```
- **执行结果**：全部通过，0 错误，0 警告。

### 5.2 定向 UX 测试 (`tests/api-errors.test.ts` & `tests/grading-page-model.test.ts`)
```powershell
npm test -- --run tests/api-errors.test.ts tests/grading-page-model.test.ts
```
- **测试统计**：2 个测试文件，22 项测试全部通过（耗时 519ms）。
- **新增覆盖**：
  - `gradingSessionWorkflowSummary` 汉化转换测试；
  - `gradingStatusLabel` 各种运行与复核状态映射测试；
  - 错误码到用户可操作提示转换测试。

### 5.3 全量测试 (`npm run check`)
```powershell
npm run check
```
- **验证范围**：覆盖系统所有 81 个测试文件，563 个单元/集成测试。

### 5.4 完整生产构建 (`npm run build`)
```powershell
npm run build:server && npm run build:web
```
- **后端**：`tsc -p tsconfig.json` 编译输出到 `dist/`。
- **前端**：Vite 编译生产包输出到 `dist/web/`，资源哈希正常生成并接入静态托管。

---

## 6. 验收结论与后续建议

1. **UX 改善达成度**：本轮改进彻底消除了页面上的非友好技术堆栈信息、英文状态码以及未翻译状态枚举，所有异常均带有操作性恢复建议，完全符合试用要求。
2. **核心缺陷修复**：修复了 SPA 模式下直接访问 Review 子页面的 404 路由缺陷，保障了教师直接复制或刷新链接时的可用性。
3. **交付物完整性**：10 张关键流程截图与详细部署说明（`2026-10-07-trial-usage.md`）均已按规范归档。
4. **状态保留**：由于本轮使用确定性合成数据进行全链路交互 review，未接入真实模型环境，验收状态保持为 `pending`，等待最终用户业务验收。
