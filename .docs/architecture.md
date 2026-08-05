# 系统架构

## 当前状态

项目目前处于核心脚手架阶段。已经实现：

- `Workspace`：拒绝绝对路径和普通`..`越界；
- `MessageBus`：进程内异步消息发布与订阅；
- `AgentRouter`：按管理页面选择四类Agent，默认进入课程答疑；
- `AgentRuntime`：通过可注入的Pi兼容Agent执行Prompt；
- `ToolRegistry`：注册并调用已知工具；
- 基础类型、启动入口和核心单元测试。

M1已实现资料导入与发布，M2已实现课程答疑，M3已实现评分表设计与冻结。M4现已实现单份作业转换、会话式批改、教师Review、JSON/Markdown导出，以及从已确认结果生成的CSV成绩表；批量自动批改任务与企业微信仍属于后续里程碑。开发时必须区分本节的当前状态与`plan.md`中的目标设计。

## 目标分层

```text
Web / WeCom Channel
        ↓
Message Bus
        ↓
Agent Router
        ↓
Agent Runtime
        ↓
Agent-scoped Tool Registry
        ↓
Local Services
        ↓
Safe Filesystem / SQLite / External Providers
```

### 层级职责

- **Channel**：验证输入身份、规范化消息、返回结果；不读取业务文件，不直接调用模型。
- **Message Bus**：传递统一消息，不包含业务判断。
- **Agent Router**：由程序按入口和上下文选择Agent，不让模型自由路由。
- **Agent Runtime**：创建会话、运行模型循环、注入当前Agent可见工具。
- **Tool Registry**：执行输入校验、Agent授权和可信上下文绑定。
- **Service**：实现发布、检索、评分、状态转换和审计等确定性业务规则。
- **Storage**：文件保存内容与不可变结果；SQLite保存可恢复控制状态。

## 四类Agent

| Agent | 负责 | 不负责 |
|---|---|---|
|资料导入|理解资料、规划结构、生成staging内容|直接发布、访问其他课程、任意文件写入|
|课程答疑|搜索并读取active release、组织带引用回答|修改知识库、读取作业或配置|
|评分表设计|识别歧义、生成和修改评分草稿|绕过Schema、直接修改冻结版本|
|作业批改|依据冻结Rubric选择证据并形成评分草稿|选择其他学生、计算最终总分、直接写CSV|

## 不可破坏的架构约束

1. Agent输入不能成为身份或路径授权依据。`courseId`、`importId`、`assignmentId`、`batchId`和`studentId`来自服务端`ToolContext`。
2. Tool不能直接包含复杂业务逻辑；确定性规则放入Service，Tool只负责Schema和调用适配。
3. Service不能反向依赖Agent或Channel。
4. 答疑只通过`active.json`解析当前不可变release，禁止扫描staging。
5. 每个批改job只写自己的JSON和Markdown；批次CSV由单写者聚合。
6. 外部Provider通过接口注入，核心领域逻辑不依赖具体模型或企业微信SDK。
7. 所有现有Agent、作业命名和身份识别从统一`models.primary`构造OpenAI-compatible运行时；可选`models.vision`仅注册能力，视觉切换由后续阶段实现。模型元数据、Provider地址和凭据查找由程序控制，Agent不能选择Provider或读取密钥。
8. 模型配置写入在跨进程锁内执行两阶段本地事务：`prepared`日志提供崩溃回滚，配置提交后写`committed`再清理。规范Workspace身份同时界定事务日志、Windows全局Mutex和Workspace隔离的DPAPI凭据命名空间；日志不保存明文密钥，并发进程或不同Workspace不能交错/混用Provider密钥和模型元数据。

## 关键流程

### 知识发布

```text
导入资料
→写入knowledge/{courseId}/staging/{importId}
→校验链接、图片、manifest和路径
→原子移动到releases/{releaseId}
→原子替换active.json
→答疑开始读取新版本
```

失败时保持旧`active.json`不变。release发布后不可修改。

已发布资料的修改走独立修订流程：管理页读取release目录树和正文，Service以该快照创建带`baseReleaseId`的新Import/staging；教师只编辑staging，发布前线上答疑仍读取原active release。草稿发布后生成新的不可变release并替换active指针。管理页可只读浏览任意release，但不能向release目录写入。

### 课程答疑

```text
Web /qa
→ POST SSE
→ Course QA Agent（只读工具）
→ KnowledgeService（active release）或 WebEvidenceService（DDGS → 受控网页读取）
→ submit_answer 引用校验
→ final SSE 与本地会话持久化
```

流式事件只传递文本增量和安全的工具活动摘要；页面将`final`前的文本以“处理过程（非最终回答）”独立展示且不写入会话，正式回答只取`final.answer`。不得向浏览器传递思维链、Prompt、原文、完整工具参数、绝对路径或密钥。工具活动默认显示最近五项，可展开查看其余安全摘要。`final`事件发送前，程序验证课程引用属于当前 active release 且已被读取；网络引用必须来自本会话已搜索并已读取的受控网页结果。

### 评分表设计

```text
Web /rubrics
→ 创建Assignment并保存受控参考资料
→ 选择并持久化加分制、减分制或混合制
→ Rubric Designer Agent（固定工具白名单）
→ RubricService校验并保存可编辑草稿
→ 教师人工编辑、校验并确认冻结
→ 不可变rubric-vN.json
```

