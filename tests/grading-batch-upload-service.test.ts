import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradingBatchUploadService } from "../src/services/grading-batch-upload-service.js";
import { StudentIdentityError } from "../src/services/student-identity-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function dependencies() {
  const sessions = new Map<string, any>();
  const batches = new Map<string, any>();
  let nextSessionNumber = 0;
  const createSession = vi.fn(async (input: any) => {
    nextSessionNumber += 1;
    const id = `session-${nextSessionNumber}`;
    const session = {
      id,
      conversionStatus: "ready",
      submissionTitleStatus: "pending",
      studentName: input.studentName,
      studentNumber: input.studentNumber,
    };
    sessions.set(id, session);
    return session;
  });
  return {
    sessions,
    createSession,
    value: {
      async resolveIdentity(input: { filename: string }) {
        if (input.filename.startsWith("unknown"))
          throw new StudentIdentityError("请补填身份", "STUDENT_IDENTITY_NOT_FOUND");
        return { studentName: "张晓明", studentNumber: input.filename.slice(0, 8) };
      },
      createSession,
      async getSession(id: string) { return sessions.get(id); },
      async deleteSession(id: string) { sessions.delete(id); },
      async resolveTitle(id: string) {
        Object.assign(sessions.get(id), {
          submissionTitle: "共享图片报告",
          submissionTitleStatus: "resolved",
        });
      },
      async processConversion() {},
      async retryConversion() {},
      async createBatch(input: any) {
        const batch = { id: `batch-${batches.size + 1}`, totalJobs: input.sessionIds.length };
        batches.set(batch.id, batch);
        return batch;
      },
      async getBatch(id: string) { return batches.get(id); },
    },
  };
}

