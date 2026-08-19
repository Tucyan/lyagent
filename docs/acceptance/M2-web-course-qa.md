# M2：Web 课程答疑验收

## 启动

在`workspace/config/app.json`中配置本机 DeepSeek key 后运行：

```powershell
npm run build
npm run start
```

打开 <http://127.0.0.1:3000/qa>。

## 验收步骤

1. 先选择一个尚无 active release 的课程，确认下拉框保持选中且输入框明确提示“当前课程尚未发布资料”，而不是提示未选择课程；再选择一个已有 active release 的课程，确认首页提示仅依据已发布资料回答。
2. 提问一个资料内问题，确认工具活动显示安全的检索/阅读步骤，回答逐段出现，并带文件名和行号引用。
3. 展开“资料检索过程”，确认不显示模型推理、Prompt、原文、绝对路径或密钥。
4. 点击引用，确认右侧原文抽屉展示对应的当前发布资料和行范围。
5. 提问资料外问题，确认显示资料不足且不带引用。
6. 在生成中点击“停止生成”，确认页面显示未保存提示，刷新会话后没有该未完成回答。
7. 创建另一门课程并提问，确认无法读取前一门课程资料。
8. 切换 active release 后新建会话，确认新会话使用新版本；旧会话保留原记录。

## 自动化证据

- `tests/knowledge-search.test.ts`：active release 隔离、目录、检索、行范围和路径限制。
- `tests/course-qa.test.ts`：Pi faux provider 工具许可、已读引用和安全事件。
- `tests/course-qa-api.test.ts`：会话、SSE、最终持久化、无 release/无模型拒绝和摘要。
- `tests/course-qa-page-model.test.ts`：未选课程、加载中、无 active release、无模型与可提问状态的准确输入提示。
- `tests/consume-sse.test.ts`：前端 POST SSE 分帧解析。
- `tests/fixtures/course-qa/questions.json`：30 条可回答及 10 条资料不足的合成验收问题清单。

## 用户结论

- 状态：accepted
- 测试人：
- 测试日期：
- 备注：
