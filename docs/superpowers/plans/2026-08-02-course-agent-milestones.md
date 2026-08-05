# Course Agent User-Accepted Milestone Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以7个可独立运行、可由用户手工验收的纵向功能里程碑交付课程辅助智能体；用户明确验收当前里程碑后才能开始下一里程碑。

**Architecture:** 每个里程碑从界面或Channel贯穿Agent、Tool、Service和存储，交付完整用户流程，不按技术层横向拆分。安全边界、测试、审计和文档随首次使用它们的功能一起完成；共享底层只实现当前里程碑需要的最小能力。

**Tech Stack:** Windows 11、Node.js 24、TypeScript、Pi SDK、Fastify、React/Vite、SQLite、better-sqlite3、p-queue、unified/remark、Zod、Pino、Vitest。

---

## 里程碑治理规则

状态只允许按以下流程变化：

```text
planned → in_progress → ready_for_user_test
ready_for_user_test → accepted | changes_requested
changes_requested → in_progress
```

- 只有用户可以把里程碑标记为`accepted`。
- 当前里程碑未`accepted`时，不实现下一里程碑的产品功能。
- 底层重构只能服务当前里程碑，不提前实现未来抽象。
- 用户要求的修正仍属于当前里程碑，修正后重新执行完整验收。
- 排除项不是“稍后补齐”的缺陷；如果用户认为排除项是通过条件，先更新范围再继续。

本文件只定义里程碑边界。每个里程碑从`planned`进入`in_progress`前，必须在`docs/superpowers/plans/`创建独立实施计划，例如`YYYY-MM-DD-M1-knowledge-library.md`；独立计划按TDD拆成可执行小步骤，列出精确文件、命令和预期结果。不得把7个里程碑合并成一次性实施计划。

## 交付给用户测试前的统一门槛

每个里程碑进入`ready_for_user_test`前必须同时满足：

1. 本里程碑范围内没有占位页面、假按钮或仅内存实现；
2. `npm run check`和`npm run build`零退出；
3. 定向单元、集成和端到端测试通过；
4. 提供可重复使用的合成测试资料，不包含真实学生数据；
5. 更新受影响的`.docs`文档和示例配置；
6. 创建`docs/acceptance/MN-<name>.md`，记录版本、启动方法、手工步骤、预期结果和自动化证据；
7. 清楚列出本里程碑排除范围，不把已知范围内缺陷写成排除项。

验收记录使用以下结尾：

```markdown
## 用户结论

- 状态：pending | accepted | changes_requested
- 测试人：
- 测试日期：
- 备注：
```

开发者只能预填`pending`，不得代替用户填写`accepted`。

## 当前基线（不作为用户功能里程碑）

仓库已有TypeScript脚手架、Workspace普通路径限制、Message Bus、Agent Router、Agent Runtime、Tool Registry和5项核心测试。这些是M1的开发起点，不单独交付验收。

## 里程碑总览

| 里程碑 | 完整用户功能 | 边界 | 当前状态 |
|---|---|---|---|
|M1|课程资料库导入、发布、浏览和回滚|MVP Core|accepted|
|M2|带原文引用的Web课程答疑|MVP Core|accepted|
|M3|加分/减分/混合Rubric设计与版本发布|MVP Core|accepted|
|M4|单份作业批改、Review和导出|MVP Core|ready_for_user_test|
|M5|可恢复批量批改和班级汇总|MVP Core|ready_for_user_test|
|M6|本地备份、恢复和运行诊断|MVP Core|planned|
|M7|企业微信私聊/群聊课程答疑|MVP Integration|planned|

---

## M1：课程资料库导入、发布与浏览

**用户获得的完整功能：** 教师可以创建课程，导入包含图片的Markdown资料，预览整理结果，安全发布一个知识版本，并在本地Web界面浏览或回滚版本。

**主要文件：**