describe("GradingBatchUploadService", () => {
  it("applies the replacement cleanup migration to an existing upload database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-migration-"));
    roots.push(root);
    const deps = dependencies();
    const initial = new GradingBatchUploadService(root, deps.value);
    initial.close();
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec("DROP TABLE grading_batch_upload_replacements; DROP TABLE grading_batch_upload_schema_migrations;");
    database.close();

    const migrated = new GradingBatchUploadService(root, deps.value);
    const check = new Database(path.join(root, "grading.sqlite"));
    const version = check.prepare("SELECT version FROM grading_batch_upload_schema_migrations").get() as { version: number };
    const table = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grading_batch_upload_replacements'").get();
    check.close();
    await migrated.recover();
    migrated.close();
    expect(version.version).toBe(1);
    expect(table).toBeTruthy();
  });

  it("refuses traversal identifiers in persisted replacement cleanup records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-journal-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "batch-upload-journal-outside-"));
    roots.push(root, outside);
    const deps = dependencies();
    const initial = new GradingBatchUploadService(root, deps.value);
    initial.close();

    const itemId = randomUUID();
    const outsideItem = path.join(outside, itemId);
    const sentinel = path.join(outsideItem, "keep.txt");
    await mkdir(outsideItem, { recursive: true });
    await writeFile(sentinel, "outside workspace", "utf8");
    const uploadId = `../../${path.basename(outside)}`;
    const itemBase = `batch-uploads/${uploadId}/${itemId}`;
    const database = new Database(path.join(root, "grading.sqlite"));
    database.prepare(
      `INSERT INTO grading_batch_upload_replacements
       (id, upload_id, item_id, state, staged_base, backup_base, had_original, old_session_id, created_at)
       VALUES (?, ?, ?, 'prepared', ?, ?, 0, NULL, ?)`,
    ).run(randomUUID(), uploadId, itemId, `${itemBase}.replacement-${randomUUID()}`, `${itemBase}.previous-${randomUUID()}`, new Date().toISOString());
    database.close();

    const service = new GradingBatchUploadService(root, deps.value);
    await service.recover();
    service.close();
    expect(await readFile(sentinel, "utf8")).toBe("outside workspace");
  });

  it("persists partial progress, filters shared assets, resumes identity, and commits idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-"));
    roots.push(root);
    const deps = dependencies();
    let service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "一班报告",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 2,
      items: [
        { filename: "20260001_张晓明_共享图片报告.md" },
        { filename: "unknown-report.md" },
      ],
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await service.storeItemFile(draft.id, draft.items[0]!.id, {
      filename: draft.items[0]!.filename,
      bytes: new TextEncoder().encode("# 报告\n\n![图](assets/chart.png)\n"),
      assets: [
        { path: "assets/chart.png", bytes: png },
        { path: "assets/unused.png", bytes: png },
      ],
    });
    await service.processItem(draft.id, draft.items[0]!.id);
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({
      revisionAssets: [{ path: "assets/chart.png", bytes: png }],
    }));

    await service.storeItemFile(draft.id, draft.items[1]!.id, {
      filename: draft.items[1]!.filename,
      bytes: new TextEncoder().encode("# 报告"),
      assets: [],
    });
    await service.processItem(draft.id, draft.items[1]!.id);
    expect((await service.getUpload(draft.id)).items.map(({ status }) => status))
      .toEqual(["ready", "identity_required"]);
    service.close();

    service = new GradingBatchUploadService(root, deps.value);
    expect((await service.getUpload(draft.id)).items.map(({ status }) => status))
      .toEqual(["ready", "identity_required"]);
    await service.patchIdentity(draft.id, draft.items[1]!.id, {
      studentName: "李华",
      studentNumber: "20260002",
    });
    await service.processItem(draft.id, draft.items[1]!.id);
    expect((await service.getUpload(draft.id)).items.map(({ status }) => status))
      .toEqual(["ready", "ready"]);

    const committed = await service.commitUpload(draft.id);
    await expect(service.commitUpload(draft.id)).resolves.toEqual(committed);
    expect(committed).toMatchObject({ totalJobs: 2 });
    expect((await service.getUpload(draft.id)).status).toBe("committed");
    service.close();
  });

  it("keeps created sessions when an upload draft is cancelled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-cancel-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "取消草稿",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_报告.md" }, { filename: "pending.md" }],
    });
    await service.storeItemFile(draft.id, draft.items[0]!.id, {
      filename: draft.items[0]!.filename,
      bytes: new TextEncoder().encode("# 报告"),
      assets: [],
    });
    await service.processItem(draft.id, draft.items[0]!.id);
    const sessionId = (await service.getUpload(draft.id)).items[0]!.sessionId!;
    await expect(service.cancelUpload(draft.id)).resolves.toEqual({
      preservedSessionIds: [sessionId],
    });
    expect(deps.sessions.has(sessionId)).toBe(true);
    service.close();
  });

  it("marks only the report with a missing shared asset as failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-missing-asset-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "共享附件",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [
        { filename: "20260001_张晓明_报告.md" },
        { filename: "20260002_李华_报告.md" },
      ],
    });
    const first = await service.storeItemFile(draft.id, draft.items[0]!.id, {
      filename: draft.items[0]!.filename,
      bytes: new TextEncoder().encode("![缺失](assets/missing.png)"),
      assets: [],
    });
    const second = await service.storeItemFile(draft.id, draft.items[1]!.id, {
      filename: draft.items[1]!.filename,
      bytes: new TextEncoder().encode("# 无图片"),
      assets: [],
    });

    expect(first).toMatchObject({ status: "failed", errorCode: "SUBMISSION_ASSET_MISSING" });
    expect(second.status).toBe("pending");
    service.close();
  });

  it("preserves a ready item when a replacement is missing a referenced attachment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-invalid-replacement-"));
    roots.push(root);
    const deps = dependencies();
    let service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "无效替换",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);
    const ready = (await service.getUpload(draft.id)).items[0]!;
    const reportPath = path.join(root, "batch-uploads", draft.id, original.id, "report.md");

    const replacementPromise = service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("![缺失](assets/missing.png)\n"),
      assets: [],
    });
    const rejection = await replacementPromise.then(() => undefined, (error: unknown) => error);
    const afterRejectedReplacement = (await service.getUpload(draft.id)).items[0]!;
    const sessionPreserved = deps.sessions.has(ready.sessionId!);
    const storedReport = await readFile(reportPath, "utf8");
    service.close();
    expect(rejection).toMatchObject({ code: "SUBMISSION_ASSET_MISSING" });
    expect(afterRejectedReplacement).toMatchObject({ status: "ready", sessionId: ready.sessionId, filename: original.filename });
    expect(sessionPreserved).toBe(true);
    expect(storedReport).toBe("# 原报告\n");
  });

  it("replaces a ready item only after the new report and attachments validate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-valid-replacement-"));
    roots.push(root);
    const deps = dependencies();
    let service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "有效替换",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);
    const oldSessionId = (await service.getUpload(draft.id)).items[0]!.sessionId!;
    const attachment = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const replacement = await service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n![图](assets/chart.png)\n"),
      assets: [{ path: "assets/chart.png", bytes: attachment }],
    });

    const priorSessionRemoved = !deps.sessions.has(oldSessionId);
    const callsBeforeProcessing = deps.createSession.mock.calls.length;
    await service.processItem(draft.id, original.id);
    const ready = (await service.getUpload(draft.id)).items[0]!;
    const createSessionCalls = deps.createSession.mock.calls.length;
    const newReport = await readFile(path.join(root, "batch-uploads", draft.id, original.id, "report.md"), "utf8");
    const newSessionInput = deps.createSession.mock.calls[1]?.[0];
    service.close();
    expect(replacement).toMatchObject({ status: "pending", filename: "20260001_张晓明_新报告.md" });
    expect(replacement.sessionId).toBeUndefined();
    expect(priorSessionRemoved).toBe(true);
    expect(callsBeforeProcessing).toBe(1);
    expect(ready).toMatchObject({ status: "ready", filename: "20260001_张晓明_新报告.md" });
    expect(createSessionCalls).toBe(2);
    expect(newReport).toBe("# 新报告\n![图](assets/chart.png)\n");
    expect(newSessionInput).toMatchObject({ revisionAssets: [{ path: "assets/chart.png", bytes: attachment }] });
    expect(ready.sessionId).not.toBe(oldSessionId);
  });

  it("keeps the committed session snapshot stable when replacement starts during batch creation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-commit-replacement-race-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "提交替换并发",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);
    const ready = (await service.getUpload(draft.id)).items[0]!;

    let releaseBatchCreation!: () => void;
    const batchGate = new Promise<void>((resolve) => { releaseBatchCreation = resolve; });
    let signalBatchCreation!: () => void;
    const batchCreationStarted = new Promise<void>((resolve) => { signalBatchCreation = resolve; });
    let batchSessionIds: string[] = [];
    vi.spyOn(deps.value, "createBatch").mockImplementation(async (input) => {
      batchSessionIds = [...input.sessionIds];
      signalBatchCreation();
      await batchGate;
      return { id: "batch-committed", totalJobs: input.sessionIds.length };
    });
    const commitPromise = service.commitUpload(draft.id);
    await batchCreationStarted;

    const filesystem = (service as any).filesystem;
    const writeBytes = filesystem.writeBytes.bind(filesystem) as (relativePath: string, bytes: Uint8Array) => Promise<void>;
    let replacementWriteStarted = false;
    filesystem.writeBytes = async (relativePath: string, bytes: Uint8Array) => {
      if (relativePath.includes(".replacement-")) replacementWriteStarted = true;
      await writeBytes(relativePath, bytes);
    };
    const replacementPromise = service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n"),
      assets: [],
    }).then((item) => ({ item }), (error: unknown) => ({ error }));
    const cancellationPromise = service.cancelUpload(draft.id).then((result) => ({ result }), (error: unknown) => ({ error }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacementWroteWhileCommitWasCreating = replacementWriteStarted;
    releaseBatchCreation();
    const batch = await commitPromise;
    const replacement = await replacementPromise;
    const cancellation = await cancellationPromise;
    const committedItem = (await service.getUpload(draft.id)).items[0]!;
    service.close();

    expect(replacementWroteWhileCommitWasCreating).toBe(false);
    expect(replacement).toHaveProperty("error");
    expect(cancellation).toHaveProperty("error");
    expect(batchSessionIds).toEqual([ready.sessionId]);
    expect(committedItem).toMatchObject({ status: "committed", sessionId: ready.sessionId });
    expect(batch.id).toBe("batch-committed");
  });

  it("makes a commit wait for an in-flight replacement and then rejects its pending item", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-replacement-commit-race-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "替换提交并发",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);

    const filesystem = (service as any).filesystem;
    const writeBytes = filesystem.writeBytes.bind(filesystem) as (relativePath: string, bytes: Uint8Array) => Promise<void>;
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    let signalReplacementWrite!: () => void;
    const replacementWriteStarted = new Promise<void>((resolve) => { signalReplacementWrite = resolve; });
    filesystem.writeBytes = async (relativePath: string, bytes: Uint8Array) => {
      if (relativePath.includes(".replacement-")) {
        signalReplacementWrite();
        await replacementGate;
      }
      await writeBytes(relativePath, bytes);
    };
    const replacementPromise = service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n"),
      assets: [],
    });
    await replacementWriteStarted;

    const createBatch = vi.spyOn(deps.value, "createBatch");
    const commitPromise = service.commitUpload(draft.id).then((batch) => ({ batch }), (error: unknown) => ({ error }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const commitStartedBeforeReplacementFinished = createBatch.mock.calls.length > 0;
    releaseReplacement();
    const replacement = await replacementPromise;
    const commit = await commitPromise;
    const afterReplacement = (await service.getUpload(draft.id)).items[0]!;
    service.close();

    expect(commitStartedBeforeReplacementFinished).toBe(false);
    expect(replacement).toMatchObject({ status: "pending", filename: "20260001_张晓明_新报告.md" });
    expect(commit).toHaveProperty("error");
    expect(afterReplacement).toMatchObject({ status: "pending", filename: "20260001_张晓明_新报告.md" });
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("continues processing different upload items concurrently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-independent-items-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "独立处理",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 2,
      items: [
        { filename: "20260001_张晓明_第一份.md" },
        { filename: "20260002_李华_第二份.md" },
      ],
    });
    for (const item of draft.items) {
      await service.storeItemFile(draft.id, item.id, {
        filename: item.filename,
        bytes: new TextEncoder().encode(`# ${item.filename}\n`),
        assets: [],
      });
    }

    let releaseFirstTitle!: () => void;
    const firstTitleGate = new Promise<void>((resolve) => { releaseFirstTitle = resolve; });
    let signalFirstTitle!: () => void;
    const firstTitleStarted = new Promise<void>((resolve) => { signalFirstTitle = resolve; });
    const resolveTitle = deps.value.resolveTitle.bind(deps.value);
    deps.value.resolveTitle = async (sessionId) => {
      if (sessionId === "session-1") {
        signalFirstTitle();
        await firstTitleGate;
      }
      await resolveTitle(sessionId);
    };
    const firstProcessing = service.processItem(draft.id, draft.items[0]!.id);
    await firstTitleStarted;
    let secondCompleted = false;
    const secondProcessing = service.processItem(draft.id, draft.items[1]!.id).then((item) => {
      secondCompleted = item.status === "ready";
      return item;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondFinishedWhileFirstWasPaused = secondCompleted;
    releaseFirstTitle();
    await Promise.all([firstProcessing, secondProcessing]);
    const items = (await service.getUpload(draft.id)).items;
    service.close();

    expect(secondFinishedWhileFirstWasPaused).toBe(true);
    expect(items.map(({ status }) => status)).toEqual(["ready", "ready"]);
  });

  it("serializes replacement with an in-flight item processor and processes only the new report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-replacement-race-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "并发替换",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);
    const previous = (await service.getUpload(draft.id)).items[0]!;
    const previousSession = deps.sessions.get(previous.sessionId!)!;
    previousSession.conversionStatus = "queued";

    let releaseConversion!: () => void;
    const conversionGate = new Promise<void>((resolve) => { releaseConversion = resolve; });
    let signalConversionStarted!: () => void;
    const conversionStarted = new Promise<void>((resolve) => { signalConversionStarted = resolve; });
    deps.value.processConversion = async () => {
      signalConversionStarted();
      await conversionGate;
      previousSession.conversionStatus = "ready";
    };
    const oldProcessing = service.processItem(draft.id, original.id);
    await conversionStarted;

    const filesystem = (service as any).filesystem;
    const writeBytes = filesystem.writeBytes.bind(filesystem) as (relativePath: string, bytes: Uint8Array) => Promise<void>;
    let signalReplacementWrite!: () => void;
    const replacementWriteStarted = new Promise<void>((resolve) => { signalReplacementWrite = resolve; });
    filesystem.writeBytes = async (relativePath: string, bytes: Uint8Array) => {
      if (relativePath.includes(".replacement-")) signalReplacementWrite();
      await writeBytes(relativePath, bytes);
    };
    const replacementPromise = service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n"),
      assets: [],
    });
    const replacementStartedBeforeOldProcessing = await Promise.race([
      replacementWriteStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    releaseConversion();
    await oldProcessing;
    const replacement = await replacementPromise;
    await service.processItem(draft.id, original.id);
    const finalItem = (await service.getUpload(draft.id)).items[0]!;
    const finalReport = await readFile(path.join(root, "batch-uploads", draft.id, original.id, "report.md"), "utf8");
    service.close();

    expect(replacementStartedBeforeOldProcessing).toBe(false);
    expect(replacement.status).toBe("pending");
    expect(finalItem).toMatchObject({ status: "ready", filename: "20260001_张晓明_新报告.md" });
    expect(finalItem.sessionId).not.toBe(previous.sessionId);
    expect(finalReport).toBe("# 新报告\n");
  });

  it("keeps the replacement pending and recovers partial old-session deletion after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-delete-failure-"));
    roots.push(root);
    const deps = dependencies();
    let service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "删除会话失败",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await service.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await service.processItem(draft.id, original.id);
    const ready = (await service.getUpload(draft.id)).items[0]!;
    const oldSessionId = ready.sessionId!;
    let deletionCalls = 0;
    const tombstonedSessions = new Set<string>();
    const partiallyDeletedDirectories = new Set<string>();
    deps.value.deleteSession = async (id: string) => {
      deletionCalls += 1;
      // Model deleteSession after it has committed deletion_pending and removed
      // its first directory: the old session is no longer usable, but cleanup
      // has not completed yet.
      tombstonedSessions.add(id);
      partiallyDeletedDirectories.add(`${id}:submissions`);
      deps.sessions.delete(id);
      if (deletionCalls === 1) throw new Error("session cleanup interrupted after tombstone");
    };

    const replacement = await service.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n"),
      assets: [],
    }).then((item) => item, (error: unknown) => error);
    const afterFailure = (await service.getUpload(draft.id)).items[0]!;
    const storedReport = await readFile(path.join(root, "batch-uploads", draft.id, original.id, "report.md"), "utf8");
    const sessionPreserved = deps.sessions.has(oldSessionId);
    service.close();
    expect(replacement).toMatchObject({ status: "pending", filename: "20260001_张晓明_新报告.md" });
    expect(afterFailure).toMatchObject({ status: "pending", filename: "20260001_张晓明_新报告.md" });
    expect(afterFailure.sessionId).toBeUndefined();
    expect(storedReport).toBe("# 新报告\n");
    expect(sessionPreserved).toBe(false);
    expect(tombstonedSessions.has(oldSessionId)).toBe(true);
    expect(partiallyDeletedDirectories.has(`${oldSessionId}:submissions`)).toBe(true);
    // The cleanup intent must survive a restart. Recovery retries the old
    // deletion, clears its durable record, and processes the replacement.
    service = new GradingBatchUploadService(root, deps.value);
    await service.recover();
    await service.processItem(draft.id, original.id);
    const recovered = (await service.getUpload(draft.id)).items[0]!;
    service.close();
    expect(deletionCalls).toBeGreaterThanOrEqual(2);
    expect(recovered).toMatchObject({ status: "ready", filename: "20260001_张晓明_新报告.md" });
    expect(recovered.sessionId).toBeTruthy();
    expect(recovered.sessionId).not.toBe(oldSessionId);
  });

  it("persists backup cleanup after a removal failure and clears it on recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-backup-recovery-"));
    roots.push(root);
    const deps = dependencies();
    const baseService = new GradingBatchUploadService(root, deps.value);
    const draft = await baseService.createUpload({
      title: "备份清理恢复",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_原报告.md" }],
    });
    const original = draft.items[0]!;
    await baseService.storeItemFile(draft.id, original.id, {
      filename: original.filename,
      bytes: new TextEncoder().encode("# 原报告\n"),
      assets: [],
    });
    await baseService.processItem(draft.id, original.id);
    baseService.close();

    let failedBackupRemoval = false;
    const serviceWithFailedCleanup = new GradingBatchUploadService(root, deps.value, undefined, {
      async removeDirectory(relativePath) {
        if (relativePath.includes(".previous-") && !failedBackupRemoval) {
          failedBackupRemoval = true;
          throw new Error("backup cleanup interrupted");
        }
        await rm(path.join(root, ...relativePath.split("/")), { recursive: true, force: true });
      },
    });
    const replacement = await serviceWithFailedCleanup.storeItemFile(draft.id, original.id, {
      filename: "20260001_张晓明_新报告.md",
      bytes: new TextEncoder().encode("# 新报告\n"),
      assets: [],
    });
    const directory = path.join(root, "batch-uploads", draft.id);
    const beforeRestart = await readdir(directory);
    serviceWithFailedCleanup.close();

    expect(failedBackupRemoval).toBe(true);
    expect(replacement.status).toBe("pending");
    expect(beforeRestart.some((entry) => entry.includes(".previous-"))).toBe(true);

    const recoveredService = new GradingBatchUploadService(root, deps.value);
    await recoveredService.recover();
    await recoveredService.processItem(draft.id, original.id);
    const afterRestart = await readdir(directory);
    const recoveredItem = (await recoveredService.getUpload(draft.id)).items[0]!;
    recoveredService.close();
    expect(afterRestart.some((entry) => entry.includes(".previous-"))).toBe(false);
    expect(recoveredItem.status).toBe("ready");
  });

  it("retries a failed title without recreating the session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "batch-upload-title-retry-"));
    roots.push(root);
    const deps = dependencies();
    const service = new GradingBatchUploadService(root, deps.value);
    const draft = await service.createUpload({
      title: "名称重试",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: 1,
      concurrency: 1,
      items: [{ filename: "20260001_张晓明_报告.md" }],
    });
    await service.storeItemFile(draft.id, draft.items[0]!.id, {
      filename: draft.items[0]!.filename,
      bytes: new TextEncoder().encode("# 报告"),
      assets: [],
    });
    await service.processItem(draft.id, draft.items[0]!.id);
    const item = (await service.getUpload(draft.id)).items[0]!;
    Object.assign(deps.sessions.get(item.sessionId!), {
      submissionTitleStatus: "failed",
      submissionTitleError: { code: "SUBMISSION_TITLE_MODEL_FAILED", message: "名称识别失败，请重试" },
    });

    await service.retryItem(draft.id, item.id);

    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect((await service.getUpload(draft.id)).items[0]!.status).toBe("ready");
    service.close();
  });
});
