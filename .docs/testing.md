# 测试与验收

## 当前基线

当前`tests/core.test.ts`覆盖：

- 普通Workspace路径越界；
- Message Bus发布与取消订阅；
- Tool Registry已注册工具调用；
- 管理页面路由及默认答疑路由；
- 可注入的Pi兼容Agent Runtime。

这些测试只证明脚手架行为，不代表目标系统的安全边界已经完成。

M1新增路径安全、知识发布、Pi资料规划器和资料导入API测试。M2新增 active release 检索、Pi 课程答疑工具/引用契约、会话/SSE API、前端 SSE 分帧，以及 DDGS 结果归一化、进程协议、网页证据和受控网页读取测试。M3新增三种评分制度Schema、草稿并发与冻结恢复、受控Agent工具、SSE与会话恢复、教师可读预览和页面状态测试；普通测试使用Pi faux provider，不调用DeepSeek或公网。

## 测试分层

| 层级 | 关注点 | 是否允许真实外部依赖 |
|---|---|---|
|单元测试|Schema、状态转换、评分计算、路径规则|不允许|
|Service集成测试|临时Workspace、SQLite、原子发布、恢复|允许本地临时文件和内存/临时数据库|
|Agent契约测试|工具可见性、输入输出Schema、引用要求|使用确定性假模型|
|API/Channel测试|鉴权、验签、去重、错误映射|使用录制或构造请求|
|验收测试|冻结资料、固定Prompt和批量fixture|仅在明确标记的环境运行真实Provider|

普通`npm test`不得要求模型密钥、Docling、企业微信账户或公网连接。

Windows启动器测试通过依赖注入覆盖真实bind端口保留、伪造/过期runtime descriptor、Global Mutex命名、子进程参数与定向回收、退出码42、异常重启上限、自动/强制CPU选择、Docling就绪检查、BAT中文与空格路径，以及脱敏runtime API。普通测试不启动或安装真实Docling；发布包真实组件验收属于后续发布验收任务。

M4测试覆盖评分三种模式的程序重算、精确等级/等级区间/连续得分、固定一次/按次/整数区间扣分及历史规则兼容、结构化评分分析论据、可选原文与图片佐证的当前提交边界、不可变原件、Markdown版本锁、`.doc`拒绝、伪造扩展名与远程图片拒绝、文件名身份识别、Docling ZIP流式限额解包与404恢复、转换器不可达/超时/5xx分类、提交/轮询/结果下载的有界退避重试、完成后任务丢失的受限重提、明确解析失败与本地结果拒绝、安全错误持久化和恢复、活动转换删除保护、删除墓碑查询隔离以及提交文件写入与删除互斥、固定13项正式批改工具与专用作业命名工具、教师审计、并发草稿冲突、可恢复的幂等确认、后台单并发、运行中重启不重复调用模型、SSE序号回放和三栏页面状态。`tests/fixtures/single-grading/ai-life-report/`包含同内容的MD、DOCX和PDF合成报告及用户提供的冻结评分表。
已确认成绩测试还校验读取时的JSON结构和 `resultHash`；改分但保留旧hash必须拒绝，完整有效结果继续可读。

视觉路由测试还必须覆盖：无视觉配置不返回图片字节；有视觉配置时仅在成功图片结果后的下一轮切换；该次运行余下轮次保持视觉模型、下一次运行重置主模型且视觉Provider错误不回退；`model_switch`经后台事件表和SSE按原序号重放并在完成后折叠。模型设置测试覆盖首次设置阻断、共享/独立视觉凭据payload、CSRF bootstrap、响应无密钥、保存回滚及关闭视觉删除不再使用的凭据。

作业命名测试必须覆盖手填跳过Agent、留空强制命名轮次、正文与文件名冲突时正文优先、未调用终止工具时失败、失败重试和旧SQLite行迁移。CSV测试必须覆盖两种批量范围、只导出已确认结果、动态逐项列、可选逐项置信度、UTF-8 BOM、RFC 4180转义和公式注入防护。

