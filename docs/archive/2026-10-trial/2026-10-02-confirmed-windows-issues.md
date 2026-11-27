# Confirmed Windows Issues Implementation Plan

> **For agentic workers:** Execute this user-authorized repair sequentially in the current session; use failing regression tests before each behavior change.

**Goal:** 修复已确认的问题 2、3、4、6、8、9、10、11，不扩展平台范围或进入新里程碑。

**Architecture:** 保持 Agent/Tool/Service 边界；程序负责警告确认、转换状态、执行预算和并发。SSE 断连继续后台任务的既定行为保持不变。临时基础设施故障耗尽自动重试后进入可手动重试、可删除的失败终态。

**Tech Stack:** Windows、TypeScript ESM、Pi SDK、Fastify、SQLite、Vitest。

## 顺序与验证

- [x] **2 — 重复警告冻结**：在 `tests/rubric-versioning.test.ts` 增加三个 continuous criterion 无 anchors 的冻结用例；`src/services/rubric-service.ts` 对所需 code 去重，保留缺失/多余确认拒绝。运行 `npm test -- --run tests/rubric-versioning.test.ts`，先失败后通过。
- [x] **3 — 转换耗尽清理**：更新 `tests/submission-conversion.test.ts` 的耗尽断言，增加失败会话删除、手动重试和旧 waiting 状态恢复；更新 `src/services/submission-conversion-service.ts`、`src/services/grading-session-service.ts`、`web/src/pages/grading-page-model.ts`。耗尽使用 `conversion_failed`，仅基础设施失败允许手动重试；活动转换仍不可删除。运行 `npm test -- --run tests/submission-conversion.test.ts tests/grading-session-service.test.ts tests/grading-page-model.test.ts`，先失败后通过。
- [x] **4 — Agent 执行预算**：创建 `src/core/agent-execution-budget.ts` 与 `tests/agent-execution-budget.test.ts`，为各 Pi Agent 的单次业务运行统一限制模型轮次、工具调用和总时长；错误与超时直接终止，显式取消仍有效。预算覆盖评分表续问和 fallback，不能每次 prompt 重置。在 `tests/rubric-agent.test.ts` 用异常 faux provider 回归失败工具循环。运行预算和各 Agent 定向测试，先失败后通过。
- [x] **6 — SQLite 忙轮询**：在 `tests/grading-run-service.test.ts` 用受控运行断言等待次数；`src/services/grading-run-service.ts` 将 5ms 改为 100ms 且不超过剩余 deadline，保持终态与超时语义。运行 `npm test -- --run tests/grading-run-service.test.ts`，先失败后通过。
- [x] **8 — 安全具体错误**：在 `tests/rubric-api.test.ts` 验证小数精度、空来源和冻结确认错误；`src/services/rubric-service.ts` 提供稳定安全错误 code/message，`src/api/server.ts` 返回该公共错误，不将含路径/来源的内部错误直接传给前端。运行 `npm test -- --run tests/rubric-api.test.ts`，先失败后通过。
- [x] **9 — 确认版本**：在 `tests/grading-result-service.test.ts` 验证已确认结果错误版本返回冲突；`src/services/grading-result-service.ts` 在恢复幂等确认前校验 confirmed.version，同版本重试仍修复派生文件。运行 `npm test -- --run tests/grading-result-service.test.ts`，先失败后通过。
- [x] **10 — README**：创建根 `README.md`，描述 Windows 软件用途，链接 `.docs/development.md` 的开发命令与 `.docs/README.md`，不复制配置与架构细节。
- [x] **11 — 会话写锁**：创建 `tests/session-service.test.ts`，用受控暂停读快照测试 append/append、append/rename、append/delete；在 `src/services/session-service.ts` 对同 course/session 的读改写和删除串行化，保持课程隔离与最多 20 条消息。
- [x] **文档与交付**：同步 `.docs/domain-and-storage.md`、`.docs/architecture.md`、`.docs/testing.md` 的当前事实；检查 Markdown 本地链接、代码围栏与 `git diff --check`；运行 `npm run check`、`npm run build`。不自动提交或推送。

## 验证结果

- Windows：`npm run check`通过，562项通过、2项跳过；`npm run build`通过。
- Markdown本地链接和代码围栏检查通过；`git diff --check`通过。
- 各行为修复均验证失败测试后通过回归；Linux问题和SSE断连生命周期不改变。
- 未提交或推送；本轮之外出现的`tests/ux-audit.test.ts`未修改。
