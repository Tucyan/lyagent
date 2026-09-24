# Project Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-09-23 全项目 review 中确认的成绩完整性、知识版本完整性、网页读取安全、上传资源限制及前端/开发配置问题，并完成第二轮 review。

**Architecture:** 保留现有 Agent、Service、Workspace 与 API 边界。成绩和知识完整性由 Service 校验；HTTP 流量与上传大小在读取时限制；前端恢复状态由受控请求归属管理。所有行为修复先用合成数据写失败回归测试，再作最小修改。

**Tech Stack:** TypeScript ESM、Fastify、React、SQLite、Vitest、Vite、Windows PowerShell。

---

## 完成记录（2026-09-24）

三个任务已依次实现并通过逐组符合性、代码质量复审。第二轮全项目只读 review 发现的提交/替换、旧草稿恢复失败、API Host/Origin、嵌套文件系统根与目录枚举问题均已修复并重新复审。测试 TLS 私钥改为测试进程内生成，仓库未保留 PEM 私钥。

- 最终 `npm run check` 退出码 0：78 个测试文件通过、2 个跳过；534 项测试通过、2 项跳过。`npm run build` 退出码 0。
- `git diff --check` 退出码 0；修改的 Markdown 链接和代码围栏检查通过。工作区仍在 `codex/concurrent-grading`，改动尚未提交。
- 30 份报告 API 集成测试在完整套件下曾超过原 15 秒上限，隔离计时约 10 秒且波动较大；测试专用时限与已有 120 份验收测试一致调整为 30 秒，最终全量检查通过。
- 剩余安全边界：有权并发改写 Workspace 或祖先目录的同用户本地进程，仍可能利用 Node 路径式写入、移动、删除操作的检查与使用间隙；当前运行前提、可兑现的 realpath/文件句柄防护与未来 native/隔离方案已写入安全文档。

---

## 执行顺序与边界

- 三个实现任务依次执行，不能并发修改共享工作区。每个任务先做符合性 review，再做代码质量 review；发现问题先修复并重新 review。
- 当前分支为 `codex/concurrent-grading`，起始工作区干净；不触碰未来 M6/M7 产品功能。
- 长命令或下载最多尝试三次；本计划不需要下载。所有测试使用合成资料，不读取真实学生数据或密钥。
- 对每项行为修复同步维护对应 `.docs` 当前事实与测试边界；不修改里程碑验收状态。

## Task 1：成绩、上传与知识版本完整性

**Files:** `web/src/pages/GradingBatchPage.tsx`, `src/services/grading-batch-upload-service.ts`, `src/services/grading-result-service.ts`, `src/services/material-service.ts`, `src/services/knowledge-service.ts`, `tests/grading-batch-page-model.test.ts`, `tests/grading-batch-upload-service.test.ts`, `tests/grading-result-service.test.ts`, `tests/knowledge-release.test.ts`, `tests/knowledge-search.test.ts`, `.docs/domain-and-storage.md`, `.docs/testing.md`。

- [x] 为批次列表的确认入口增加可执行失败测试：待复核 job 不能通过列表按钮自动把 `reviewReasons` 全部声明已确认；教师须在 Review 页看到原因、填写备注并逐项确认。运行 `npm test -- --run tests/grading-batch-page-model.test.ts` 观察预期失败。
- [x] 为替换已有 `ready` 上传项写失败测试：新 Markdown 缺失附件时，原 session、文件和 `ready` 状态保持可用；只有新文件及附件全部通过验证后才切换。运行 `npm test -- --run tests/grading-batch-upload-service.test.ts` 观察预期失败。
- [x] 为已确认结果写失败测试：修改 JSON 的分数而保留旧 `resultHash` 后，读取、恢复和 CSV 均拒绝使用该文件；完整有效结果仍可读。运行 `npm test -- --run tests/grading-result-service.test.ts` 观察预期失败。
- [x] 为活动知识版本写失败测试：发布后改写 release 正文或元数据但保留 `active.json`，答疑读取必须拒绝；正常发布与回滚仍可读。运行 `npm test -- --run tests/knowledge-release.test.ts tests/knowledge-search.test.ts` 观察预期失败。
- [x] 对各 Service 和 UI 作最小修复，保留现有数据格式、受控路径和错误码风格。禁止依赖 Agent 判断确认状态或文件哈希。
- [x] 运行上述定向测试及相关 API/CSV/恢复测试，核对 `.docs/domain-and-storage.md` 和 `.docs/testing.md` 的当前事实。