设置`RUN_REAL_AI=1`和本地`DEEPSEEK_API_KEY`后，`tests/grading-real-provider.test.ts`会调用真实身份识别与批改Agent，要求提交全部16条规则并得到程序重算的85/100。普通检查不会运行该测试。

课程答疑测试必须断言：staging 与跨课程内容不可读、引用已读取且落在 active release 内、资料不足不带引用、网络引用来自本会话已搜索且已读取的结果、以及 SSE 工具活动不包含推理、Prompt、原文、绝对路径或密钥。页面必须区分未选择课程、课程资料加载中、已选课程但没有 active release、模型未设置和可以提问五种输入状态，不得把“尚未发布资料”误报为“未选择课程”。网页读取测试还必须覆盖校验 DNS 地址就是实际连接地址、本地 TLS 连接的 IP/Host/SNI/证书语义、非法 HTTP 状态不从异步回调抛出、205 响应拒绝并关闭流、包括未决 DNS 在内的全抓取截止时间、IP literal 与各种 IPv4-mapped IPv6 私网拦截、拒绝非全局 IPv6 特殊用途地址且允许普通全球单播、每次重定向重新校验、重定向/错误响应取消、无长度头及伪小长度头下的流式字节上限。TLS 测试证书和私钥必须在测试进程内临时生成，不得保存为仓库 fixture 或普通临时文件。

评分表测试必须断言：作业要求或非空参考资料至少存在一项、无来源推荐不调用模型、已选制度和完成轮次会话可恢复、重进不自动请求推荐、咨询类消息产生流式且可持久化的回复并保持草稿内容与版本不变、非回复类Provider原始文本不进入SSE或持久化记录、Agent只能使用当前Assignment的固定工具、无模型时可创建人工首版草稿、草稿写入有版本冲突保护、冻结崩溃可恢复、冻结版本不可变且可创建修订、预览与Markdown包含等级和重叠规则，以及删除会话会同时移除参考资料、聊天记录、当前草稿和全部冻结正式版本。答疑和评分表都必须覆盖页面流断开后后台继续完成并持久化；显式停止必须通过运行ID取消且不保存未完成轮次。`tests/rubric-real-provider.test.ts`只在显式设置`RUN_REAL_AI=1`时使用当前本地配置运行真实Provider验收。

## 必须覆盖的风险

### Workspace安全

覆盖`..`、绝对路径、UNC、设备路径、ADS、大小写变体、静态symlink/junction拒绝、`lstat`未识别为symlink但`realpath`越界的路径重定向，以及文件句柄打开后替换路径时仍从已打开对象读取。Windows链接fixture不可创建时，只跳过对应case并记录错误码和原因。

这些回归不声称消除恶意本地进程在路径检查后、path-based syscall 前替换父目录的竞争。纯Node路径API无法原子绑定逐段校验与Windows上的打开、写入、rename或删除；如果威胁模型要求防止有权并发改写Workspace或其祖先的同用户进程，需使用native handle-relative helper或进程/账户隔离。代码评审不得以重复`lstat`或`realpath`检查宣称已经消除此类竞态。

### 知识发布

- staging校验失败不改变active release；
- 在移动release和替换`active.json`之间崩溃仍可恢复；
- 答疑永远不读取staging；
- 断链、缺图、manifest不一致会阻止发布；
- active指针哈希必须匹配release元数据；新release的完整manifest索引和树哈希必须验证，list/read 多次调用不得重复扫描全库正文，单篇正文在QA搜索/读取和直接release读取前仍须校验SHA-256；旧格式release首次由一个持久`MaterialService`读取时全量扫描并缓存逐文件预期哈希，重复list/read不能每次重扫全库，但每次仍校验指针与树，并在使用目标正文前重算其哈希；保留的draft树必须发现`tree.json`标题改写，缺少原始draft时拒绝读取；
- 回滚只切换active指针。
- release目录树和正文只读浏览不能改变active指针；
- 从release创建修订必须产生不同Import ID并保留`baseReleaseId`，同时保持源release正文不变；
- 草稿正文保存使用预期版本防止静默覆盖，并让内容变化反映到manifest哈希；
- 保存正文后再重命名或移动文档不得恢复为原始导入内容。

