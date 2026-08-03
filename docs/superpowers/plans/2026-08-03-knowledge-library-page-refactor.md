# Knowledge Library Page Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/knowledge` into a version-aware workspace where teachers can browse the active release, create and edit an isolated revision draft, and publish a new immutable release.

**Architecture:** Keep `MaterialService` as the deterministic owner of import, staging, release, and active-pointer transitions. Add thin Fastify endpoints for release trees, ready drafts, revision creation, and optimistic content updates. Keep the React page state local, but move release numbering into a pure helper so the version presentation is testable without a DOM dependency.

**Tech Stack:** TypeScript ESM, Fastify, React 19, Vite, Vitest, `SafeFilesystem`, `react-markdown`, `remark-gfm`.

---

### Task 1: Release browsing and revision drafts

**Files:**
- Modify: `tests/knowledge-release.test.ts`
- Modify: `src/services/material-service.ts`

- [x] **Step 1: Write failing service tests**

Add tests that publish a release, call the wished-for `getReleaseTree()`, call `createRevisionDraft()`, and assert that the new import is `ready`, has `baseReleaseId`, contains the same tree/content, and leaves the release and active pointer unchanged. Add a second assertion that `listDrafts(courseId)` returns the ready revision.

```ts
const revision = await service.createRevisionDraft(course.id, release.id);
expect(revision.imported).toMatchObject({ status: "ready", baseReleaseId: release.id });
expect(revision.draft.tree).toEqual(await service.getReleaseTree(course.id, release.id));
expect(await service.readDraftContent(course.id, revision.imported.id, "first.md"))
  .toBe(await service.readReleaseContent(course.id, release.id, "first.md"));
expect((await service.getActiveRelease(course.id))?.id).toBe(release.id);
```

- [x] **Step 2: Verify RED**

Run `npm test -- --run tests/knowledge-release.test.ts` and confirm TypeScript/Vitest fails because the three new service methods do not exist.

- [x] **Step 3: Implement minimal service behavior**

Extend `ImportRecord` with optional `baseReleaseId`. Implement:

```ts
async getReleaseTree(courseId: string, releaseId: string): Promise<KnowledgeTreeEntry[]>
async listDrafts(courseId: string): Promise<ImportRecord[]>
async createRevisionDraft(courseId: string, releaseId: string): Promise<{ imported: ImportRecord; draft: DraftSummary }>
```

The revision method must verify the release belongs to the course, read only paths from its stored tree, create a new import from those released files, render a matching plan, store `baseReleaseId`, and never write `active.json`.

- [x] **Step 4: Verify GREEN**

Run `npm test -- --run tests/knowledge-release.test.ts` and confirm all knowledge-release tests pass.

### Task 2: Optimistic Markdown draft editing

**Files:**
- Modify: `tests/knowledge-release.test.ts`
- Modify: `src/services/material-service.ts`

- [x] **Step 1: Write failing content-edit tests**

Test the wished-for `updateDraftContent()` method. Assert that it increments the draft version, changes the manifest hash, preserves the tree, updates the file, rejects a stale expected version, and does not change the source release.

```ts
const updated = await service.updateDraftContent(course.id, revision.imported.id, revision.draft.version, "first.md", "# Revised\n");
expect(updated.version).toBe(revision.draft.version + 1);
expect(updated.manifestHash).not.toBe(revision.draft.manifestHash);
await expect(service.updateDraftContent(course.id, revision.imported.id, revision.draft.version, "first.md", "stale"))
  .rejects.toThrow("Draft has changed");
```

- [x] **Step 2: Verify RED**

Run `npm test -- --run tests/knowledge-release.test.ts` and confirm failure because `updateDraftContent()` is missing.

- [x] **Step 3: Implement content-aware manifests and save**

Include a SHA-256 content hash for every document in draft manifest calculation. Implement an atomic draft-file write through `SafeFilesystem`, validate that the requested path belongs to the draft tree, enforce the existing 10 MB per-file limit, update `index/draft.json`, `index/manifest.json`, and the stored import with the next version/hash.

- [x] **Step 4: Verify GREEN**

Run `npm test -- --run tests/knowledge-release.test.ts` and confirm all tests pass.

### Task 3: Thin API routes

**Files:**
- Modify: `tests/material-import-api.test.ts`
- Modify: `src/api/server.ts`

