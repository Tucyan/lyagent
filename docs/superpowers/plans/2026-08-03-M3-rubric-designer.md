# M3 Rubric Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可创建、设计、校验、冻结和回退加分/减分/混合评分表的 Web Agent。

**Architecture:** Assignment、草稿和冻结版本由RubricService经受控Workspace保存；Zod Schema和Service掌握总分、版本、哈希与幂等规则。Pi Agent只通过受限工具读取上下文和提交结构化草稿Patch；React页面复用答疑页的会话体验并新增可拖动预览栏。

**Tech Stack:** TypeScript ESM、Fastify、Pi SDK、DeepSeek、Zod、React/Vite、Vitest。

---

### Task 1: 评分表 Schema 与确定性校验

- [x] 为加分、减分和混合制写失败测试。
- [x] 实现Schema、分数计算、等级区间和重叠组校验。
- [x] 运行Schema测试并确认通过。

### Task 2: Assignment、草稿与冻结版本

- [x] 为创建、乐观并发、冻结、哈希、历史复制写失败测试。
- [x] 实现受控来源存储、草稿Patch、原子冻结和Markdown渲染。
- [x] 运行Service与版本测试并确认通过。

### Task 3: 评分表 Agent 与 HTTP/SSE API

- [x] 为模式推荐、无来源零模型调用、Agent工具限制和API状态流写失败测试。
- [x] 实现推荐、草稿设计、结构化问题和受控路由。
- [x] 运行Agent/API测试并确认通过。

### Task 4: 三栏评分表页面

- [x] 为页面状态和预览模型写失败测试。
- [x] 实现会话侧栏、制度门、聊天、结构化编辑、可调整/放大预览和版本历史。
- [x] 执行浏览器验收并记录M3验收文档。

### Task 5: 交付验证

- [x] 运行`npm run check`和`npm run build`。
- [x] 更新长期文档和M3验收记录，等待用户确认里程碑。