### Rubric与批改

- 区间、精确等级和连续得分规则；
- 减分重叠组和最大扣分；
- 总分及置信度的确定性重算；
- 相同`studentId`在不同批次中严格隔离；
- 证据路径和行号必须落在当前提交内；
- 教师Patch使用预期版本并产生审计事件。

### 队列与恢复

在模型返回后、结果rename后、SQLite提交前分别注入崩溃。恢复后必须满足：

- 正式结果唯一；
- 已有有效结果时不重复调用模型；
- job计数可以重新计算；
- CSV可以从JSON确定性重建；
- 等待教师任务不占用并发槽。

## Fixture规则

- fixture必须合成或完成脱敏，不使用真实学生身份和报告。
- 每个fixture包含README，说明输入、期望结果和用途。
- 排序、时间、随机ID和模型输出在测试中固定。
- 大批量fixture通过生成器产生，避免提交120份重复手写文件。
- 修复Bug时先增加最小回归fixture，不扩展无关场景。

## Dashboard 回归

`tests/dashboard-api.test.ts` 覆盖空工作区、已发布与未发布课程、会话聚合、最近活动上限与排序、损坏 active release 的隔离，以及响应不包含资料正文或临时路径。`tests/web-assets.test.ts` 覆盖根路由、`/knowledge` 和 `/qa` 的 SPA 直接访问。

Dashboard 测试不得依赖真实模型、网络搜索或本机已有课程资料；使用临时 Workspace 和合成 Markdown。`tests/web-assets.test.ts`除SPA入口外还必须读取至少一个嵌套`/assets/*`文件，防止构建成功但生产页面无法加载脚本或样式。

## 本地验证

`npm run typecheck` 还会通过独立的 `tsconfig.tests.json` 检查 `tests/rubric-preview.test.tsx`；该配置不生成文件，生产构建仍只使用根 `tsconfig.json`。

M5 批量批改的定向回归覆盖状态机、会话预留与租约 fencing、并发暂停、教师回答、崩溃窗口、Review 刷新、汇总文件、异步转换等待、API、页面模型和 120 份验收：

Windows Release 回归还覆盖持久化上传草稿、逐项失败隔离、刷新/重启恢复、身份补填、替换/移除、共享 `assets/` 引用筛选、事务性幂等提交，以及没有 active knowledge release 时提交完整批改草稿。ready项替换必须覆盖附件缺失时原会话和原文件保持不变，以及有效替换创建新会话并只携带被引用附件；受控并发测试确保处理中的旧会话结束前不会安装替换文件。确定性并发测试分别暂停 `createBatch` 和替换 staging 写入，覆盖提交/替换两种先后顺序，并断言创建批次的 session 集合与最终 committed item 相同；不同 item 的转换/命名仍可并行。替换故障注入还覆盖旧会话已 tombstone/部分删除后抛错：item 不得继续 ready 指向旧 session，清理记录在重启后可重试并继续处理新项；备份目录删除失败不得留下无记录目录；恶意 journal UUID/路径不得删除 Workspace 外哨兵；版本化迁移需能从旧上传库恢复。运行错误断言稳定安全码，并确认事件中不包含原始供应商错误。
页面状态测试还验证恢复请求期间 rubric、列表和详情状态变更不会丢弃有效响应；若恢复到的草稿已提交，则清理草稿状态并选中对应正式批次。旧恢复请求失败时，仅当存储指针和当前请求归属仍是旧 ID 才清理；延迟错误不得删除新建草稿的恢复指针。
批次上传与单份会话上传的 multipart 回归还必须覆盖：附件流累计超过50 MiB时立即拒绝且停止读取；主报告10 MiB与附件50 MiB的合法边界、最多100个附件、一个报告及单文件10 MiB限制。

