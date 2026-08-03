# M2 Web Course QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本地 Web 端交付基于当前 active knowledge release 的课程答疑；课程资料优先，必要时可检索公开网页，并为每个回答提供可验证的课程或网络引用。

**Architecture:** `KnowledgeService`只解析`active.json`指向的不可变 release。Pi/DeepSeek 课程答疑 Agent 通过受控只读工具读取课程资料；联网时通过`web_search`检索 DDGS、再通过`read_web_result`读取本会话搜索结果。程序验证引用后才返回给 Web。会话仅保存在本地 Workspace 的 Web 会话目录，按课程隔离并设置消息上限。

**Tech Stack:** TypeScript ESM、Fastify、Pi SDK、DeepSeek、Zod、React/Vite、Vitest。

**Status:** `ready_for_user_test`（2026-08-02；DDGS 网络搜索已实现并完成自动化回归，等待用户验收）。

---

## Locked behavior

- 仅访问当前课程的`active.json`指向的 release；staging、历史 release、其他课程、配置和文件绝对路径不可见。
- 不使用 RAG、Embedding、向量数据库或图片语义识别；网络搜索默认 Provider 为无需密钥的 DDGS，用户可在答疑输入区关闭联网搜索。
- 搜索为确定性的大小写不敏感词法匹配，覆盖路径、标题和正文；默认最多 10 条结果。
- Agent 必须先通过只读工具获得证据，再调用`submit_answer`提交`answer`和引用数组。课程引用为`{type:"knowledge",path,startLine,endLine}`；网络引用先以`{type:"web",sourceId,startLine,endLine}`提交，服务端只接受本会话已搜索、已读取的`sourceId`并补全标题和 URL。
- 无足够资料时，Agent 通过同一工具提交“资料不足”结论和空引用；程序不允许伪造引用。
- 默认模型继续为`deepseek-v4-flash`，密钥只从`workspace/config/app.json`读取；没有 key 时 API 返回`503 MODEL_NOT_CONFIGURED`，不降级为编造答案。
- 答疑使用独立的`/qa`页面；布局借鉴聊天产品的空间结构，不复制 ChatGPT 名称、图标、配色、文案或功能。
- 一次提问使用`POST`请求上的 Server-Sent Events（SSE）流式返回：前端逐段显示已生成的回答，最终事件才提交经验证的完整答案和引用。
- 流中仅展示安全的运行状态和工具调用摘要，绝不传输或渲染模型思维链、Prompt、完整工具参数、原文内容、绝对路径或密钥。
- `web_search`只返回标题、URL、摘要和本会话结果 ID；`read_web_result`不接受任意 URL。网页只作为不可信参考资料，网页中的指令不能改变 Agent 行为。

## Scope change: DDGS web search

**Files:** Create `scripts/ddgs_search.py`, `src/services/ddgs-process-runner.ts`, `src/services/ddgs-search-service.ts`, `src/services/safe-web-fetcher.ts`, `src/services/web-evidence-service.ts`; modify course QA Agent/API/UI/configuration and tests.

- [x] 使用 Python `ddgs`包作为默认搜索后端；Node 通过标准输入输出传递 JSON，查询不拼接到 shell 命令。
- [x] DDGS 默认返回 5 条、最多 10 条，单进程搜索串行，内部超时 10 秒、外层超时 30 秒。
- [x] 网络读取仅允许已搜索的本会话结果 ID；HTTPS、私网地址、危险重定向、非文本类型和超大响应被拒绝。
- [x] 增加网络引用结构、服务端已读校验、SSE 工具活动和 Web 开关；网络来源在新标签打开。
- [x] 增加 DDGS 归一化、进程协议、会话证据、SSRF/重定向、Agent 与 API 的定向测试。

## Task 1: Active-release read model

**Files:** Create `src/services/knowledge-service.ts`, `src/schemas/knowledge.ts`, `tests/knowledge-search.test.ts`.

- [ ] 写失败测试：没有 active release 时返回明确领域错误；课程 A 的服务无法读取课程 B；staging 文件不在任何读取结果中。
- [ ] 写失败测试：目录列表只返回逻辑相对路径和标题；搜索结果包含路径、标题、行号和片段；读取范围被限制在请求文件的真实行数内。
- [ ] 实现`KnowledgeService`：解析`active.json`和`index/tree.json`，建立按行读取的 Markdown 文档清单，实现`listDirectory(path)`、`search(query,offset,maxResults)`和`readLines(path,startLine,endLine)`。
- [ ] 对路径、分页、空查询和行号使用 Zod 校验；所有文件读取复用 SafeFilesystem，结果不包含绝对路径。
- [ ] 运行`npm test -- --run tests/knowledge-search.test.ts`，预期全部通过。

