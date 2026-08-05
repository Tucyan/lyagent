# M5 Concurrent Batch Grading Implementation Plan

**Goal:** Add a dedicated batch-grading workspace for 30–120 submissions with configurable local concurrency, pause/resume, question handling, bounded retry, restart reconciliation, and deterministic class CSV export.

**Architecture:** Keep M4 sessions and conversations as the per-submission execution boundary. Add a SQLite-backed batch/job coordinator with transactional leases and one `PQueue` per active batch. Successful grading drafts are copied into immutable-by-job review snapshots; Markdown and class CSV are derived from those JSON snapshots. The dedicated `/grading/batches` page uploads reports through the existing controlled upload API, then operates the batch APIs.

**Tech stack:** TypeScript ESM, Fastify, better-sqlite3, p-queue, React, Vitest.

---

### Task 1: Define persistent state and transition contracts

**Files:**
- Create: `tests/grading-state-machine.test.ts`
- Create: `src/services/grading-batch-service.ts`

1. Write failing tests for 30–120 membership, `(batchId, sessionId)` uniqueness, legal transitions, claim leases, renewal, and retry limits.
2. Run the focused test and verify it fails because the service/schema is absent.
3. Add idempotent SQLite tables, mappings, validation, transactional claims, renewal, and explicit transition guards.
4. Re-run until the focused tests pass.

### Task 2: Implement bounded concurrent scheduling

**Files:**
- Modify: `tests/grading-run-service.test.ts`
- Create: `tests/grading-concurrency.test.ts`
- Modify: `src/services/grading-run-service.ts`
- Modify: `src/services/grading-batch-service.ts`

1. Write failing tests proving configured concurrency, pause semantics, waiting/failure slot release, and isolation.
2. Make `GradingRunService` accept bounded concurrency and add per-batch `PQueue` scheduling.
3. Claim only when a queue task starts; pause prevents new claims while running work settles.
4. Re-run focused tests and refactor only after green.

### Task 3: Add recoverable JSON/Markdown results and summary CSV

**Files:**
- Create: `tests/grading-recovery.test.ts`
- Create: `tests/summary-service.test.ts`
- Create: `src/services/grading-summary-service.ts`
- Modify: `src/services/grading-batch-service.ts`

1. Write failing tests for the three crash windows and deterministic summary rebuilding.
2. Write one controlled JSON snapshot per successful job and derive its Markdown preview.
3. Reconcile valid snapshots or persisted drafts before scheduling model work.
4. Rebuild UTF-8 BOM CSV through a single serialized writer and verify counts/hashes.

### Task 4: Expose batch APIs

**Files:**
- Create: `tests/grading-batch-api.test.ts`
- Modify: `src/api/grading-routes.ts`
- Modify: `src/api/server.ts`

1. Write failing API tests for create/list/detail/start/pause/resume/answer/retry/export.
2. Register the batch coordinator beside the existing grading services and map safe domain errors.
3. Ensure shutdown closes batch scheduling before underlying run/session services.
4. Re-run API and existing M4 regression tests.

### Task 5: Build the separate batch page and entry

**Files:**
- Create: `tests/grading-batch-page-model.test.ts`
- Create: `web/src/pages/grading-batch-page-model.ts`
- Create: `web/src/pages/GradingBatchPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/AdminShell.tsx`
- Modify: `web/src/styles.css`

1. Write failing page-model/router tests for progress, actions, and the dedicated route.
2. Add multi-file batch creation, rubric/concurrency controls, progress cards, pause/resume, question answer, retry, and CSV export.
3. Add a visible “批量批改” navigation entry while keeping `/grading` unchanged.
4. Run frontend typecheck and focused tests.

### Task 6: Synthetic acceptance and documentation

**Files:**
- Create: `scripts/generate-batch-grading-fixtures.ts`
- Create: `tests/fixtures/batch-grading/README.md`
- Create: `tests/grading-batch-acceptance.test.ts`
- Create: `docs/acceptance/M5-batch-grading.md`
- Modify: `.docs/architecture.md`
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/testing.md`
- Modify: `docs/superpowers/plans/2026-08-02-course-agent-milestones.md`

1. Generate deterministic, synthetic, non-sensitive Markdown submissions.
2. Run 120 fake jobs and assert exactly 120 JSON snapshots, 120 Markdown previews, and 120 CSV data rows.
3. Test restart, question, failure/retry, and zero repeated calls for valid results.
4. Run full checks/build, then start port 3001 and complete browser interaction with at least 30 files and concurrency 4.
5. Record evidence in the M5 acceptance document and move only the M5 status cell to `ready_for_user_test`; do not alter its description or mark it accepted.