前端状态同步回归由 `tests/frontend-async-state.test.ts`、`tests/consume-sse.test.ts`、`tests/grading-batch-page-rerender.test.ts` 及各页面 `*-source.test.ts` 覆盖：最新请求归属、串行轮询、轮询停止后的错误抑制、SSE 终态、操作中标签、路由切换取消、编辑草稿保护，以及批次 Review 自动刷新当前会话。批次草稿恢复测试在 happy-dom 中挂载页面，并在草稿请求未完成时触发评分标准切换、列表和详情响应。实机验收按 `docs/acceptance/windows-release-frontend-state-sync.md` 记录。

```powershell
npm test -- --run tests/grading-state-machine.test.ts tests/grading-concurrency.test.ts tests/grading-recovery.test.ts tests/summary-service.test.ts tests/grading-batch-acceptance.test.ts tests/grading-batch-page-model.test.ts tests/grading-batch-page-source.test.ts tests/grading-batch-review-page-model.test.ts tests/grading-batch-review-page-source.test.ts tests/grading-api.test.ts tests/grading-run-service.test.ts tests/web-assets.test.ts
```

合成报告由 `scripts/generate-batch-grading-fixtures.ts` 生成，身份均为虚构数据。浏览器验收使用 `scripts/run-batch-grading-acceptance-server.ts` 的确定性 grader，在 `/grading/batches` 真实上传至少 30 份文件并验证并发 4、暂停/恢复和 CSV 下载；该脚本不作为模型质量验证，也不访问真实学生数据。

批次 Review 回归还必须覆盖：表格分数/整体置信度、待复核重试、批次归属不匹配的确认拒绝、正式确认后的计数同步、`batch/session` 查询参数与前进后退、默认选择待复核项、25%–75% 拖拽边界、结构化评分修改及审计备注。浏览器验收在 `/grading/batches/review` 切换至少两名合成学生，确认不会重新挂载应用或出现“正在检查模型设置…”空白页。
页面模型回归覆盖真实批次详情组合：未确认草稿的 `reviewStatus` 可以是 `needs_review`，但仅当其 `requiresReview` 明确为 `false` 时允许列表确认；`requiresReview: true` 或字段缺失时须进入 Review，Review 导航仍可达。

定向测试：

```powershell
npm test -- --run tests/core.test.ts
```

完整检查：

```powershell
npm run check
npm run build
```

Windows 下 Vitest 固定最多使用 2 个 worker。集成测试会并行创建 SQLite 临时数据库、启动 Fastify 实例，并通过 PowerShell 子进程调用 DPAPI；更高的 worker 数会放大进程启动和磁盘 I/O 竞争，造成跨模块超时及 SQLite `EBUSY`，而不是暴露单个测试的逻辑慢路径。非 Windows 环境继续使用 Vitest 默认并发。此限制没有放宽单测超时，测试仍须在默认 5 秒内完成。

显式真实评分表Agent验收：

```powershell
$env:RUN_REAL_AI='1'; npm test -- --run tests/rubric-real-provider.test.ts
```

文档变更额外检查Markdown链接、JSON/SQL示例和代码围栏。原生依赖ABI错误属于环境失败，先修复环境再判断测试结果。

## MVP验收摘要

完整指标以`plan.md`第19.7节为事实来源，测试报告至少记录：

- 固定问答集的引用路径及行号正确率；
- 双教师共识样本的总分误差和逐项一致率；
- 120份批处理的数量、一致性、耗时和模型调用量；
- 崩溃注入后的重复结果和额外模型调用数；
- 路径越权、跨任务访问和敏感信息泄漏次数；
- 企业微信重复投递、无效签名、限流和长消息结果。

未达到阻断级指标时不能只记录为“已知问题”后宣称里程碑完成。
