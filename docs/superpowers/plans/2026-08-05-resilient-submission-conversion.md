# Resilient Submission Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document conversion failures explainable and recoverable without weakening immutable-upload or content-safety boundaries.

**Architecture:** Extend the program-owned conversion state in SQLite with safe structured failure metadata. Classify errors inside `SubmissionConversionService`, automatically retry only transient converter availability failures with bounded exponential delays, and surface status-specific actions through the existing grading API and React workspace.

**Tech Stack:** TypeScript ESM, Fastify, SQLite/`better-sqlite3`, React, Vitest.

---

### Task 1: Persist conversion states and safe failure metadata

**Files:**
- Modify: `src/services/grading-session-service.ts`
- Modify: `tests/grading-session-service.test.ts`

- [x] Add failing tests showing sessions can persist `waiting_for_converter`, `conversion_failed`, and `result_rejected`, plus safe code/message/retryability/attempt/last-failure metadata.
- [x] Add a migration for the new columns and verify old databases migrate idempotently.
- [x] Add service transitions that clear stale error metadata when retrying or completing.
- [x] Run `npm test -- --run tests/grading-session-service.test.ts` and expect PASS.

### Task 2: Classify failures and retry transient outages

**Files:**
- Modify: `src/services/mineru-client.ts`
- Modify: `src/services/submission-conversion-service.ts`
- Modify: `tests/mineru-client.test.ts`
- Modify: `tests/submission-conversion.test.ts`

- [x] Add failing tests for connection/timeout/5xx classification as retryable converter unavailability.
- [x] Add failing tests for explicit task failure and unsafe/invalid result classification as non-retryable.
- [x] Add deterministic injected scheduling tests for bounded exponential delays and retry exhaustion.
- [x] Implement minimal classification and retry behavior; keep task resubmission idempotent and reuse the immutable original.
- [x] Run both focused test files and expect PASS.

### Task 3: Expose safe conversion status through the API

**Files:**
- Modify: `src/api/grading-routes.ts`
- Modify: `tests/grading-api.test.ts`

- [x] Add failing tests that session detail/list responses include only safe structured conversion failure metadata.
- [x] Add failing tests for manual retry eligibility and conflicts for non-retryable safety rejection.
- [x] Implement restart recovery for waiting sessions and preserve the existing post-ready naming/grading hook.
- [x] Run `npm test -- --run tests/grading-api.test.ts` and expect PASS.

### Task 4: Render status-specific teacher guidance

**Files:**
- Modify: `web/src/pages/grading-page-model.ts`
- Modify: `web/src/pages/GradingPage.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/grading-page-model.test.ts`

- [x] Add failing model tests mapping each state/error to its label, explanation, and allowed action.
- [x] Render waiting, failed, and rejected states distinctly; retain session delete and manual retry where allowed.
- [x] Explain that the immutable original is safe and that replacement creates a new submission rather than overwriting it.
- [x] Run focused frontend model tests and typecheck.

### Task 5: Documentation and final acceptance

**Files:**
- Modify: `.docs/architecture.md`
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/operations-and-security.md`
- Modify: `.docs/testing.md`

- [x] Document the state machine, retry boundary, persisted safe error fields, and operational dependency on MinerU.
- [x] Run `npm run check`, `npm run build`, and `git diff --check`.
- [x] Restart port 3001 with the bundled Node runtime and verify the grading page behavior in the in-app browser.

## Self-review

- Spec coverage: includes state classification, safe persistence, bounded automatic retry, manual actions, immutable originals, blocking grading/title discovery, docs, and browser acceptance.
- Placeholder scan: no deferred implementation placeholders.
- Type consistency: the same three terminal/nonterminal conversion states and error metadata are used across storage, service, API, and UI tasks.