- [x] **Step 1: Write failing API tests**

Cover:

```text
GET  /api/courses/:courseId/releases/:releaseId/tree
GET  /api/courses/:courseId/drafts
POST /api/courses/:courseId/releases/:releaseId/revisions
PATCH /api/courses/:courseId/imports/:importId/content
```

Assert the revision response is `201`, content edits return the next version, release content remains unchanged, and a stale save maps to HTTP 409 without exposing filesystem paths.

- [x] **Step 2: Verify RED**

Run `npm test -- --run tests/material-import-api.test.ts` and confirm the new endpoints return 404.

- [x] **Step 3: Implement schema-validated route adapters**

Use Zod UUID/path/version/content schemas and delegate directly to the four `MaterialService` methods. Do not add filesystem or version logic to route handlers.

- [x] **Step 4: Verify GREEN**

Run `npm test -- --run tests/material-import-api.test.ts` and confirm all material API tests pass.

### Task 4: Version presentation model and React workspace

**Files:**
- Create: `web/src/pages/knowledge-library-model.ts`
- Create: `tests/knowledge-library-model.test.ts`
- Modify: `web/src/pages/KnowledgeLibraryPage.tsx`
- Modify: `web/src/styles.css`

- [x] **Step 1: Write failing pure-model tests**

Define and test the wished-for chronological version mapping:

```ts
expect(numberReleases([
  { id: "new", createdAt: "2026-08-03T00:00:00Z" },
  { id: "old", createdAt: "2026-08-01T00:00:00Z" },
])).toEqual([{ id: "new", versionLabel: "v2" }, { id: "old", versionLabel: "v1" }]);
```

Also cover stable ordering when timestamps tie by retaining API order.

- [x] **Step 2: Verify RED**

Run `npm test -- --run tests/knowledge-library-model.test.ts` and confirm the module/function is missing.

- [x] **Step 3: Implement model and refactor the page**

Create the pure helper, then rebuild `KnowledgeLibraryPage` around:

- a compact course/version header and hidden directory input;
- tabs named `当前版本`, `修订草稿`, and `版本记录`;
- active release preview by default;
- release browsing from history;
- revision creation from the active or selected release;
- ready-draft recovery after reload;
- a draft directory plus Markdown source/preview split workspace;
- save, rename, move, rerun, and publish actions;
- explicit current badges and `vN` labels;
- cleared draft state after publish and automatic preview of the new active release;
- accessible status/alert output and responsive empty states.

- [x] **Step 4: Implement focused responsive styling**

Replace the old `.split`, `.tree-row`, and `.release` presentation with `.knowledge-toolbar`, `.knowledge-tabs`, `.knowledge-browser`, `.document-tree`, `.document-workspace`, `.draft-editor-grid`, and `.release-list` styles. Collapse the browser into a vertical layout under 860 px.

- [x] **Step 5: Verify targeted tests and type checking**

Run `npm test -- --run tests/knowledge-library-model.test.ts tests/material-import-api.test.ts tests/knowledge-release.test.ts` and `npm run typecheck`; confirm exit code 0.

### Task 5: Documentation and delivery verification

**Files:**
- Modify: `.docs/domain-and-storage.md`
- Modify: `.docs/architecture.md`
- Modify: `.docs/testing.md`
- Modify: `docs/acceptance/M1-knowledge-library.md`
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [x] **Step 1: Update current-fact documentation**

Document that release editing creates a new staging import with `baseReleaseId`, draft content saves use expected version plus content-aware manifests, release browsing is read-only, and publishing still atomically activates the new immutable release.

- [x] **Step 2: Update M1 acceptance steps**

Add manual checks for active preview, revision isolation, Markdown save/preview, readable version history, new-release publishing, and old-release activation.

- [x] **Step 3: Run browser visual verification**

Start the local service, open `/knowledge`, and verify the empty, active-release, draft-edit, and history states at desktop and narrow widths. Record any visual issues and fix them before final verification.

- [x] **Step 4: Run full verification**

Run `npm run check` and `npm run build`. Both must exit 0 before completion is claimed.

- [x] **Step 5: Inspect final scope**

Run `git diff --stat` and `git status --short`; confirm no workspace data, credentials, or unrelated files were modified.

> The repository has no tracked project baseline, so this execution intentionally does not stage or commit the entire untracked tree. The user can decide the initial repository commit scope separately.
