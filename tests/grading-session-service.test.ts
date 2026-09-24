import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import Database from "better-sqlite3";
import { RubricService } from "../src/services/rubric-service.js";
import {
  GradingConflictError,
  GradingSessionService,
  UnsupportedSubmissionTypeError,
} from "../src/services/grading-session-service.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grading-session-"));
  roots.push(root);
  const rubrics = new RubricService(root);
  const courseId = "11111111-1111-4111-8111-111111111111";
  const assignment = await rubrics.createAssignment({
    courseId,
    title: "AI 应用报告",
    totalScore: 100,
    requirements: "按报告完整性扣分",
    sources: [],
  });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0",
    mode: "deductive",
    totalScore: 100,
    overlapGroups: [],
    rules: [
      {
        id: "missing",
        name: "缺少内容",
        condition: "报告缺少核心内容",
        deduction: 20,
        maxDeduction: 20,
        occurrence: "once",
        evidenceRequired: true,
      },
    ],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const service = new GradingSessionService(root, rubrics, {
    now: () => "2026-08-04T10:00:00.000Z",
  });
  return { root, rubrics, assignment, frozen, service };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GradingSessionService", () => {
  it("binds a frozen rubric, stores the immutable original, and directly imports Markdown", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "upload.md");
    await writeFile(source, "# 报告\n\n第一行内容\n第二行内容\n", "utf8");

    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "20260001_张晓明_报告.md",
      autoStartAfterConversion: false,
      submissionTitle: "AI 与生活融合报告",
    });

    expect(session).toMatchObject({
      courseId: "11111111-1111-4111-8111-111111111111",
      assignmentId: assignment.id,
      rubricVersion: 1,
      rubricHash: frozen.hash,
      studentName: "张晓明",
      studentNumber: "20260001",
      conversionStatus: "ready",
      gradingStatus: "not_started",
      submissionVersion: 1,
      submissionTitle: "AI 与生活融合报告",
      submissionTitleStatus: "provided",
    });
    expect(session.id).not.toBe(session.studentKey);
    expect(session.batchId).not.toBe(session.studentKey);
    const metadata = JSON.parse(
      await readFile(
        path.join(
          root,
          "assignments",
          assignment.id,
          "submissions",
          session.batchId,
          session.studentKey,
          "metadata.json",
        ),
        "utf8",
      ),
    );
    expect(metadata.originalFilename).toBe("20260001_张晓明_报告.md");
    expect(metadata.originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.readSubmission(session.id)).toContain("第一行内容");
    service.close();
  });

  it("stores nested Markdown image assets and includes their content in the submission hash", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "nested-assets.md");
    await writeFile(source, "# 报告\n\n![图表](assets/charts/chart.png)\n", "utf8");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const first = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "20260001_张晓明_报告.md",
      autoStartAfterConversion: false,
      revisionAssets: [{ path: "assets/charts/chart.png", bytes: png }],
    });
    const second = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "李华",
      studentNumber: "20260002",
      originalPath: source,
      originalFilename: "20260002_李华_报告.md",
      autoStartAfterConversion: false,
      revisionAssets: [{ path: "assets/charts/chart.png", bytes: new Uint8Array([...png, 2]) }],
    });

    expect(await service.readSubmissionAsset(first.id, "assets/charts/chart.png")).toEqual(png);
    expect(first.submissionHash).not.toBe(second.submissionHash);
    service.close();
  });

  it("rejects missing, duplicate, forged, and SVG Markdown assets with stable codes", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "unsafe-assets.md");
    const create = (markdown: string, assets: Array<{ path: string; bytes: Uint8Array }>) =>
      writeFile(source, markdown, "utf8").then(() => service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: source,
        originalFilename: "report.md",
        autoStartAfterConversion: false,
        revisionAssets: assets,
      }));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await expect(create("![缺失](assets/missing.png)", [])).rejects.toMatchObject({ code: "SUBMISSION_ASSET_MISSING" });
    await expect(create("# 报告", [
      { path: "assets/chart.png", bytes: png },
      { path: "assets/chart.png", bytes: png },
    ])).rejects.toMatchObject({ code: "SUBMISSION_ASSET_DUPLICATE_PATH" });
    await expect(create("![伪造](assets/chart.png)", [
      { path: "assets/chart.png", bytes: new TextEncoder().encode("not a png") },
    ])).rejects.toMatchObject({ code: "SUBMISSION_ASSET_CONTENT_MISMATCH" });
    await expect(create("![SVG](assets/chart.svg)", [
      { path: "assets/chart.svg", bytes: new TextEncoder().encode("<svg/>") },
    ])).rejects.toMatchObject({ code: "SUBMISSION_ASSET_TYPE_UNSUPPORTED" });
    service.close();
  });

  it("enforces Markdown asset count, per-file size, and total size limits", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "asset-limits.md");
    await writeFile(source, "# 报告", "utf8");
    const create = (assets: Array<{ path: string; bytes: Uint8Array }>) => service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "report.md",
      autoStartAfterConversion: false,
      revisionAssets: assets,
    });
    const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(create(Array.from({ length: 101 }, (_, index) => ({
      path: `assets/image-${index}.png`,
      bytes: tinyPng,
    })))).rejects.toMatchObject({ code: "SUBMISSION_ASSET_COUNT_EXCEEDED" });

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(tinyPng);
    await expect(create([{ path: "assets/large.png", bytes: oversized }]))
      .rejects.toMatchObject({ code: "SUBMISSION_ASSET_TOO_LARGE" });

    const chunk = new Uint8Array(9 * 1024 * 1024);
    chunk.set(tinyPng);
    await expect(create(Array.from({ length: 6 }, (_, index) => ({
      path: `assets/large-${index}.png`,
      bytes: chunk,
    })))).rejects.toMatchObject({ code: "SUBMISSION_ASSET_TOTAL_TOO_LARGE" });
    service.close();
  });

  it("persists manual submission titles and marks omitted titles pending", async () => {
    const { root, rubrics, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# 城市低碳交通研究\n", "utf8");
    const manual = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      submissionTitle: "城市低碳交通研究",
      originalPath: source,
      originalFilename: "topic.md",
      autoStartAfterConversion: false,
    });
    const pending = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "李华",
      studentNumber: "20260002",
      originalPath: source,
      originalFilename: "unknown.md",
      autoStartAfterConversion: false,
    });
    expect(manual).toMatchObject({
      submissionTitle: "城市低碳交通研究",
      submissionTitleStatus: "provided",
    });
    expect(pending).toMatchObject({ submissionTitleStatus: "pending" });
    expect(pending.submissionTitle).toBeUndefined();
    service.close();
    const restored = new GradingSessionService(root, rubrics);
    expect(await restored.getSession(manual.id)).toMatchObject({
      submissionTitle: "城市低碳交通研究",
      submissionTitleStatus: "provided",
    });
    expect(await restored.getSession(pending.id)).toMatchObject({
      submissionTitleStatus: "pending",
    });
    restored.close();
  });

  it("resolves a pending submission title once and exposes the original filename", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# 正文标题\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "文件名标题.md",
      autoStartAfterConversion: false,
    });
    expect(await service.getOriginalFilename(session.id)).toBe("文件名标题.md");
    expect(
      await service.resolveSubmissionTitle(session.id, "正文标题"),
    ).toMatchObject({
      submissionTitle: "正文标题",
      submissionTitleStatus: "resolved",
    });
    await expect(
      service.resolveSubmissionTitle(session.id, "第二次写入"),
    ).rejects.toBeInstanceOf(GradingConflictError);
    service.close();
  });

  it("filters exact frozen rubrics and supports scoped rename and deletion", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\n", "utf8");
    const first = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      submissionTitle: "A",
      originalPath: source,
      originalFilename: "a.md",
      autoStartAfterConversion: false,
    });
    const second = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "李华",
      studentNumber: "20260002",
      submissionTitle: "B",
      originalPath: source,
      originalFilename: "b.md",
      autoStartAfterConversion: false,
    });
    expect(
      (
        await service.listSessions({
          assignmentId: assignment.id,
          rubricVersion: frozen.version,
        })
      ).map(({ id }) => id),
    ).toEqual([second.id, first.id]);
    expect(
      await service.listSessions({
        assignmentId: assignment.id,
        rubricVersion: 99,
      }),
    ).toEqual([]);
    expect(
      await service.renameSession(first.id, "  低碳报告批改  "),
    ).toMatchObject({ title: "低碳报告批改" });
    const base = path.join(
      root,
      "assignments",
      assignment.id,
      "submissions",
      first.batchId,
      first.studentKey,
    );
    expect(await readFile(path.join(base, "metadata.json"), "utf8")).toContain(
      first.id,
    );
    await service.deleteSession(first.id);
    await expect(service.deleteSession(first.id)).resolves.toBeUndefined();
    await expect(service.getSession(first.id)).rejects.toThrow(/not found/i);
    await expect(
      readFile(path.join(base, "metadata.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.getSession(second.id)).toMatchObject({
      id: second.id,
    });
    service.close();
  });

  it("rejects deletion while submission conversion is still active", async () => {
    const { service, assignment, frozen, root } = await setup();
    const source = path.join(root, "active.pdf");
    await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "Active Student",
      studentNumber: "20269999",
      submissionTitle: "Active report",
      originalPath: source,
      originalFilename: "active.pdf",
      autoStartAfterConversion: false,
    });

    await expect(service.deleteSession(session.id)).rejects.toThrow(/active/i);
    expect(await service.getSession(session.id)).toMatchObject({ id: session.id });
    service.close();
  });

  it("hides deletion tombstones from every ordinary session query", async () => {
    const { service, assignment, frozen, root } = await setup();
    const source = path.join(root, "tombstone.md");
    await writeFile(source, "# Tombstone\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "Deleted Student",
      studentNumber: "20269998",
      submissionTitle: "Deleted report",
      originalPath: source,
      originalFilename: "tombstone.md",
      autoStartAfterConversion: false,
    });
    const database = new Database(path.join(root, "grading.sqlite"));
    database
      .prepare("UPDATE grading_sessions SET deletion_pending = 1 WHERE id = ?")
      .run(session.id);
    database.close();

    await expect(service.getSession(session.id)).rejects.toThrow(/not found/i);
    expect(
      (await service.listSessions()).some(({ id }) => id === session.id),
    ).toBe(false);
    service.close();
  });

  it("serializes submission file writes with session deletion", async () => {
    const { service, assignment, frozen, root } = await setup();
    const source = path.join(root, "serialized.md");
    await writeFile(source, "# Original\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "Concurrent Student",
      studentNumber: "20269997",
      submissionTitle: "Concurrent report",
      originalPath: source,
      originalFilename: "serialized.md",
      autoStartAfterConversion: false,
    });
    const filesystem = (
      service as unknown as {
        filesystem: {
          writeText(path: string, value: string): Promise<void>;
        };
      }
    ).filesystem;
    const originalWrite = filesystem.writeText.bind(filesystem);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    filesystem.writeText = async (target, value) => {
      if (target.endsWith("submission-v2.md")) {
        started();
        await waiting;
      }
      await originalWrite(target, value);
    };

    const saving = service.saveSubmission(session.id, 1, "# Edited\n");
    await writing;
    let deleteSettled = false;
    const deleting = service.deleteSession(session.id).then(() => {
      deleteSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const deletedBeforeWriteFinished = deleteSettled;
    release();
    await Promise.all([saving, deleting]);

    expect(deletedBeforeWriteFinished).toBe(false);
    await expect(service.getSession(session.id)).rejects.toThrow(/not found/i);
    await expect(
      readFile(
        path.join(
          root,
          "assignments",
          assignment.id,
          "submissions",
          session.batchId,
          session.studentKey,
          "converted",
          "submission-v2.md",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    service.close();
  });

  it("rejects legacy .doc and accepts only complete manually supplied identity", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "legacy.doc");
    await writeFile(source, Buffer.from("legacy"));
    await expect(
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: source,
        originalFilename: "报告.doc",
        autoStartAfterConversion: false,
      }),
    ).rejects.toBeInstanceOf(UnsupportedSubmissionTypeError);
    await expect(
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "",
        originalPath: source,
        originalFilename: "报告.docx",
        autoStartAfterConversion: false,
      }),
    ).rejects.toThrow(/both student name and number/i);
    service.close();
  });

  it("rejects spoofed extensions and uncontrolled Markdown images", async () => {
    const { root, assignment, frozen, service } = await setup();
    const fakePdf = path.join(root, "fake.pdf");
    await writeFile(fakePdf, "not a pdf", "utf8");
    await expect(
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: fakePdf,
        originalFilename: "report.pdf",
        autoStartAfterConversion: false,
      }),
    ).rejects.toThrow(/does not match/i);
    const fakeDocx = path.join(root, "fake.docx");
    await writeFile(
      fakeDocx,
      zipSync({ "payload.txt": strToU8("not office") }),
    );
    await expect(
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: fakeDocx,
        originalFilename: "report.docx",
        autoStartAfterConversion: false,
      }),
    ).rejects.toThrow(/does not match/i);
    const remoteMarkdown = path.join(root, "remote.md");
    await writeFile(
      remoteMarkdown,
      "# 报告\n\n![跟踪图](https://example.com/pixel.png)\n",
      "utf8",
    );
    await expect(
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: remoteMarkdown,
        originalFilename: "report.md",
        autoStartAfterConversion: false,
      }),
    ).rejects.toMatchObject({ code: "SUBMISSION_ASSET_MISSING" });
    service.close();
  });

  it("isolates identical student numbers using generated storage keys", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\n", "utf8");
    const create = () =>
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "同名学生",
        studentNumber: "20260001",
        originalPath: source,
        originalFilename: "report.md",
        autoStartAfterConversion: false,
      });
    const first = await create();
    const second = await create();
    expect(first.studentKey).not.toBe(second.studentKey);
    expect(first.batchId).not.toBe(second.batchId);
    expect((await service.listSessions()).map(({ id }) => id)).toEqual([
      second.id,
      first.id,
    ]);
    service.close();
  });

  it("preserves revision assets and includes their hashes after Markdown edits", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "revision.md");
    await writeFile(source, "# Report\n\n![图表](assets/chart.png)\n", "utf8");
    const create = (bytes: Uint8Array) =>
      service.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        originalPath: source,
        originalFilename: "revision.md",
        autoStartAfterConversion: false,
        revisionAssets: [{ path: "assets/chart.png", bytes }],
      });
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const firstBytes = new Uint8Array([...signature, 1, 2, 3]);
    const secondBytes = new Uint8Array([...signature, 4, 5, 6]);
    const first = await create(firstBytes);
    const second = await create(secondBytes);
    expect(
      await service.readSubmissionAsset(first.id, "assets/chart.png"),
    ).toEqual(firstBytes);
    const editedMarkdown = "# Report edited\n\n![图表](assets/chart.png)\n";
    const firstEdited = await service.saveSubmission(
      first.id,
      1,
      editedMarkdown,
    );
    const secondEdited = await service.saveSubmission(
      second.id,
      1,
      editedMarkdown,
    );
    expect(firstEdited.submissionHash).not.toBe(secondEdited.submissionHash);
    service.close();
  });

  it("uses optimistic versions for Markdown edits and locks the submission when grading starts", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\nOriginal\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "report.md",
      autoStartAfterConversion: false,
    });

    const edited = await service.saveSubmission(
      session.id,
      1,
      "# Report\nEdited\n",
    );
    expect(edited.submissionVersion).toBe(2);
    await expect(
      service.saveSubmission(session.id, 1, "stale"),
    ).rejects.toBeInstanceOf(GradingConflictError);

    const locked = await service.lockSubmissionForGrading(session.id);
    expect(locked.gradingStatus).toBe("queued");
    await expect(
      service.saveSubmission(session.id, 2, "late edit"),
    ).rejects.toThrow(/locked/i);
    expect(await service.readSubmission(session.id)).toContain("Edited");
    service.close();
  });

  it("rejects invalid grading state transitions", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "report.md",
      autoStartAfterConversion: false,
    });
    await expect(
      service.setGradingStatus(session.id, "confirmed"),
    ).rejects.toThrow(/invalid grading status transition/i);
    await service.lockSubmissionForGrading(session.id);
    await service.setGradingStatus(session.id, "draft_ready");
    await expect(
      service.setGradingStatus(
        session.id,
        "waiting_for_teacher",
        "run-question",
      ),
    ).resolves.toMatchObject({
      gradingStatus: "waiting_for_teacher",
      activeRunId: "run-question",
    });
    service.close();
  });

  it("allows a batch-reserved needs-review session to queue for regrading", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "review-retry.md");
    await writeFile(source, "# Report\n", "utf8");
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "复核学生",
      studentNumber: "20260099",
      originalPath: source,
      originalFilename: "review-retry.md",
      autoStartAfterConversion: false,
    });
    await service.lockSubmissionForGrading(session.id);
    await service.setGradingStatus(session.id, "needs_review");

    await expect(service.lockSubmissionForGrading(session.id, { allowBatchReservation: true }))
      .resolves.toMatchObject({ gradingStatus: "queued" });
    service.close();
  });

  it("restores persisted sessions without recreating them", async () => {
    const { root, rubrics, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.pdf");
    await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
    const created = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "张晓明",
      studentNumber: "20260001",
      originalPath: source,
      originalFilename: "report.pdf",
      autoStartAfterConversion: true,
    });
    expect(created.conversionStatus).toBe("queued");
    service.close();

    const restoredService = new GradingSessionService(root, rubrics);
    expect(await restoredService.getSession(created.id)).toMatchObject({
      id: created.id,
      conversionStatus: "queued",
      autoStartAfterConversion: true,
    });
    restoredService.close();
  });

  it("persists structured conversion failures and clears them on a permitted retry", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.pdf");
    await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "Student",
      studentNumber: "20260009",
      originalPath: source,
      originalFilename: "report.pdf",
      autoStartAfterConversion: false,
    });

    await service.beginConversionAttempt(session.id);
    const waiting = await service.recordConversionFailure(session.id, {
      status: "waiting_for_converter",
      code: "CONVERTER_UNAVAILABLE",
      message: "转换服务当前不可用，原始作业已安全保存。",
      retryable: true,
      nextRetryAt: "2026-08-04T10:00:05.000Z",
    });

    expect(waiting).toMatchObject({
      conversionStatus: "waiting_for_converter",
      conversionAttemptCount: 1,
      conversionError: {
        code: "CONVERTER_UNAVAILABLE",
        message: "转换服务当前不可用，原始作业已安全保存。",
        retryable: true,
        lastFailedAt: "2026-08-04T10:00:00.000Z",
        nextRetryAt: "2026-08-04T10:00:05.000Z",
      },
    });
    expect(
      (await service.listPendingConversions()).map(({ id }) => id),
    ).toContain(session.id);

    const retried = await service.retryConversion(session.id);
    expect(retried).toMatchObject({
      conversionStatus: "queued",
      conversionAttemptCount: 0,
    });
    expect(retried.conversionError).toBeUndefined();
    service.close();
  });

  it("does not permit retrying a locally rejected conversion result", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.pdf");
    await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
    const session = await service.createSession({
      assignmentId: assignment.id,
      rubricVersion: frozen.version,
      studentName: "Student",
      studentNumber: "20260010",
      originalPath: source,
      originalFilename: "report.pdf",
      autoStartAfterConversion: false,
    });
    await service.beginConversionAttempt(session.id);
    await service.recordConversionFailure(session.id, {
      status: "result_rejected",
      code: "RESULT_REJECTED",
      message: "转换结果未通过安全或格式校验。",
      retryable: false,
    });

    await expect(service.retryConversion(session.id)).rejects.toThrow(
      /cannot be retried/i,
    );
    service.close();
  });

  it("migrates pre-title session rows without losing existing control state", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grading-session-migration-"),
    );
    roots.push(root);
    const rubrics = new RubricService(root);
    const database = new Database(path.join(root, "grading.sqlite"));
    database.exec(`CREATE TABLE grading_sessions (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL, rubric_version INTEGER NOT NULL, rubric_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL UNIQUE, student_key TEXT NOT NULL UNIQUE, student_name TEXT NOT NULL, student_number TEXT NOT NULL, title TEXT NOT NULL,
      auto_start INTEGER NOT NULL, conversion_status TEXT NOT NULL, grading_status TEXT NOT NULL, active_run_id TEXT, submission_version INTEGER,
      submission_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    database
      .prepare(
        "INSERT INTO grading_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "11111111-2222-4333-8444-555555555555",
        "11111111-1111-4111-8111-111111111111",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        1,
        "hash",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "旧学生",
        "20250001",
        "旧会话",
        0,
        "ready",
        "not_started",
        null,
        1,
        "submission-hash",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    database.close();
    const service = new GradingSessionService(root, rubrics);
    expect(
      await service.getSession("11111111-2222-4333-8444-555555555555"),
    ).toMatchObject({
      title: "旧会话",
      studentNumber: "20250001",
      submissionTitleStatus: "pending",
    });
    service.close();
  });
});