## Task 2：网页读取和附件上传资源边界

**Files:** `src/services/safe-web-fetcher.ts`, `src/api/grading-routes.ts`, `src/services/grading-session-service.ts`, `tests/safe-web-fetcher.test.ts`, `tests/grading-api.test.ts`, `.docs/operations-and-security.md`, `.docs/testing.md`。

- [x] 写失败回归测试：模拟 DNS 检查得到公网 IP、连接阶段 DNS 改为私网 IP；请求必须拒绝连接。每次重定向使用同一校验规则。运行 `npm test -- --run tests/safe-web-fetcher.test.ts` 观察预期失败。
- [x] 写失败回归测试：`Content-Length` 缺失时，无限或超限分块响应不能被完整缓冲；读取到上限立即取消，长度头小于实际大小也不能绕过。运行同一测试文件观察预期失败。
- [x] 写失败回归测试：多附件总量超过 50 MiB 时，路由在持续缓冲其余文件前拒绝；保持单文件 10 MiB、文件数及合法共享附件行为。运行 `npm test -- --run tests/grading-api.test.ts` 观察预期失败。
- [x] 实现校验 IP 与实际连接绑定、每跳重定向重新校验、流式响应上限，以及 multipart 读取过程中的总量限制。不要放宽 HTTPS 或现有 Workspace 规则。
- [x] 运行上述定向测试及 `tests/course-qa-api.test.ts`、`tests/grading-batch-upload-service.test.ts`，更新运行安全与测试文档。

## Task 3：前端恢复、开发端口与测试配置

**Files:** `web/src/pages/GradingBatchPage.tsx`, `web/src/lib/async-state.ts`, `src/main.ts`, `src/dev.ts`, `web/vite.config.ts`, `tsconfig.json`, `tests/grading-batch-page-model.test.ts`, `tests/frontend-async-state.test.ts`, `tests/dev-port-config.test.ts`, `.docs/development.md`, `.docs/testing.md`。

- [x] 写失败回归测试：批次上传草稿恢复请求在途时，由 rubric、批次列表或详情引起的重渲染不能清空恢复 ID；有效响应必须显示同一草稿。测试应执行真实状态转换，不仅检查源码字符串。运行定向测试观察预期失败。
- [x] 写失败回归测试：仅设置 `COURSE_AGENT_API_PORT=3011` 时，开发 API 监听端口与 Vite 代理目标同为 3011；`PORT` 的优先级要明确并测试。运行 `npm test -- --run tests/dev-port-config.test.ts` 观察预期失败。
- [x] 让 `tests/rubric-preview.test.tsx` 纳入 TypeScript 检查；若服务端 tsconfig 不支持 JSX，使用单独测试 tsconfig，不改变生产编译输出。用 `npm run typecheck` 验证。
- [x] 最小修复前端请求归属和端口配置，确保草稿提交、取消及切换仍清理正确 ID；更新开发和测试文档。
- [x] 运行相关定向测试、`npm run typecheck` 与 `npm run build`。

## 最终验收与第二轮 review

- [x] 在全部实现与逐任务 review 结束后运行 `npm run check` 和 `npm run build`；分别记录退出码、通过及跳过数量。
- [x] 检查 `git diff --check`、改动范围和文档链接/代码围栏；确认没有凭据、学生正文或构建产物进入仓库。
- [x] 启动新的只读 subagents，分别复核领域/数据一致性、安全/资源边界、前端/构建，尤其检查修复是否引入回归；对发现的问题继续修复并重新验证。
- [x] 向用户报告修复、测试、第二轮 review 结论及仍需注意的限制。

## SafeFilesystem 竞态边界

- 本轮受控收敛：对现有路径段检查 `realpath` containment；文件读取由已打开的 `FileHandle` 校验并读取；知识 staging/release 文件和目录枚举统一经过 Workspace 根上的 `SafeFilesystem`。
- 这些措施覆盖静态路径重定向和打开后的路径替换，不承诺阻止有权并发改写 Workspace 或祖先目录的本地进程。路径式 JavaScript API 的验证与操作不是原子事务。
- 如未来威胁模型必须防范该类并发本地攻击，需要评估 native handle-relative 文件系统 helper，或把 Workspace 写入移到隔离进程/账户与受限 ACL；设计完成前不得把纯 JS 复检描述为竞态安全。
