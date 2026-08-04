import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
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
  const assignment = await rubrics.createAssignment({ courseId, title: "AI 应用报告", totalScore: 100, requirements: "按报告完整性扣分", sources: [] });
  await rubrics.selectMode(assignment.id, "deductive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0", mode: "deductive", totalScore: 100, overlapGroups: [],
    rules: [{ id: "missing", name: "缺少内容", condition: "报告缺少核心内容", deduction: 20, maxDeduction: 20, occurrence: "once", evidenceRequired: true }],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, []);
  const service = new GradingSessionService(root, rubrics, { now: () => "2026-08-04T10:00:00.000Z" });
  return { root, rubrics, assignment, frozen, service };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    });
    expect(session.id).not.toBe(session.studentKey);
    expect(session.batchId).not.toBe(session.studentKey);
    const metadata = JSON.parse(await readFile(path.join(root, "assignments", assignment.id, "submissions", session.batchId, session.studentKey, "metadata.json"), "utf8"));
    expect(metadata.originalFilename).toBe("20260001_张晓明_报告.md");
    expect(metadata.originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.readSubmission(session.id)).toContain("第一行内容");
    service.close();
  });

  it("rejects legacy .doc and accepts only complete manually supplied identity", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "legacy.doc");
    await writeFile(source, Buffer.from("legacy"));
    await expect(service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "报告.doc", autoStartAfterConversion: false })).rejects.toBeInstanceOf(UnsupportedSubmissionTypeError);
    await expect(service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "", originalPath: source, originalFilename: "报告.docx", autoStartAfterConversion: false })).rejects.toThrow(/both student name and number/i);
    service.close();
  });

  it("rejects spoofed extensions and uncontrolled Markdown images", async () => {
    const { root, assignment, frozen, service } = await setup();
    const fakePdf = path.join(root, "fake.pdf");
    await writeFile(fakePdf, "not a pdf", "utf8");
    await expect(service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: fakePdf, originalFilename: "report.pdf", autoStartAfterConversion: false })).rejects.toThrow(/does not match/i);
    const fakeDocx = path.join(root, "fake.docx");
    await writeFile(fakeDocx, zipSync({ "payload.txt": strToU8("not office") }));
    await expect(service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: fakeDocx, originalFilename: "report.docx", autoStartAfterConversion: false })).rejects.toThrow(/does not match/i);
    const remoteMarkdown = path.join(root, "remote.md");
    await writeFile(remoteMarkdown, "# 报告\n\n![跟踪图](https://example.com/pixel.png)\n", "utf8");
    await expect(service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: remoteMarkdown, originalFilename: "report.md", autoStartAfterConversion: false })).rejects.toThrow(/imported submission asset/i);
    service.close();
  });

  it("isolates identical student numbers using generated storage keys", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\n", "utf8");
    const create = () => service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "同名学生", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false });
    const first = await create();
    const second = await create();
    expect(first.studentKey).not.toBe(second.studentKey);
    expect(first.batchId).not.toBe(second.batchId);
    expect((await service.listSessions()).map(({ id }) => id)).toEqual([second.id, first.id]);
    service.close();
  });

  it("preserves revision assets and includes their hashes after Markdown edits", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "revision.md");
    await writeFile(source, "# Report\n\n![图表](assets/chart.png)\n", "utf8");
    const create = (bytes: Uint8Array) => service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "revision.md", autoStartAfterConversion: false, revisionAssets: [{ path: "assets/chart.png", bytes }] });
    const first = await create(new Uint8Array([1, 2, 3]));
    const second = await create(new Uint8Array([4, 5, 6]));
    expect(await service.readSubmissionAsset(first.id, "assets/chart.png")).toEqual(new Uint8Array([1, 2, 3]));
    const editedMarkdown = "# Report edited\n\n![图表](assets/chart.png)\n";
    const firstEdited = await service.saveSubmission(first.id, 1, editedMarkdown);
    const secondEdited = await service.saveSubmission(second.id, 1, editedMarkdown);
    expect(firstEdited.submissionHash).not.toBe(secondEdited.submissionHash);
    service.close();
  });

  it("uses optimistic versions for Markdown edits and locks the submission when grading starts", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\nOriginal\n", "utf8");
    const session = await service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false });

    const edited = await service.saveSubmission(session.id, 1, "# Report\nEdited\n");
    expect(edited.submissionVersion).toBe(2);
    await expect(service.saveSubmission(session.id, 1, "stale")).rejects.toBeInstanceOf(GradingConflictError);

    const locked = await service.lockSubmissionForGrading(session.id);
    expect(locked.gradingStatus).toBe("queued");
    await expect(service.saveSubmission(session.id, 2, "late edit")).rejects.toThrow(/locked/i);
    expect(await service.readSubmission(session.id)).toContain("Edited");
    service.close();
  });

  it("rejects invalid grading state transitions", async () => {
    const { root, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.md");
    await writeFile(source, "# Report\n", "utf8");
    const session = await service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.md", autoStartAfterConversion: false });
    await expect(service.setGradingStatus(session.id, "confirmed")).rejects.toThrow(/invalid grading status transition/i);
    await service.lockSubmissionForGrading(session.id);
    await service.setGradingStatus(session.id, "draft_ready");
    await expect(service.setGradingStatus(session.id, "waiting_for_teacher", "run-question")).resolves.toMatchObject({ gradingStatus: "waiting_for_teacher", activeRunId: "run-question" });
    service.close();
  });

  it("restores persisted sessions without recreating them", async () => {
    const { root, rubrics, assignment, frozen, service } = await setup();
    const source = path.join(root, "report.pdf");
    await writeFile(source, Buffer.from("%PDF-1.7 synthetic"));
    const created = await service.createSession({ assignmentId: assignment.id, rubricVersion: frozen.version, studentName: "张晓明", studentNumber: "20260001", originalPath: source, originalFilename: "report.pdf", autoStartAfterConversion: true });
    expect(created.conversionStatus).toBe("queued");
    service.close();

    const restoredService = new GradingSessionService(root, rubrics);
    expect(await restoredService.getSession(created.id)).toMatchObject({ id: created.id, conversionStatus: "queued", autoStartAfterConversion: true });
    restoredService.close();
  });
});