- Modify: `src/core/workspace.ts`
- Modify: `src/core/tool-registry.ts`
- Modify: `src/schemas/tools.ts`
- Create: `src/core/safe-filesystem.ts`
- Create: `src/schemas/identifiers.ts`
- Create: `src/services/material-service.ts`
- Create: `src/services/knowledge-release-service.ts`
- Create: `src/tools/material/index.ts`
- Create: `src/agents/material-import/agent.ts`
- Create: `src/api/server.ts`
- Create: `src/api/routes/materials.ts`
- Modify: `package.json`
- Create: `web/package.json`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/pages/MaterialImportPage.tsx`
- Create: `web/src/pages/KnowledgePage.tsx`
- Test: `tests/path-security.test.ts`
- Test: `tests/knowledge-release.test.ts`
- Test: `tests/material-import-api.test.ts`

### 实施任务

- [ ] 使用失败测试定义标识符白名单、Windows路径边界和ImportContext隔离。
- [ ] 实现只允许当前Import读写的SafeFilesystem和资料扫描/读取工具。
- [ ] 实现Markdown拆分、图片复制、manifest生成和staging预览。
- [ ] 实现不可变release、`active.json`原子切换和回滚。
- [ ] 实现创建课程、发起导入、查看预览、发布和回滚API。
- [ ] 实现资料导入与知识树浏览页面，不直接暴露绝对路径。
- [ ] 完成故障注入、断链、缺图、越权和回滚测试。
- [ ] 创建`docs/acceptance/M1-knowledge-library.md`并交付用户测试。

### 用户验收步骤

1. 启动本地服务并创建一门测试课程。
2. 导入提供的Markdown和图片资料。
3. 在发布前查看目录、拆分文件和图片预览。
4. 发布后刷新知识浏览页，确认只显示完整资料。
5. 导入一个包含断链或缺图的版本，确认发布被拒绝且旧版本仍可浏览。
6. 发布第二个有效版本，再回滚到第一个版本。
7. 尝试选择Workspace外路径，确认系统拒绝且没有读写外部文件。

### 通过标准

- 导入、预览、发布、浏览和回滚全部可通过Web完成。
- active release始终完整；发布失败不会暴露staging或破坏旧版本。
- Markdown内部链接和图片引用有效，越权访问成功次数为0。
- 发布版本不可原地编辑；修改资料会生成新release。

### 排除范围

- 课程问答、联网搜索、Rubric、作业批改和企业微信。
- PDF、DOCX、OCR、RAG和Embedding。

---

## M2：基于本地课程资料的Web答疑

**用户获得的完整功能：** 教师或学生可以在Web界面选择课程并提问，系统浏览当前active release、读取原文后回答，并提供可验证的文件、标题和行号引用。

**主要文件：**

- Create: `src/services/knowledge-service.ts`
- Create: `src/services/session-service.ts`
- Create: `src/tools/knowledge/index.ts`
- Create: `src/agents/course-qa/prompt.ts`
- Create: `src/agents/course-qa/agent.ts`
- Create: `src/api/routes/qa.ts`
- Create: `web/src/pages/CourseQaPage.tsx`
- Test: `tests/knowledge-search.test.ts`
- Test: `tests/course-qa.test.ts`
- Test: `tests/course-qa-api.test.ts`

### 实施任务

- [ ] 用固定语料写目录浏览、确定性搜索、分页和行范围读取的失败测试。
- [ ] 实现只解析active release的KnowledgeService和只读工具集合。
- [ ] 实现要求“先读原文、后回答”的课程答疑Agent和拒答规则。
- [ ] 实现按课程隔离的Web会话、引用结构和会话历史上限。
- [ ] 实现课程选择、问答、引用跳转和资料不足提示页面。
- [ ] 使用30个可回答问题和10个资料不足问题执行引用验收测试。
- [ ] 创建`docs/acceptance/M2-web-course-qa.md`并交付用户测试。

### 用户验收步骤

1. 选择M1发布的课程，询问一个单章节问题。
2. 点击引用，确认文件、标题和行范围确实支持答案。
3. 询问需要综合两个章节的问题，确认返回多个有效引用。
4. 询问资料中不存在的问题，确认系统明确说明资料不足而不是编造引用。
5. 创建第二门课程并提出第一门课程的问题，确认不会跨课程读取。
6. 继续追问，确认会话保留必要上下文但引用仍来自当前active release。

### 通过标准

- 可回答问题的引用路径和行号正确率不低于95%。
- 资料不足问题不得生成虚假本地引用。
- 答疑工具为只读，跨课程读取成功次数为0。
- 更新active release后新会话读取新版本，历史答案仍保留原引用版本信息。

### 排除范围

- 企业微信、互联网补充、Rubric和作业批改。
- 向量检索与语义索引。

---

## M3：评分表设计、校验与版本发布

**用户获得的完整功能：** 教师可以输入作业要求，设计加分制或减分制Rubric，回答关键歧义问题，编辑和校验草稿，并发布不可变版本。

**主要文件：**

- Create: `src/schemas/rubric.ts`
- Create: `src/services/rubric-service.ts`
- Create: `src/tools/rubric/index.ts`
- Create: `src/agents/rubric-designer/prompt.ts`
- Create: `src/agents/rubric-designer/agent.ts`
- Create: `src/api/routes/rubrics.ts`
- Create: `web/src/pages/RubricPage.tsx`
- Test: `tests/rubric-schema.test.ts`
- Test: `tests/rubric-versioning.test.ts`
- Test: `tests/rubric-api.test.ts`

### 实施任务

- [x] 用失败测试定义加分区间、精确等级、连续得分、减分上限和重叠组。
- [x] 实现Rubric Schema、确定性总分/冲突校验和结构化Patch。
- [x] 实现服务端AssignmentContext、乐观版本和不可变发布版本。
- [x] 实现只在关键歧义时提问的评分表设计Agent。
- [x] 实现创建、问答、编辑、校验、发布和复制新版本页面。
- [x] 创建`docs/acceptance/M3-rubric-design.md`并交付用户测试。

### 用户验收步骤

1. 创建作业并输入总分、要求和原始评分说明。
2. 生成加分制草稿，回答一个歧义问题并修改一个等级区间。
3. 制造总分错误或区间重叠，确认发布被阻止并显示具体原因。
4. 修正后发布v1，确认v1不能直接编辑。
5. 从v1创建新草稿并发布v2，确认历史v1仍可读取。
6. 创建减分制Rubric，验证最大扣分和`overlapGroup`行为。

### 通过标准

- 加分制与减分制都能完整创建、校验和发布。
- 程序拒绝总分错误、等级越界、区间重叠和明显重复扣分。
- 草稿并发修改使用`expectedVersion`防止静默覆盖。
- 已发布版本不可变，批改只能选择冻结版本。

### 排除范围

- 实际批改、批量队列、成绩导出和企业微信。

---

## M4：单份作业批改、教师Review与导出

**用户获得的完整功能：** 教师可以上传一名学生的报告，选择冻结Rubric执行批改，查看逐项证据和置信度，修改并确认结果，导出JSON、学生Markdown反馈和由已确认结果聚合的CSV成绩表。每份学生报告有独立作业名称；可手填，也可在转换后由Agent检索正文和文件名识别。

**主要文件：**

- Create: `src/schemas/grading.ts`
- Create: `src/services/submission-service.ts`
- Create: `src/services/grading-service.ts`
- Create: `src/services/review-service.ts`
- Create: `src/tools/submission/index.ts`
- Create: `src/tools/grading/index.ts`
- Create: `src/agents/assignment-grader/prompt.ts`
- Create: `src/agents/assignment-grader/agent.ts`
- Create: `src/db/schema.sql`
- Create: `src/db/database.ts`
- Create: `src/api/routes/grading.ts`
- Create: `src/api/routes/reviews.ts`
- Create: `web/src/pages/SingleGradingPage.tsx`
- Create: `web/src/pages/ReviewPage.tsx`
- Test: `tests/single-grading.test.ts`
- Test: `tests/review-audit.test.ts`

### 实施任务

- [x] 用失败测试定义GradingJobContext隔离、证据校验、总分和Review规则。
- [x] 实现单份submission浏览、搜索、分段读取和图片读取工具。
- [x] 实现批改草稿、程序校验、原子结果发布和来源哈希。
- [x] 实现单份job所需的最小SQLite Schema和启动协调。
- [x] 实现教师Patch、确认状态和追加写审计事件。
- [x] 实现上传、启动批改、证据查看、Review和JSON/Markdown导出页面。
- [x] 实现作业名称识别、评分标准筛选、会话重命名/删除和可配置CSV批量导出。
- [x] 创建`docs/acceptance/M4-single-grading.md`并交付用户测试。

### 用户验收步骤

1. 上传一份包含正文和图片的Markdown报告。
2. 选择M3冻结的Rubric并启动批改。
3. 检查每项得分、理由、证据、引用行和置信度。
4. 打开低置信度结果，确认它自动进入Review。
5. 修改一项分数和理由，填写备注并确认结果。
6. 查看审计记录，确认修改前后值、操作者和时间完整。
7. 导出JSON和学生Markdown，确认总分一致且原报告未被修改。

### 通过标准

- 每个评分项都有合法分数、理由、证据或明确的证据不足标记。
- 总分和总体置信度可以由程序重算，模型不能覆盖计算值。
- 教师修改保留完整审计历史，重复发布不产生第二份正式结果。
- 相同`studentId`在不同Assignment/Batch中不会串数据。

### 排除范围

- 多份并发、CSV汇总、暂停恢复和企业微信。

---

## M5：批量批改、暂停恢复与班级汇总

**用户获得的完整功能：** 教师可以创建包含30～120份报告的批次，以可配置并发执行，暂停和恢复任务，处理提问与失败重试，并导出一致的班级CSV。

**主要文件：**

- Modify: `src/db/schema.sql`
- Modify: `src/db/database.ts`
- Create: `src/queue/grading-queue.ts`
- Create: `src/services/summary-service.ts`
- Create: `src/api/routes/batches.ts`
- Create: `web/src/pages/GradingBatchPage.tsx`
- Test: `tests/grading-state-machine.test.ts`
- Test: `tests/grading-recovery.test.ts`
- Test: `tests/grading-concurrency.test.ts`
- Test: `tests/summary-service.test.ts`

### 实施任务

- [ ] 用失败测试定义job唯一约束、合法状态转换、租约、续租和重试上限。
- [ ] 实现SQLite迁移、事务领取、过期租约协调和问题队列。
- [ ] 使用p-queue实现可配置并发、暂停领取和单份失败隔离。
- [ ] 实现每job独立原子结果与SummaryService单写者CSV聚合。
- [ ] 在模型返回后、结果rename后和数据库提交前完成崩溃注入测试。
- [ ] 实现批次创建、进度、暂停、恢复、回答问题、重试和导出页面。
- [ ] 使用假模型运行120份确定性验收，使用真实模型运行用户同意数量的校准样本。
- [ ] 创建`docs/acceptance/M5-batch-grading.md`并交付用户测试。

### 用户验收步骤

1. 创建至少30份合成报告的批次并设置并发4。
2. 启动后暂停，确认运行中的任务完成而没有新任务被领取。
3. 恢复批次，确认继续处理剩余报告。
4. 终止并重启程序，确认有效结果不重复批改。
5. 回答一个等待教师的问题，确认对应job恢复且其他job不受阻塞。
6. 手动重试一个可重试失败，确认尝试次数和错误记录正确。
7. 导出CSV，核对行数、学生唯一性、总分和Review状态。

### 通过标准

- 120份假模型测试恰好生成120份JSON、120份Markdown和120行CSV数据。
- 重启后重复正式结果数为0，已有有效结果的额外模型调用数为0。
- 等待教师和单份失败不占满或阻塞整个批次。
- SQLite计数、终态job、结果文件和CSV完全一致。

### 排除范围

- 分布式Worker、Redis、多机并发、自动发布正式成绩和企业微信。

---

## M6：本地备份、恢复与可重复运行

**用户获得的完整功能：** 教师可以安全备份课程、作业、结果和SQLite状态，在干净目录恢复后继续浏览、答疑、Review和未完成批次。

**主要文件：**

- Create: `src/services/backup-service.ts`
- Create: `src/cli/backup.ts`
- Create: `src/cli/restore.ts`
- Create: `src/cli/doctor.ts`
- Modify: `package.json`
- Create: `tests/backup-restore.test.ts`
- Create: `docs/backup-and-restore.md`
- Create: `README.md`

### 实施任务

- [ ] 用失败测试定义一致性备份清单、manifest、恢复校验和目标目录保护。
- [ ] 实现暂停领取、等待原子发布结束和SQLite一致性快照。
- [ ] 实现备份manifest、哈希校验、恢复到空Workspace和恢复前冲突拒绝。
- [ ] 实现`doctor`命令检查配置、权限、active release、数据库迁移和结果协调。
- [ ] 编写从安装、启动、备份、恢复到故障排查的用户文档。
- [ ] 在新的临时Workspace执行完整恢复演练。
- [ ] 创建`docs/acceptance/M6-backup-restore.md`并交付用户测试。

### 用户验收步骤

1. 在已有课程、Rubric、结果和暂停批次的Workspace创建备份。
2. 查看备份manifest，确认不包含密钥和普通日志。
3. 在新的空目录恢复备份并运行`doctor`。
4. 启动系统，确认课程、Rubric、结果和审计记录可读取。
5. 恢复暂停批次，确认已有结果不重复执行。
6. 尝试恢复到非空冲突目录或使用损坏备份，确认系统拒绝且原数据不变。

### 通过标准

- 备份可以在干净Workspace完整恢复并通过`doctor`。
- active release、结果哈希、SQLite计数和审计记录保持一致。
- 损坏或冲突恢复不会部分覆盖目标Workspace。
- 新开发者只依据README和`.docs/development.md`可以完成安装与启动。

### 排除范围

- 云备份、自动计划任务、增量备份、安装器和自动更新。

---

## M7：企业微信课程答疑

**用户获得的完整功能：** 通过技术验证后，用户可以在企业微信私聊或群聊`@机器人`进行M2同等质量的课程答疑，并具备验签、去重、限流重试和课程映射。

**进入条件：** M1～M6均已被用户验收；目标企业微信组织已完成连接验证，管理员权限和本机网络入口明确可用。

**主要文件：**

- Create: `docs/wecom-connectivity-spike.md`
- Create: `src/channels/wecom/adapter.ts`
- Create: `src/channels/wecom/dedup-store.ts`
- Create: `src/channels/wecom/message-splitter.ts`
- Create: `src/api/routes/wecom.ts`
- Test: `tests/wecom-signature.test.ts`
- Test: `tests/wecom-channel.test.ts`
- Test: `tests/wecom-dedup.test.ts`

### 实施任务

- [ ] 在目标组织完成可丢弃连接验证并冻结接入方式和权限前提。
- [ ] 用官方示例向量写验签、解密、时间窗口和错误输入测试。
- [ ] 实现入站消息规范化、用户/群课程映射和快速确认。
- [ ] 实现SQLite短期去重、异步处理、有上限重试和长消息拆分。
- [ ] 复用M2 Course QA Service，不复制检索或Prompt逻辑。
- [ ] 完成私聊、群聊、重复投递、未知映射和长回答端到端测试。
- [ ] 创建`docs/acceptance/M7-wecom-qa.md`并交付用户测试。

### 用户验收步骤

1. 为一个群绑定课程，在群内`@机器人`询问课程问题。
2. 私聊机器人并验证默认课程映射。
3. 点击或核对引用，确认与Web答疑使用同一active release。
4. 重复投递同一消息，确认只产生一次Agent调用和一次业务回复。
5. 使用未知群或用户提问，确认系统在调用模型前拒绝。
6. 触发长回答，确认拆分顺序和引用完整。
7. 暂时停止本地服务后恢复，确认重试不会产生重复回答。

### 通过标准

- 私聊和群聊各完成至少10次端到端问答。
- 同一消息重复投递3次只产生1次Agent调用。
- 无效签名、过期时间戳和未知映射全部被拒绝。
- 密钥和回调明文不进入仓库、前端响应或普通日志。
- Web和企业微信对同一问题使用相同QA核心及引用规则。

### 排除范围

- 其他IM Channel、多租户、企业微信管理后台和自动成绩通知。

---

## 里程碑完成定义

M7被用户标记为`accepted`后，MVP交付完成。后续需求进入新的版本计划，不回填到已验收里程碑。任何已验收功能的回归缺陷按Bug处理并增加回归测试；改变用户可见行为时同步更新对应验收记录和长期文档。