评分制度选择、草稿版本、冻结版本和会话历史由程序控制。Agent只能读取当前Assignment的受控上下文和来源，并通过结构化工具提出澄清问题、给出不写入草稿的教师回复或提交草稿；咨询、审阅和解释类请求在没有明确改稿指令时只回复，不改变草稿版本。Agent不能冻结版本、选择其他Assignment或访问任意路径。评分表SSE只展示程序生成的固定处理阶段文案、本地化工具摘要，以及`reply_to_teacher`结构化参数中经过长度限制的最终回复增量；不转发其他Provider原始文本增量。完整Prompt、来源原文、其他工具参数、路径和密钥不进入浏览器或普通日志。会话重进只读取已保存状态，不调用模型；AI只在教师选择制度或发送消息时运行。模型未配置时，程序创建同制度的最小合法草稿，教师仍可从结构化编辑器完成全部流程。

答疑和评分表的流式HTTP连接只负责实时展示，不拥有Agent任务生命周期。页面切换或网络断连后，服务端继续完成当前任务并在成功后持久化；显式停止使用服务端运行ID调用取消接口，中止轮次不写入会话。

### 批改发布

评分草稿提交由服务端按会话串行化，并依据冻结评分表校验等级区间、精确等级、是否允许部分分、两位小数精度以及按次扣分/加分步长。文字证据的短引文必须真实出现在锁定提交的对应行段。运行中进程若重启，原运行标记为`INTERRUPTED`且不会自动再次调用模型；尚未领取的排队运行才会继续。正式结果以JSON为事实来源，读取或重复确认会补齐Markdown、确认审计和SQLite终态。

```text
领取带租约的job
→模型生成草稿
→程序校验并计算总分/Review规则
→临时文件写入并原子rename
→保存resultHash
→SQLite事务提交终态
→批次结束后重建summary.csv
```

启动恢复先协调正式结果文件和SQLite，已有有效结果时不得再次调用模型。

## 教师工作台

根路由 `/` 是教师/管理员 Dashboard；`/knowledge` 是课程资料库，`/qa` 是课程答疑，`/rubrics` 是评分表设计。Dashboard 只通过 `DashboardService` 组合 `MaterialService`、`KnowledgeService` 和 `SessionService` 的受控只读结果，不调用 Agent、模型或网络服务，也不写入遥测数据。

Dashboard 只返回课程元数据、active release 元数据、文档/会话计数和截断后的会话摘要。单个课程的 active release 损坏时，该课程标记为 `unavailable`，不影响其余课程的统计。评分表与单份批改入口已启用；批量任务、运维和企业微信仍是后续里程碑。

## M4单份批改边界

- `GradingSessionService`绑定唯一课程、冻结评分表版本、不可变原文件、转换后Markdown版本与程序生成的内部ID；会话显示名与学生报告的作业名称是两个独立字段。
- `SubmissionConversionService`通过仅允许环回地址的MinerU异步API转换DOCX、PDF、PPTX和图片；Markdown直接导入。连接失败、超时、限流和5xx进入`waiting_for_converter`并按有界退避重试；明确解析失败进入`conversion_failed`，本地安全或结果格式校验失败进入`result_rejected`。重试始终复用不可变原件。
- `PiAssignmentGrader`在正式批改轮次只获得固定13项批改工具。未手填作业名称时，程序在提交转换完成后强制启动专用命名轮次，该轮次只开放作业文件浏览、正文搜索、正文读取和`set_submission_title`；模型必须同时核对正文与原始文件名，冲突时以正文标题为准。冻结评分标准由服务端注入系统提示词；总分、证据、置信度和Review状态由程序在提交草稿时重算。
- `GradingRunService`以并发1执行后台轮次，把安全处理摘要、模型回复和脱敏工具活动写入可按序号回放的事件表；页面断开不会取消运行。
- `GradingResultService`负责乐观版本、教师审计、Review确认和不可变JSON/Markdown发布。Agent不能直接发布正式结果。
- `GradingCsvExportService`只聚合已确认JSON结果，按学生或精确冻结评分表生成可重建CSV；Agent不计算或写入成绩表。

## 依赖方向

允许：

```text
channels/api → core/agents/tools → services → db/filesystem/provider interfaces
```

禁止：

- `services`导入React、Fastify路由或具体Channel；
- `agents`直接导入`node:fs`、数据库或网络客户端；
- 前端读取Workspace绝对路径；
- `db`或文件适配层调用Agent。

出现需要反向依赖的需求时，先通过接口或事件解除耦合；若仍需改变边界，先记录ADR。

## M5 批量批改边界

`/grading/batches` 是独立于 M4 单份会话页的批量操作界面。批次只编排已有的单份批改会话：每个学生仍由自己的 M4 会话、转换结果、草稿和 Agent 工具上下文隔离，批量协调器不合并学生正文，也不扩大 Agent 的文件权限。

`GradingBatchService` 负责 30–120 份成员校验、全局会话预留、1–8 并发调度、暂停/恢复、教师问题、有限重试和租约恢复。队列任务开始时才在 SQLite 事务中领取 job；暂停只阻止新领取，正在运行的 job 会自然结束并释放并发槽。教师回答通过程序控制的 `waiting_for_teacher → queued` 转换，以“继续完成评分”的 grade 轮次恢复，而不是普通咨询 chat。租约 owner 与尝试次数共同构成 fencing 条件，过期执行不能发布或终结后来领取的 job；每次尝试写入独立结果路径，旧执行也不能覆盖新尝试文件。`GradingSummaryService` 为每个成功 job 原子写入带尝试版本的 JSON 事实快照及 Markdown 预览，并以串行写者从当前尝试快照重建班级 CSV。API 和页面只发出确定性命令、读取状态，不自行计算分数。

启动恢复按“有效结果快照、已持久化草稿、前一进程租约”顺序协调状态；已有有效结果时禁止再次调用模型，缺失的 Markdown 会从有效 JSON 补建。教师在 M4 修改或确认后，启动恢复和 CSV 导出都会刷新对应快照、job 状态与汇总。批次完成表示本轮没有可自动继续的 job，不等同于教师确认正式成绩。