## Task 2: Pi 只读答疑 Agent

**Files:** Create `src/tools/knowledge/index.ts`, `src/agents/course-qa/agent.ts`, `src/services/session-service.ts`, `src/schemas/qa-stream.ts`, `tests/course-qa.test.ts`.

- [ ] 写 fauxProvider 失败测试：Agent 没有`read_source`、写文件或发布工具；调用`submit_answer`前未读取对应行时引用被拒绝；跨课程路径被拒绝。
- [ ] 实现四个只读 Pi 工具：`get_knowledge_root`、`list_knowledge_directory`、`search_knowledge`、`read_knowledge_lines`；每个工具闭包绑定受信任的`courseId`和 active `releaseId`。
- [ ] 实现`submit_answer({answer,citations,insufficient})`；验证每个引用已读、路径与 release 一致、行范围有效。有效提交终止 Agent 循环，并返回结构化`CourseAnswer`。
- [ ] 实现`SessionService`，用随机`sessionId`将消息存到`workspace/sessions/web/{courseId}/`；每个会话最多保留 20 条消息，切换 active release 时新会话使用新版本。
- [ ] 为 Agent 增加只读的运行事件回调；将 Pi 的工具开始、工具结束和文本增量映射为受限的答疑事件。工具仅使用用户可理解的标签：`查看课程目录`、`浏览资料目录`、`搜索课程资料`、`阅读相关原文`；摘要只记录逻辑范围（例如文件名与行号），不含原文和原始参数。
- [ ] 定义流事件契约：`status`、`tool_start`、`tool_end`、`answer_delta`、`final`和`error`。`final`包含已验证的`answer`、`citations`、`insufficient`、`releaseId`和`sessionId`；只有收到`final`后才持久化本轮助手消息。
- [ ] 写失败测试：伪 Provider 依次触发工具和文本增量时，事件顺序可预测；`submit_answer`不作为可展示的工具步骤；任何事件都不包含原文、Prompt、绝对路径或 API key。
- [ ] 运行`npm test -- --run tests/course-qa.test.ts`，预期全部通过且不需要网络或真实密钥。

## Task 3: Web API

**Files:** Modify `src/api/server.ts`, create `src/api/routes/qa.ts`（或在现有 server 内注册），create `src/api/streaming/sse.ts`, create `tests/course-qa-api.test.ts`.

- [ ] 写 API 失败测试：无 active release 返回 409；无模型配置返回 503；非法 session、跨课程 session、无效引用均不能调用模型或返回答案。
- [ ] 写 API 成功测试：创建会话、消费完整 SSE 事件序列、收到若干`answer_delta`以及最终`final`中的`answer`、`releaseId`和一条有效引用；资料不足时最终事件返回`insufficient: true`和空引用。
- [ ] 注册`POST /api/courses/:courseId/qa/sessions`、`POST /api/courses/:courseId/qa/sessions/:sessionId/messages/stream`和`GET /api/courses/:courseId/qa/sessions/:sessionId`。流式路由使用`text/event-stream`、`Cache-Control: no-cache, no-transform`和`Connection: keep-alive`，并以 SSE 注释定期保活。
- [ ] 实现 SSE 编码与断开处理：保持事件边界和 JSON 编码；客户端主动中止时停止 Agent、本轮不写入完整助手消息，并且不把中止当作服务器错误。
- [ ] 将领域错误映射为不含文件系统路径、Prompt 或密钥的统一 JSON 错误：400、404、409、422、503。
- [ ] 运行`npm test -- --run tests/course-qa-api.test.ts`，预期全部通过。

## Task 4: Web 问答界面

**Files:** Modify `web/src/App.tsx`, create `web/src/pages/CourseQaPage.tsx`, modify `web/src/styles.css`, create `web/src/components/ChatComposer.tsx`, create `web/src/components/ChatSidebar.tsx`, create `web/src/components/ToolActivity.tsx`, create `web/src/lib/consume-sse.ts`.

