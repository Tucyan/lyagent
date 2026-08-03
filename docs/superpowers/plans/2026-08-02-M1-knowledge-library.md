# M1：课程资料库导入、发布与浏览

## 目标

交付本地 Web 管理端：创建课程、上传目录中的 Markdown、由 Pi/DeepSeek 规划知识树、预览草稿、发布不可变版本并回滚。当前资料目录不含图片；图片语义理解不属于 M1。

## 实施清单

- [x] 以失败测试实现受控文件系统，拒绝路径逃逸和 reparse point。
- [x] 实现课程、导入、章节覆盖、草稿、manifest、原子发布、active 指针和回滚服务。
- [x] 实现 Pi `submit_knowledge_plan` 单工具规划器及 `fauxProvider` 契约测试。
- [x] 实现 Fastify 课程/导入/草稿/发布/回滚 API 和 React/Vite 管理端。
- [x] 配置 DeepSeek `deepseek-v4-flash`；密钥仅来自`DEEPSEEK_API_KEY`。
- [x] 使用真实资料执行一次临时工作区 DeepSeek 验证：5 个文件、221 个章节、17 个草稿文档。
- [x] 由用户执行浏览器验收，并确认 M1 完成。

## 验证命令

```powershell
npm run check
npm run build
npm run start
```

## 范围约束

- Agent只能提交章节到目标 Markdown 的映射，不能自由写文件、指定业务ID或发布版本。
- 文件、manifest、链接校验、发布和 active 切换由服务端确定性执行。
- 正式 DeepSeek 调用是显式导入操作；普通测试使用假 Provider，不访问公网。
