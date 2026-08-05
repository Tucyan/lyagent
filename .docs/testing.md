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

普通`npm test`不得要求模型密钥、MinerU、企业微信账户或公网连接。

Windows启动器测试通过依赖注入覆盖真实bind端口保留、伪造/过期runtime descriptor、Global Mutex命名、子进程参数与定向回收、退出码42、异常重启上限、GPU/强制CPU选择、hybrid smoke回退、BAT中文与空格路径，以及脱敏runtime API。普通测试不启动或安装真实MinerU；发布包真实组件验收属于后续发布验收任务。

M4测试覆盖评分三种模式的程序重算、精确等级/等级区间/连续得分、固定一次/按次/整数区间扣分及历史规则兼容、结构化评分分析论据、可选原文与图片佐证的当前提交边界、不可变原件、Markdown版本锁、`.doc`拒绝、伪造扩展名与远程图片拒绝、文件名身份识别、Docling ZIP流式限额解包与404恢复、转换器不可达/超时/5xx分类、提交/轮询/结果下载的有界退避重试、完成后任务丢失的受限重提、明确解析失败与本地结果拒绝、安全错误持久化和恢复、活动转换删除保护、删除墓碑查询隔离以及提交文件写入与删除互斥、固定13项正式批改工具与专用作业命名工具、教师审计、并发草稿冲突、可恢复的幂等确认、后台单并发、运行中重启不重复调用模型、SSE序号回放和三栏页面状态。`tests/fixtures/single-grading/ai-life-report/`包含同内容的MD、DOCX和PDF合成报告及用户提供的冻结评分表。

视觉路由测试还必须覆盖：无视觉配置不返回图片字节；有视觉配置时仅在成功图片结果后的下一轮切换；该次运行余下轮次保持视觉模型、下一次运行重置主模型且视觉Provider错误不回退；`model_switch`经后台事件表和SSE按原序号重放并在完成后折叠。模型设置测试覆盖首次设置阻断、共享/独立视觉凭据payload、CSRF bootstrap、响应无密钥、保存回滚及关闭视觉删除不再使用的凭据。

作业命名测试必须覆盖手填跳过Agent、留空强制命名轮次、正文与文件名冲突时正文优先、未调用终止工具时失败、失败重试和旧SQLite行迁移。CSV测试必须覆盖两种批量范围、只导出已确认结果、动态逐项列、可选逐项置信度、UTF-8 BOM、RFC 4180转义和公式注入防护。

设置`RUN_REAL_AI=1`和本地`DEEPSEEK_API_KEY`后，`tests/grading-real-provider.test.ts`会调用真实身份识别与批改Agent，要求提交全部16条规则并得到程序重算的85/100。普通检查不会运行该测试。

课程答疑测试必须断言：staging 与跨课程内容不可读、引用已读取且落在 active release 内、资料不足不带引用、网络引用来自本会话已搜索且已读取的结果、以及 SSE 工具活动不包含推理、Prompt、原文、绝对路径或密钥。网页读取测试还必须覆盖私网地址与重定向拦截。

评分表测试必须断言：作业要求或非空参考资料至少存在一项、无来源推荐不调用模型、已选制度和完成轮次会话可恢复、重进不自动请求推荐、咨询类消息产生流式且可持久化的回复并保持草稿内容与版本不变、非回复类Provider原始文本不进入SSE或持久化记录、Agent只能使用当前Assignment的固定工具、无模型时可创建人工首版草稿、草稿写入有版本冲突保护、冻结崩溃可恢复、冻结版本不可变且可创建修订、预览与Markdown包含等级和重叠规则，以及删除会话会同时移除参考资料、聊天记录、当前草稿和全部冻结正式版本。答疑和评分表都必须覆盖页面流断开后后台继续完成并持久化；显式停止必须通过运行ID取消且不保存未完成轮次。`tests/rubric-real-provider.test.ts`只在显式设置`RUN_REAL_AI=1`时使用当前本地配置运行真实Provider验收。

## 必须覆盖的风险

### Workspace安全

覆盖`..`、绝对路径、UNC、设备路径、ADS、大小写变体、symlink、junction、嵌套reparse point和路径检查后的替换竞争。无法在当前Windows权限下创建链接时，只跳过对应case并写明原因。

### 知识发布

- staging校验失败不改变active release；
- 在移动release和替换`active.json`之间崩溃仍可恢复；
- 答疑永远不读取staging；
- 断链、缺图、manifest不一致会阻止发布；
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

M5 批量批改的定向回归覆盖状态机、会话预留与租约 fencing、并发暂停、教师回答、崩溃窗口、Review 刷新、汇总文件、异步转换等待、API、页面模型和 120 份验收：

```powershell
npm test -- --run tests/grading-state-machine.test.ts tests/grading-concurrency.test.ts tests/grading-recovery.test.ts tests/summary-service.test.ts tests/grading-batch-acceptance.test.ts tests/grading-batch-page-model.test.ts tests/grading-api.test.ts tests/grading-run-service.test.ts tests/web-assets.test.ts
```

合成报告由 `scripts/generate-batch-grading-fixtures.ts` 生成，身份均为虚构数据。浏览器验收使用 `scripts/run-batch-grading-acceptance-server.ts` 的确定性 grader，在 `/grading/batches` 真实上传至少 30 份文件并验证并发 4、暂停/恢复和 CSV 下载；该脚本不作为模型质量验证，也不访问真实学生数据。

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