- [ ] 写组件测试：未选择课程时禁用发送；回答显示来源文件、标题和行号；点击引用打开同一 active release 的对应文件与行范围；资料不足状态显式展示；窄屏时侧栏可收起；模拟 SSE 的工具事件和文本增量能够显示进行中的步骤并拼接回答。
- [ ] 在现有资料库页保留清晰入口`进入课程答疑`，新增独立路由`/qa`；答疑页不显示导入、发布或草稿编辑控件。
- [ ] 实现桌面优先的三段布局：左侧固定 280px 会话侧栏、中间自适应对话区、底部固定输入区。侧栏包含产品名“课程答疑”、课程选择器、新建对话按钮、当前课程的会话摘要列表和“返回资料库”入口；移动端默认收起，可通过无障碍按钮展开。
- [ ] 实现空会话中心欢迎区：显示当前课程名、简短的“仅依据已发布课程资料回答”提示，以及从 active release 文档标题生成的最多 3 个示例问题按钮；不显示 ChatGPT 品牌、语音、网页搜索、图片生成或工作区切换控件。
- [ ] 实现消息区：用户消息右对齐的浅色圆角气泡；助理回答左对齐的可阅读 Markdown；回答下方使用紧凑引用胶囊显示`文件名 · Lstart–Lend`。点击引用在同页右侧抽屉（窄屏全屏）打开只读原文，并高亮对应行。
- [ ] 通过`fetch`读取 POST SSE 的`ReadableStream`（而非只能 GET 的`EventSource`），缓冲并解析事件帧；收到`answer_delta`立即更新当前助手消息，收到`final`后更新引用和会话记录。
- [ ] 实现类似 Codex 的紧凑工具活动区：回答上方按时间显示“正在搜索课程资料”等运行步骤，包含进行中、完成和失败状态；完成后默认折叠，用户可展开查看安全摘要。它说明“做了什么”，不展示模型内部推理或资料原文。
- [ ] 实现底部 ChatComposer：自适应高度 textarea、发送按钮、Enter 发送与 Shift+Enter 换行、流式生成期间的`停止生成`按钮。停止时使用`AbortController`中止请求，界面保留已显示的草稿并标记“已停止，未保存本轮回答”。其宽度最大 820px，始终位于对话区底部，不遮挡最后一条消息。
- [ ] 使用中性浅灰背景、白色侧栏、系统字体、细边框和低阴影；不引入图片、图标包或内联 SVG。满足键盘焦点、按钮标签、对比度和 768px 以下响应式布局。
- [ ] 若当前课程没有 active release 或模型未配置，显示可操作提示，不发送请求。
- [ ] 运行前端测试和`npm run build`，预期通过。

## Task 5: 验收资料、文档与交付

**Files:** Create `tests/fixtures/course-qa/README.md`, create `docs/acceptance/M2-web-course-qa.md`, modify `.docs/architecture.md`, `.docs/domain-and-storage.md`, `.docs/development.md`, `.docs/testing.md`, `config.example.json`.

- [ ] 建立合成课程 fixture：至少 30 个可回答问题和 10 个资料不足问题；每个可回答问题固定期望引用文件与行范围。
- [ ] 在验收记录写明启动方式、模型配置、30+10 问题集、课程隔离检查、active release 切换检查和用户结论模板。
- [ ] 将 M2 已实现的 active-release-only 读取、会话存储、引用验证、模型配置与测试命令同步至`.docs`；不记录任何真实课程正文或密钥。
- [ ] 运行`npm run check`和`npm run build`；记录通过输出后，将 M2 状态更新为`ready_for_user_test`，但不得代替用户填写`accepted`。

## User acceptance

1. 选择 M1 已发布课程，询问一个单章节问题，检查答案和引用。
2. 点击引用，确认文件、标题和行范围确实支持答案。
3. 询问跨两个章节的问题，确认返回多个有效引用。
4. 询问资料中不存在的问题，确认显示资料不足且没有本地引用。
5. 创建第二门课程后提问第一门课程内容，确认不能跨课程读取。
6. 切换课程 active release 后创建新会话，确认新会话只读取新版本。
7. 提问后确认工具活动区先展示安全的检索步骤，回答文本逐段出现；展开步骤时不应看到内部推理、原文、Prompt、绝对路径或密钥。
8. 在生成中点击“停止生成”，确认请求停止且未完成回答不会被保存到会话历史。

## Acceptance criteria

- 合成问题集中，可回答问题的路径与行号引用正确率不低于 95%。
- 资料不足问题不生成引用；跨课程和 staging 读取成功次数为 0。
- 所有回答记录 releaseId；切换 active release 不会改变历史会话已记录的引用。
- 成功流式问答按`tool_start/tool_end`、零个或多个`answer_delta`、一个`final`（或一个`error`）结束；任何工具活动内容均不泄露受保护信息。
- `npm run check`、`npm run build`、定向服务/API/Agent/UI测试均通过。
