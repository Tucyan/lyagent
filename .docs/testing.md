# 测试与验收

## 当前基线

当前`tests/core.test.ts`覆盖：

- 普通Workspace路径越界；
- Message Bus发布与取消订阅；
- Tool Registry已注册工具调用；
- 管理页面路由及默认答疑路由；
- 可注入的Pi兼容Agent Runtime。

这些测试只证明脚手架行为，不代表目标系统的安全边界已经完成。

M1新增路径安全、知识发布、Pi资料规划器和资料导入API测试。M2新增 active release 检索、Pi 课程答疑工具/引用契约、会话/SSE API、前端 SSE 分帧，以及 DDGS 结果归一化、进程协议、网页证据和受控网页读取测试；普通测试使用Pi faux provider，不调用DeepSeek或公网。

## 测试分层

| 层级 | 关注点 | 是否允许真实外部依赖 |
|---|---|---|
|单元测试|Schema、状态转换、评分计算、路径规则|不允许|
|Service集成测试|临时Workspace、SQLite、原子发布、恢复|允许本地临时文件和内存/临时数据库|
|Agent契约测试|工具可见性、输入输出Schema、引用要求|使用确定性假模型|
|API/Channel测试|鉴权、验签、去重、错误映射|使用录制或构造请求|
|验收测试|冻结资料、固定Prompt和批量fixture|仅在明确标记的环境运行真实Provider|

普通`npm test`不得要求模型密钥、企业微信账户或公网连接。

课程答疑测试必须断言：staging 与跨课程内容不可读、引用已读取且落在 active release 内、资料不足不带引用、网络引用来自本会话已搜索且已读取的结果、以及 SSE 工具活动不包含推理、Prompt、原文、绝对路径或密钥。网页读取测试还必须覆盖私网地址与重定向拦截。

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

定向测试：

```powershell
npm test -- --run tests/core.test.ts
```

完整检查：

```powershell
npm run check
npm run build
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
