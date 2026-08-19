# Windows Docling 一键发布包实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付以 Docling 为唯一内置文档转换引擎的 Windows x64 Slim/Full 发布包，解压后双击 BAT 即可完成首次设置、转换作业并运行 M4/M5。

**Architecture:** 将现有 MinerU 专用协议提炼为供应商无关的 `DocumentConversionClient`，保留转换状态机和受控 Workspace 不变，以 Docling Serve 稳定 v1 异步 API 实现上传、轮询与结果读取。Windows 监督进程只拥有 Docling 和应用两个子进程；发布构建固定 Node、Python、Docling 与 Docling Serve，Slim 首次使用下载模型，Full 预置离线 artifacts。

**Tech Stack:** TypeScript ESM、Vitest、Fastify、Node.js 24.11.1、Python 3.12.10、Docling 2.118.0、Docling Serve 1.28.0、PowerShell、Windows BAT。

---

### Task 0：稳定 Windows 测试基线

**Files:**
- Modify: `vitest.config.ts`
- Modify: `tests/model-config-transaction.test.ts`
- Modify: `.docs/testing.md`

- [x] **Step 1: 记录当前失败证据**

  运行 `npm run check`，确认高并发下出现跨模块 5 秒超时和 SQLite `EBUSY`；运行 `npm test -- tests/credential-store.test.ts --run --reporter=verbose`，确认相同测试单独通过。

- [x] **Step 2: 验证单一根因假设**

  运行 `npm test -- --run --maxWorkers=4`，确认失败数量显著下降；锁测试只应断言临界区不重叠，不应断言两个独立 OS helper 的获取顺序。

- [x] **Step 3: 写入最小稳定配置与正确断言**

  在 Vitest 配置中将 Windows 文件 worker 限制为适合 SQLite/PowerShell 集成测试的固定上限；将锁测试改为记录 active 临界区数量并断言最大值为 1，同时断言两个操作均完成。

- [x] **Step 4: 验证并提交**

  运行 `npm run check` 两次，均须 0 failure；更新 `.docs/testing.md` 后提交 `test: stabilize Windows integration concurrency`。

### Task 1：供应商无关转换协议与 Docling 客户端

**Files:**
- Create: `src/services/document-conversion-client.ts`
- Create: `src/services/docling-client.ts`
- Create: `src/services/conversion-result.ts`
- Modify: `src/services/submission-conversion-service.ts`
- Delete: `src/services/mineru-client.ts`
- Create: `tests/docling-client.test.ts`
- Create: `tests/conversion-result.test.ts`
- Modify: `tests/submission-conversion.test.ts`
- Delete: `tests/mineru-client.test.ts`

- [ ] **Step 1: 先写失败测试**

  覆盖严格环回 URL 校验、`/health`、`POST /v1/convert/file/async` multipart 参数、任务状态映射、404 任务丢失、408/429/5xx 可重试、结果大小上限、JSON/ZIP 输出、Markdown 与引用图片规范化、ZIP slip/炸弹/伪造图片拒绝。

- [ ] **Step 2: 验证 RED**

  运行 `npm test -- tests/docling-client.test.ts tests/conversion-result.test.ts tests/submission-conversion.test.ts --run`，预期因 Docling API 尚未实现而失败。

- [ ] **Step 3: 实现最小通用协议**

  定义 `DocumentConversionClient` 的 `health/submit/status/result`，以及与供应商无关的 `ConversionUnavailableError`、`ConversionTaskMissingError`、`ConversionResultError`。Docling 提交请求只上传当前不可变原件，要求 Markdown、referenced images、OCR auto、accurate table mode；所有网络错误对外转换为固定安全错误类型。

- [ ] **Step 4: 复用原状态机**

  `SubmissionConversionService` 只依赖通用协议和通用结果导入器；保持既有重试、恢复、任务丢失重提、不可变原件和安全错误码语义不变。

- [ ] **Step 5: 验证并提交**

  定向测试和 `npm run typecheck` 通过后提交 `feat: replace MinerU protocol with Docling conversion`。

### Task 2：配置、运行状态与 Windows 监督进程切换至 Docling

