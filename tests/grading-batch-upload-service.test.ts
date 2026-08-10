import { mkdtemp, rm } from "node:fs/promises";
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
  const createSession = vi.fn(async (input: any) => {
    const id = `session-${sessions.size + 1}`;
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
