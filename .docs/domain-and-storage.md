# 领域与存储

## 领域对象

| 对象 | 含义 | 唯一身份 |
|---|---|---|
|Course|一门课程及其知识库|`courseId`|
|Import|一次资料导入尝试|`courseId + importId`|
|Knowledge Release|一次成功发布的不可变知识版本|`courseId + releaseId`|
|Assignment|作业要求和评分表集合|`assignmentId`|
|Rubric Version|冻结后不可修改的评分标准|`assignmentId + rubricVersion`|
|Grading Batch|使用固定作业、Rubric、Prompt和配置的一批任务|`batchId`|
|Grading Job|批次中某名学生的一次正式批改|`batchId + studentId`|
|Review Event|教师对结果的确认或修改记录|`eventId`|

这些标识符由程序创建和校验，不从模型文本推断，也不能直接拼接未经校验的文件路径。

## Workspace目标结构

```text
workspace/
├─config/
├─inbox/
│  ├─materials/{importId}/
│  └─submissions/
├─knowledge/{courseId}/
│  ├─course.json
│  ├─active.json
│  ├─staging/{importId}/
│  └─releases/{releaseId}/
├─assignments/{assignmentId}/
│  ├─assignment.json
│  ├─design-session.json
│  ├─sources/{sourceId}.txt
│  ├─rubrics/
│  │  ├─draft.json
│  │  └─rubric-vN.json
│  ├─submissions/{batchId}/{studentId}/
│  └─results/{batchId}/
│     ├─{studentId}.json
│     ├─{studentId}.md
│     ├─audit/{studentId}.jsonl
│     └─summary.csv
├─sessions/
│  └─web/{courseId}/{sessionId}.json
├─state/app.db
└─logs/
```

M1已由资料导入服务安全创建`inbox/materials`和`knowledge/{courseId}`下的课程、staging、release目录。新增目录必须由启动或Service安全创建，不能依赖开发者手工准备。

## 事实来源

| 数据 | 事实来源 | 派生数据 |
|---|---|---|
|当前课程知识版本|`active.json`及其指向的release|目录缓存、搜索结果|
|评分标准|冻结的`rubric-vN.json`|界面展示和Prompt片段|
|单份正式批改|`{studentId}.json`|学生Markdown、CSV列|
|教师修改历史|追加写审计JSONL|当前Review状态|
|批处理控制状态|SQLite job记录|批次计数和进度条|
|班级汇总|正式结果JSON集合|`summary.csv`|

`summary.csv`、搜索索引和计数缓存必须可以重建，不得成为唯一数据来源。

## Web 答疑会话

每个会话保存`courseId`、创建时的`releaseId`、时间、可选的用户标题与最近 20 条用户/助手消息。助手消息只在结构化答案和引用均通过验证后写入；被用户停止的流式草稿不保存。会话始终按课程目录隔离，新的会话只绑定当时的 active release。标题只能由当前课程会话的重命名接口写入；删除只删除该会话文件，前端必须先获得二次确认。课程引用包含逻辑路径和行号；网络引用包含本会话`sourceId`、标题、URL和已读行号，不持久化完整网页正文。读取旧会话时，缺少`type`的历史引用按课程引用兼容处理。

## 知识版本规则

- Agent只能写当前Import的staging目录。
- 课程可同时存在多个`ready`状态草稿；管理页按课程列出草稿并在刷新后恢复最近更新的一份。
- 从release发起修改时，Service读取该release的受控目录并创建新的Import/staging；新Import通过`baseReleaseId`记录来源，原release与active指针保持不变。
- 草稿正文保存必须携带`expectedVersion`；成功保存后递增草稿版本，并以路径、来源章节和正文SHA-256共同重建manifest哈希。
- 草稿重命名或移动必须保留当前staging正文，不能从原始导入章节覆盖教师已经保存的修改。
- 发布前校验文件、链接、图片、manifest及哈希。
- release不可变；修改课程资料产生新release。
- `active.json`只保存活动release及manifest哈希。
- 回滚只切换active指针，不修改历史release。

## Rubric规则