**Files:**
- Modify: `src/config/app-config.ts`
- Modify: `config.example.json`
- Modify: `src/main.ts`
- Modify: `src/api/server.ts`
- Modify: `src/api/grading-routes.ts`
- Modify: `src/launcher.ts`
- Modify: `src/launcher/runtime.ts`
- Modify: `src/launcher/supervisor.ts`
- Modify: `web/src/pages/DashboardPage.tsx`
- Modify: `web/src/pages/ModelSettingsPage.tsx`
- Modify: `web/src/pages/dashboard-model.ts`
- Modify: `web/src/pages/model-settings-page-model.ts`
- Modify: `tests/app-config.test.ts`
- Modify: `tests/launcher.test.ts`
- Modify: `tests/launcher-entry.test.ts`
- Modify: `tests/runtime-api.test.ts`
- Modify: `tests/grading-api.test.ts`

- [ ] **Step 1: 先写失败测试**

  配置从 `mineru` 迁移为 `converter`，旧 `mineru` 仅作为一次性只读兼容；runtime API 返回 `converter: { provider: "docling", version, status, port, device }`；上传错误和页面不得再声称需要 MinerU；启动命令必须使用内置 `python.exe -m docling_serve run`（不调用会绑定构建机路径的控制台脚本）并通过环境变量绑定 `127.0.0.1`、端口、单 worker、artifacts 路径和 CPU/auto device。

- [ ] **Step 2: 验证 RED**

  运行相关配置、启动器、API和页面模型测试，确认当前 MinerU 命名与命令导致预期失败。

- [ ] **Step 3: 实现配置迁移和运行监督**

  默认开发地址为 `http://127.0.0.1:5001`。监督进程在8000–8009选择 Docling 端口，等待带实例所有权的应用健康检查；Docling 异常退出时回收应用，应用42仅重启应用；退出时只回收经进程开始时间确认的子进程树。发布默认 `DOCLING_DEVICE=auto`，允许 `COURSE_AGENT_DOCLING_DEVICE=cpu` 强制 CPU。

- [ ] **Step 4: 更新界面用语**

  设置页、关于页、运行状态和上传提示统一显示 Docling；不得遗留 MinerU backend、显存门槛或许可证标识。

- [ ] **Step 5: 验证并提交**

  定向测试、`npm run check` 和 `npm run build` 通过后提交 `feat: supervise Docling in Windows runtime`。

### Task 3：可复现 Windows Slim/Full 构建

**Files:**
- Create: `release-lock.json`
- Create: `scripts/build-release.ps1`
- Create: `scripts/verify-release.ps1`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `start-course-agent.bat`
- Create: `tests/release-build.test.ts`

- [ ] **Step 1: 先写失败测试**

  测试 lock schema、版本与 SHA-256 必填、stage 白名单、Workspace/日志/API Key/开发依赖拒绝、manifest/hash生成、BAT中文空格路径、内置 Node ABI 与 `better-sqlite3` 校验、Slim/Full 模式差异。

- [ ] **Step 2: 验证 RED**

  运行 `npm test -- tests/release-build.test.ts --run`，预期因发布构建器尚不存在而失败。

- [ ] **Step 3: 实现发布构建**

  `npm run release:win -- -Mode slim|full|all` 调用 PowerShell：固定下载并校验 Node 24.11.1 x64 ZIP、Python 3.12.10 x64、Docling 2.118.0、Docling Serve 1.28.0；构建 Web/Server，安装生产 Node 依赖和 Python 依赖，拒绝 devDependencies、Workspace、日志和秘密，生成 `release-manifest.json`、`SHA256SUMS.txt`、`THIRD_PARTY_NOTICES.md`。

- [ ] **Step 4: 实现模型模式**

  Slim 不携带 Docling artifacts，首个转换前由 Docling 下载到 `%LOCALAPPDATA%\\CourseAgent\\models\\docling` 并在设置页显示准备状态；Full 在构建期运行 `docling-tools models download --output-dir` 并强制 `DOCLING_SERVE_ARTIFACTS_PATH` 指向包内只读模型目录。

- [ ] **Step 5: 验证并提交**

  发布构建单测、`npm run check`、`npm run build` 通过后提交 `build: add reproducible Docling Windows releases`。

