# Batch Grading Review Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add score/confidence/action columns to batch grading and provide a dedicated, editable, resizable batch Review workspace with retry and formal confirmation.

**Architecture:** Keep the grading JSON draft as the source of truth. Batch detail responses enrich each job from the current session draft/confirmed result instead of duplicating scores in SQLite; batch-scoped retry and confirmation endpoints validate batch/job ownership and reuse the existing grading result service. The new SPA route `/grading/batches/review?batch=…&session=…` loads one batch plus one session, renders a resizable report/result split, and uses the existing optimistic draft and confirmation contracts.

**Tech Stack:** TypeScript ESM, Fastify, SQLite/better-sqlite3, React, react-markdown, Vitest, CSS pointer-resize UI.

---

### Task 1: Enrich batch jobs with review summaries

**Files:**
- Modify: `src/services/grading-batch-service.ts`
- Test: `tests/grading-state-machine.test.ts`

- [ ] Add a failing service test where `readResult()` returns a validated result and assert `getBatch().jobs[0]` contains `score`, `confidence`, `reviewStatus`, `reviewReasons`, and `resultVersion`.
- [ ] Run `npm test -- --run tests/grading-state-machine.test.ts` and verify the new assertion fails because job summaries are absent.
- [ ] Extend `GradingBatchJob` with optional review summary fields and have `getBatch()` enrich jobs from `dependencies.readResult(job.sessionId)` without adding database columns.
- [ ] Re-run the test and verify it passes.

### Task 2: Support batch-scoped retry and formal confirmation

**Files:**
- Modify: `src/services/grading-batch-service.ts`
- Modify: `src/services/grading-session-service.ts`
- Modify: `src/api/grading-routes.ts`
- Test: `tests/grading-state-machine.test.ts`
- Test: `tests/grading-session-service.test.ts`
- Test: `tests/grading-api.test.ts`

- [ ] Add failing tests proving a `needs_review` job below its attempt limit can be requeued, its reserved session can transition from `needs_review` to `queued`, and a batch/job mismatch is rejected.
- [ ] Add a failing API test for `POST /api/grading/batches/:batchId/jobs/:jobId/confirm` that confirms the current draft and synchronizes the job to `completed`.
- [ ] Run the targeted tests and verify they fail on the missing transitions/endpoint.
- [ ] Extend `retryJob()` to accept `failed` or `needs_review`, preserving the existing three-attempt bound. Allow `lockSubmissionForGrading(..., {allowBatchReservation:true})` to queue `draft_ready`/`needs_review` sessions.
- [ ] Implement the batch confirmation endpoint using the existing confirm schema/result service, validate job ownership, and refresh the batch snapshot/status after confirmation.
- [ ] Re-run the targeted tests and verify they pass.

### Task 3: Add score, confidence, retry, confirm, and Review controls to the batch page

**Files:**
- Modify: `web/src/pages/grading-batch-page-model.ts`
- Modify: `web/src/pages/GradingBatchPage.tsx`
- Test: `tests/grading-batch-page-model.test.ts`
- Test: `tests/grading-batch-page-source.test.ts`

- [ ] Add failing model/source tests for score/confidence formatting, Review route generation, table headings, and both action buttons.
- [ ] Run the targeted tests and verify the missing exports/markup fail.
- [ ] Add `formatBatchScore`, `formatBatchConfidence`, and `batchReviewHref`. Render score/confidence columns, a direct formal confirm action with all displayed review reasons acknowledged, and retry for eligible `failed`/`needs_review` jobs.
- [ ] Place a `Review` button below the batch controls/counts and preserve in-app navigation semantics.
- [ ] Re-run the targeted tests and verify they pass.

### Task 4: Build the dedicated Review workspace

**Files:**
- Create: `web/src/pages/GradingBatchReviewPage.tsx`
- Create: `web/src/pages/grading-batch-review-page-model.ts`
- Modify: `web/src/pages/GradingPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/grading-batch-review-page-model.test.ts`
- Test: `tests/model-settings-page-model.test.ts`

- [ ] Add failing tests for parsing `batch`/`session`, defaulting to the first reviewable job, clamping the split between 25% and 75%, route registration, popstate synchronization, session score/confidence cards, editor controls, and bottom Confirm/Retry actions.
- [ ] Run the targeted tests and verify the new module/route is absent.
- [ ] Implement the Review page: batch-session sidebar, selected report rendered with controlled asset URLs, pointer-draggable divider, editable structured decisions with required audit note, optimistic draft save, formal confirm, and retry.
- [ ] Export/reuse the existing `DecisionCards` and `DecisionEditor` from `GradingPage.tsx` so grading rules are edited consistently in both pages.
- [ ] Register `/grading/batches/review` in the SPA and make batch/session changes use History API with browser back/forward support.
- [ ] Add responsive CSS that stacks panels on narrow screens while keeping the desktop divider accessible by pointer and keyboard.
- [ ] Re-run the targeted tests and verify they pass.

### Task 5: Document current behavior and verify end-to-end

**Files:**
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/architecture.md`
- Modify: `.docs/testing.md`

- [ ] Document that retry creates a new bounded batch attempt while retaining the prior immutable attempt snapshot, confirmation creates the formal result, and teacher edits remain versioned/audited drafts.
- [ ] Run `npm run check`, `npm run build`, and `git diff --check` and require zero failures.
- [ ] Use the local browser against `http://localhost:5173` to verify the batch table, Review navigation, sidebar switching, draggable split, teacher edit/save, retry, confirmation, and browser back/forward with synthetic data only.
