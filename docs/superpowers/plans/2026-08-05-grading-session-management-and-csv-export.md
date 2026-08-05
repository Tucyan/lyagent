# Grading Session Management and CSV Export Implementation Plan

> **For Codex:** Execute this plan task-by-task with test-driven development. Keep Agent access scoped to the current submission and keep CSV calculation program-owned.

**Goal:** Add student-specific assignment titles, automatic Agent naming, rubric-filtered grading sessions, inline session creation, configurable CSV batch exports, and session rename/delete.

**Architecture:** Preserve `GradingSession.title` as the editable conversation name and add `submissionTitle` plus a program-controlled resolution status. A dedicated naming Agent reads the current converted submission and original filename through controlled tools, then must terminate through `set_submission_title` when the title was omitted. Confirmed grading JSON remains the export source; a deterministic service renders CSV for either a student scope or an exact frozen-rubric scope.

**Tech Stack:** TypeScript ESM, Fastify, better-sqlite3, React, Vitest, controlled workspace filesystem, Pi Agent/DeepSeek provider.

---

## Task 1: Persist student-specific assignment titles

**Files:**
- Modify: `src/services/grading-session-service.ts`
- Test: `tests/grading-session-service.test.ts`

1. Add failing tests that create a session with a manual `submissionTitle`, restore it after reopening SQLite, and verify older databases migrate with no data loss.
2. Add `submission_title` and `submission_title_status` columns with an idempotent versioned migration.
3. Extend `GradingSession` and `createSession` validation. Use `provided` for a manual title and `pending` when omitted.
4. Add controlled methods to read the original filename and atomically resolve/fail a pending title.
5. Run `npm test -- --run tests/grading-session-service.test.ts`.

## Task 2: Add and enforce the assignment-naming Agent tool

**Files:**
- Create: `src/agents/submission-namer/agent.ts`
- Create: `src/agents/submission-namer/deepseek.ts`
- Create: `src/services/submission-title-service.ts`
- Modify: `src/tools/grading/index.ts`
- Modify: `src/agents/assignment-grader/agent.ts`
- Modify: `src/api/grading-routes.ts`
- Modify: `src/main.ts`
- Test: `tests/grading-tools.test.ts`
- Create test: `tests/submission-title-service.test.ts`
- Modify: `tests/grading-api.test.ts`

1. Add failing tool-contract tests for `set_submission_title` schema, safe activity text, one-call-only behavior, and server-owned persistence.
2. Add failing service tests proving omitted titles require the naming terminal tool, body candidates beat filename candidates, manual titles skip the Agent, and failures persist a recoverable status.
3. Implement a dedicated naming run with only controlled submission listing/search/line reading plus original-filename reading and `set_submission_title`.
4. Inject a naming factory through the API/main wiring. For deterministic test environments, use a fake naming Agent; do not silently guess in program code when the model is configured.
5. Invoke the naming workflow immediately for ready Markdown and after MinerU conversion for other formats. Do not start grading until required naming has completed or failed visibly.
6. Include naming tool activity in the session conversation without exposing raw content, prompts, or reasoning.
7. Run the focused tool, title-service, conversion, API, and Agent tests.

## Task 3: Filter, rename, and delete grading sessions

**Files:**
- Modify: `src/services/grading-session-service.ts`
- Modify: `src/api/grading-routes.ts`
- Modify: `src/services/grading-run-service.ts` if active-run guards are needed
- Test: `tests/grading-session-service.test.ts`
- Test: `tests/grading-api.test.ts`

1. Add failing tests for exact `assignmentId + rubricVersion` filtering, trimmed rename with length validation, not-found behavior, active-run deletion rejection, and complete scoped cleanup.
2. Add `listSessions({assignmentId, rubricVersion})`, `renameSession`, and `deleteSession` service methods.
3. Delete only the session's controlled submission and result directories after validating IDs from the stored row; use one service lock/transaction boundary and preserve the shared rubric.
4. Add query validation plus `PATCH /api/grading/sessions/:id` and `DELETE /api/grading/sessions/:id`.
5. Run focused service/API tests.

## Task 4: Build deterministic configurable CSV export

**Files:**
- Create: `src/services/grading-csv-export-service.ts`
- Modify: `src/api/grading-routes.ts`
- Create test: `tests/grading-csv-export-service.test.ts`
- Test: `tests/grading-api.test.ts`

1. Add failing tests for both scopes: every confirmed assignment for one `courseId + studentNumber`, and every confirmed student session for one exact frozen rubric.
2. Add failing column tests for student name, student number, assignment title, item details, optional per-item confidence, total score, and overall confidence.
3. Define stable detail columns from frozen rubric order, render score/deduction/bonus values without recalculation, add UTF-8 BOM and RFC 4180 escaping, and neutralize spreadsheet formula prefixes.
4. Reject empty column selections and exclude unconfirmed sessions deterministically.
5. Add `POST /api/grading/exports/csv` returning `text/csv` with a safe filename.
6. Run focused CSV and API tests.

## Task 5: Redesign the grading workspace interaction

**Files:**
- Modify: `web/src/pages/GradingPage.tsx`
- Modify: `web/src/pages/grading-page-model.ts`
- Modify: `web/src/styles.css`
- Test: `tests/grading-page-model.test.ts`

1. Add failing pure-model tests for rubric keys, URL/session selection behavior, export-option normalization, local-storage serialization, and nested confidence enablement.
2. Move the frozen-rubric selector to the top of the left sidebar and fetch/filter sessions by the exact selected version.
3. Replace the modal with an inline new-session panel in the conversation workspace. Use the selected sidebar rubric implicitly and add an optional assignment-title field.
4. Show resolved/pending title status in the session/detail UI.
5. Add conversation rename and delete actions with explicit confirmation and refresh/navigation behavior.
6. Add an export panel whose selections are cached in browser local storage. Support current student's complete grading history and current frozen rubric's complete student set.
7. Preserve streaming conversation behavior and final collapse of process/tool steps.
8. Run model tests and web typecheck/build.

## Task 6: Documentation, recovery, and acceptance verification

**Files:**
- Modify: `.docs/architecture.md`
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/testing.md`
- Modify: `.docs/operations-and-security.md`
- Modify: `docs/superpowers/plans/2026-08-02-course-agent-milestones.md` only if its accepted M4 behavior list must reflect the extension

1. Document the title/session-name distinction, naming-tool enforcement, schema migration, deletion scope, exact-rubric filtering, CSV scopes/columns, and formula-injection handling.
2. Add or update recovery tests showing pending title resolution resumes safely and repeated startup does not duplicate Agent calls.
3. Run all focused grading tests.
4. Run `npm run check` and `npm run build` and inspect the actual output.
5. Restart the main app on port 3001 so it reloads config and the new build.
6. Use the in-app browser to verify inline creation, sidebar filtering, title status, rename/delete confirmation, cached export choices, CSV download, and existing streamed grading presentation.

## Self-review notes

- This plan deliberately separates report title from conversation title to avoid breaking existing session headings and rename semantics.
- Automatic naming is a required semantic Agent action, while enforcement, state, paths, and persistence remain program-owned.
- CSV never asks the Agent to recalculate totals and never becomes a grading fact source.
- Deletion is scoped by stored program identifiers and never accepts filesystem paths from the browser or Agent.
- The exact frozen rubric key includes both assignment ID and rubric version, preventing sessions from different standards from mixing.