### Task 4：同步长期文档

**Files:**
- Modify: `.docs/architecture.md`
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/development.md`
- Modify: `.docs/testing.md`
- Modify: `.docs/operations-and-security.md`
- Modify: `docs/acceptance/M4-single-grading.md`
- Modify: `docs/superpowers/plans/2026-08-02-course-agent-milestones.md`
- Modify: `plan.md`

- [ ] **Step 1: 清理过时事实**

  全仓搜索 `MinerU|mineru|hybrid-engine|pipeline backend`，除历史计划或迁移说明外不得把 MinerU描述为当前依赖。

- [ ] **Step 2: 写入 Docling 当前事实**

  文档明确通用转换边界、Docling v1 API、Slim/Full 模型策略、环回限制、失败恢复、`.doc` 初版仍拒绝（不内置 LibreOffice）、发布命令和真实验收门槛。

- [ ] **Step 3: 验证并提交**

  检查 Markdown 链接、围栏和示例命令，运行 `git diff --check` 后提交 `docs: document Docling release runtime`。

### Task 4.5：Windows Release 批改流程回归修复（2026-08-10）

- [x] 身份识别固定为“完整手填 → 标准文件名本地解析 → 模型兜底 → 教师补填”，并为超时、无效 JSON、无法识别和字段不完整提供稳定错误码。
- [x] 单份及批量上传支持 Markdown `assets/` 图片，执行路径、魔数、类型、数量、单文件和总量校验；共享目录只复制每份报告实际引用的图片。
- [x] `/grading` 会话切换、评分表切换和修订创建使用页内历史导航。
- [ ] 名称识别准备轮询已接入，但 2026-08-19 实机验收发现“重试名称识别”在模型调用期间仍显示旧的“识别失败”及旧错误，按钮也可重复点击；修复后应立即显示“正在重试/正在识别”、清除旧错误、禁用重复提交，并在成功或安全失败后同步详情与侧栏。
- [x] 新增 SQLite 持久化批次上传草稿和逐项状态，支持刷新/重启恢复、补填身份、替换、移除、单项重试、取消清理及事务性幂等提交。
- [x] 没有 active knowledge release 时仍允许依据冻结评分表与学生作业批改；知识工具返回受控 `ACTIVE_RELEASE_NOT_FOUND`。
- [x] SSE、运行记录和批量 job 使用安全错误分类，不保存供应商原始响应、Prompt、密钥或学生正文。
- [x] 自动化回归覆盖 1/10/120 边界、附件安全、名称同步、草稿恢复、无课程资料批改和安全错误码。
- [x] 批次表格显示当前分数与整体置信度，并提供受限重试和正式确认；新增 `/grading/batches/review` 双栏工作台，支持批次内页内切换、拖拽宽度、教师审计修改和浏览器前进/后退。
- [ ] 用户运行 Slim/Full 构建及 `verify-release.ps1` 后，继续执行中文空格路径、真实浏览器、真实 Docling 与视觉模型验收。

#### 2026-08-19 前端状态同步复审发现（待修复）

- [ ] `POST /api/grading/sessions/:id/title/retry` 当前等待整个名称模型调用结束才返回；`GradingPage` 只在请求返回后刷新，因此服务端已经进入 `resolving` 时前端仍停留在旧的 `failed` 快照。接口应先持久化并返回活动状态，耗时工作异步执行；前端同时维护按会话隔离的操作中状态和安全错误展示。
- [ ] `/grading` 的详情加载和准备轮询没有请求版本或取消写入保护。切换会话后，旧会话的慢响应仍可调用 `setDetail/setMarkdown` 覆盖新会话；列表刷新也存在同类乱序回写风险。
- [ ] `/grading` 准备轮询遇到一次读取失败后只显示错误，不再安排下一次轮询；短暂网络抖动会令 `pending/resolving` 状态永久停在页面上，直至刷新或其他状态变化触发 effect。
- [ ] `refreshDetail` 每次轮询都无条件覆盖本地 `markdown`。教师在名称识别期间编辑 Markdown 时，下一次状态刷新可能清除尚未保存的输入；状态快照与编辑草稿需要分离。
- [ ] `/grading` 的名称/转换重试、开始批改、保存修订、确认和创建修订等异步操作没有统一的按操作 busy 状态与错误收口；请求返回前按钮仍可再次触发，部分 `void` Promise 失败只进入控制台而不会更新页面安全提示。
- [ ] `/grading/batches` 和 `/grading/batches/review` 使用 `setInterval` 发起未串行化的刷新，未对旧响应和请求异常做统一处理。请求耗时超过 800/900 ms 时会重叠，较旧响应可能回写较新的批次/草稿状态，失败 Promise 也不会形成可恢复的页面提示。
- [ ] `/grading/batches/review` 的活动任务轮询只刷新批次，不刷新已选会话详情；任务从 `pending/running` 进入待复核或完成后，右侧仍可能保留“尚无评分结果”或重试前的旧草稿，直到切换会话或刷新整页。
- [ ] `/qa` 的课程选择、新建对话和首次创建会话没有统一写回 URL；同一路径导航、刷新及前进/后退可能恢复到与当前界面不同的课程/会话。课程/会话读取和活动 SSE 也没有请求归属或路由切换取消，旧请求可在切换后覆盖当前消息与资料状态。
- [ ] `/rubrics` 的评分会话加载、草稿事件读取和 SSE 没有请求版本或路由切换取消；切换评分会话后，旧会话的加载结果或流事件仍可覆盖新会话的草稿、消息、版本和提示。
- [ ] `/knowledge` 没有把后续 URL 查询参数变化同步到 `courseId`，同路径页内导航可能继续显示旧课程；课程、版本、草稿和文件读取也没有请求归属保护。快速切换文件时，旧正文可显示在新路径下，后续保存存在把旧文件内容写入当前文件的风险。
- [ ] 通用 `consumeSse` 只把连接 EOF 当作正常返回，不要求收到 `final/error/cancelled` 终态；课程答疑和评分表设计在流被截断时可能清除“进行中”状态并按完成路径刷新，留下空白/半成品消息或错误的完成提示。
- [ ] 为上述行为补组件或页面状态测试：重试中即时反馈与防重复、异步失败显示安全提示、旧会话响应不得覆盖当前会话、暂时失败后继续轮询、编辑草稿不被轮询覆盖、批量轮询不重叠且状态不得倒退。
- [ ] 扩展前端状态测试：批次完成后 Review 自动出现结果；课程/会话/评分表/资料路由切换时取消旧请求；快速切换资料文件不得串页或错存；SSE 未收到终态不得报告成功。

### Task 5：实际构建与端到端验收

**Files:**
- Generated: `release/course-agent-v0.1.0-win-x64-slim.zip`
- Generated: `release/course-agent-v0.1.0-win-x64-full.zip`
- Generated: `release/SHA256SUMS.txt`
- Test fixtures: `tests/fixtures/single-grading/ai-life-report/`

- [ ] **Step 1: 最终静态门槛**

  从干净工作树运行 `npm ci`、`npm run check`、`npm run build`、`git diff --check`，全部必须退出0。

- [ ] **Step 2: 实际构建两个包**

  运行 `npm run release:win -- -Mode all`，随后执行 `scripts/verify-release.ps1` 校验版本、SHA、ABI、许可证、模型模式及敏感内容扫描。

- [ ] **Step 3: 解压运行验收**

  将 Slim 和 Full 分别解压到含中文与空格的新目录；双击 BAT 等价启动，验证3001冲突回退、重复启动单实例、关闭后 Node/Docling 回收、设置保存安全重启、Workspace持久化。

- [ ] **Step 4: 真实转换与浏览器验收**

  使用合成 Markdown、DOCX、PDF和含图报告，经真实 Docling 完成上传、转换、图片清单、单份批改与批量队列；强制 CPU 验证回退；Full 在阻断模型下载网络时仍可转换，Slim 首次下载后第二次不重复下载。通过浏览器验证设置、运行状态、M4/M5 review和CSV导出。

- [ ] **Step 5: 最终审查与提交**

  独立审查完整分支，修复所有 Critical/Important；重新运行完整门槛，提交验收记录和最终改动。