- Assignment的作业要求与参考资料至少存在一项；仅有参考资料时允许要求为空。
- `design-session.json`保存已选评分制度和最近40条用户/助手消息。助手消息只保存完成轮次的最终文案、程序生成的固定处理阶段摘要、工具活动摘要和可选问题选项；Provider原始文本、失败或中止轮次不保存。
- 咨询、审阅或解释类轮次保存教师问题和Agent最终回复，但不写入评分表草稿，也不递增草稿版本；只有明确的创建或修改请求才允许产生新草稿。
- 已选评分制度在存在草稿或冻结版本后不可改变；重进会话只恢复本地状态，不触发模型调用。
- 草稿写入使用`expectedVersion`乐观并发；冻结后删除可编辑草稿并写入带哈希的不可变`rubric-vN.json`。
- 从冻结版本创建修订会复制为新的草稿并记录`baseRubricVersion`，不会覆盖历史版本。
- 删除评分会话必须先由前端二次确认；服务端删除整个受控Assignment目录，因此参考资料、`design-session.json`聊天记录、当前草稿和全部冻结正式版本会一并永久删除，不提供回退。
- 冻结的JSON是评分规则事实来源；Markdown是包含评分等级、证据要求、部分得分与重叠组语义的可读导出。嵌套规则不使用CSV作为事实来源。
- 加分制支持`exact-level`、`range`和`continuous`评分策略。
- 每条扣分规则独立选择`fixed`（触发时固定一次）、`per-occurrence`（按固定单位累计至上限）或`range`（在1到上限之间取任意整数）；同一减分制或混合制评分表可同时包含三种策略。未声明`amountPolicy`的历史规则按原`occurrence`语义读取，冻结版本不迁移、不改写。
- 批改Agent默认在冻结规则允许时按证据和严重程度使用区间内具体分值，不把区间规则简化成`0/上限`二选一；满分只用于有充分证据证明完整达到最高标准的项目。固定一次与按次规则仍必须严格使用冻结金额或增量。
- `range`结果必须保存`selectedLevelId`，得分位于等级闭区间。
- 减分制显式记录每条规则是否触发、实际扣分、证据和置信度。
- 新批改草稿的默认证据是结构化评分分析论据，包括作业表现观察、冻结标准对应关系和具体分值理由；它是面向教师的简明可审计结论，不是模型隐藏思维链。原文行号、短引文和图片只作为可选佐证；历史结果继续兼容原有文本与图片证据。
- 同一`overlapGroup`默认只触发一条规则，除非冻结Rubric明确允许累计。
- 总分、重复扣分和置信度聚合由程序计算。

评分表精确Schema以`src/schemas/rubric.ts`为事实来源；批改Schema以`src/schemas/grading.ts`为事实来源。本文件只维护不变量。

## M4单份批改存储

一个批改会话绑定唯一课程、一个评分表Assignment的冻结版本、一名学生、一份不可变原文件和一个当前Markdown提交版本。`batchId`、`studentKey`与会话ID均由程序生成，姓名和学号不参与路径拼接。

```text
assignments/{assignmentId}/
├─ submissions/{batchId}/{studentKey}/
│  ├─ metadata.json
│  ├─ original/submission.{ext}
│  └─ converted/submission-vN.md + assets/*
└─ results/{batchId}/
   ├─ {studentKey}.draft.json
   ├─ {studentKey}.json
   ├─ {studentKey}.md
   ├─ sessions/{studentKey}.json
   └─ audit/{studentKey}.jsonl
```

`grading.sqlite`中的`grading_sessions`、`grading_jobs`、`agent_runs`和`agent_run_events`只保存控制状态与可恢复事件。学生正文、草稿正文、正式结果和审计正文保存在受控Workspace文件中。正式JSON是事实来源，Markdown可重建。

已开始批改的提交与已确认结果不原地覆盖；教师选择“创建提交修订”或“创建结果修订”时，系统从当前锁定Markdown及其受控图片资源创建新的单份批改会话，原会话及正式JSON保持只读。`submissionHash`始终包含原件、当前Markdown和资源路径/内容哈希。相同会话同一时刻只允许一个排队或运行中的Agent run，grade与chat运行都会持久化`activeRunId`供页面恢复。

批改失败、显式取消或服务重启中断后，原锁定提交可在同一会话重新排队；已有草稿的修订轮次仍可再次进入`waiting_for_teacher`。重启恢复会清理中断run的活动索引，尚未执行的queued run保留活动索引并继续单线程执行。

## Job状态机

```text
pending → running
running → waiting_for_teacher | completed | needs_review | failed | pending
waiting_for_teacher → pending | cancelled
failed → pending | cancelled
needs_review → completed
pending → cancelled
```

- `running → pending`只允许在租约过期且不存在有效正式结果时发生。
- 暂停批次只停止领取新job，不强制中断运行中的请求。
- 自动重试复用同一job ID和幂等键，默认最多3次。
- 参数、权限和Schema错误不自动重试。

## 文件与SQLite协调

正式结果先在目标目录写临时文件并原子rename，再以SQLite事务提交终态和`resultHash`。启动时：

1. 校验正式结果文件及哈希；
2. 有有效结果而job未提交时补写终态；
3. 无有效结果且租约过期时重新排队；
4. 清理无引用临时文件；
5. 根据job和结果重新计算批次计数。

数据库Schema发生变化时必须使用版本化迁移，并同时更新本文件、迁移测试和恢复测试。
