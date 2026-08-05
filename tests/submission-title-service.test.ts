import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiAssignmentGrader } from "../src/agents/assignment-grader/agent.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { RubricService } from "../src/services/rubric-service.js";
import { SubmissionTitleService } from "../src/services/submission-title-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(submissionTitle?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "submission-title-")); roots.push(root);
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({ courseId: "11111111-1111-4111-8111-111111111111", title: "评分表", totalScore: 10, requirements: "评分", sources: [] });
  await rubrics.selectMode(assignment.id, "additive");
  await rubrics.createDraft(assignment.id, { schemaVersion: "1.0", mode: "additive", totalScore: 10, partialCreditAllowed: true, criteria: [{ id: "C1", name: "内容", description: "内容", maxScore: 10, scorePolicy: "range", evidenceRequired: true, levels: [{ id: "L1", minScore: 5, maxScore: 10, condition: "完整" }, { id: "L0", minScore: 0, maxScore: 4.99, condition: "缺失" }] }] });
  await rubrics.freeze(assignment.id, 1, []);
  const source = path.join(root, "filename-topic.md"); await writeFile(source, "# 正文主题\n", "utf8");
  const sessions = new GradingSessionService(root, rubrics);
  const session = await sessions.createSession({ assignmentId: assignment.id, rubricVersion: 1, studentName: "张晓明", studentNumber: "20260001", ...(submissionTitle ? { submissionTitle } : {}), originalPath: source, originalFilename: "文件名主题.md", autoStartAfterConversion: false });
  return { sessions, session };
}

describe("SubmissionTitleService", () => {
  it("requires one successful naming outcome for an omitted title", async () => {
    const { sessions, session } = await fixture();
    const run = vi.fn(async () => {
      await sessions.resolveSubmissionTitle(session.id, "正文主题");
      return { kind: "title" as const, title: "正文主题" };
    });
    const agent: PiAssignmentGrader = { run };
    const service = new SubmissionTitleService(sessions, () => agent);
    await expect(service.resolve(session.id)).resolves.toMatchObject({ submissionTitle: "正文主题", submissionTitleStatus: "resolved" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: "name" }), undefined, undefined);
    await service.resolve(session.id);
    expect(run).toHaveBeenCalledTimes(1);
    sessions.close();
  });

  it("skips the Agent for a manual title and marks invalid outcomes failed", async () => {
    const manual = await fixture("教师填写标题");
    const manualRun = vi.fn();
    await new SubmissionTitleService(manual.sessions, () => ({ run: manualRun } as PiAssignmentGrader)).resolve(manual.session.id);
    expect(manualRun).not.toHaveBeenCalled();
    manual.sessions.close();

    const pending = await fixture();
    const service = new SubmissionTitleService(pending.sessions, () => ({ async run() { return { kind: "reply", reply: "只是文本" }; } }));
    await expect(service.resolve(pending.session.id)).rejects.toThrow(/naming tool/i);
    expect(await pending.sessions.getSession(pending.session.id)).toMatchObject({ submissionTitleStatus: "failed" });
    pending.sessions.close();
  });

  it("persists an active naming state so deletion cannot race a retry", async () => {
    const pending = await fixture();
    await pending.sessions.markSubmissionTitleFailed(pending.session.id);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new SubmissionTitleService(pending.sessions, () => ({
      async run() {
        started();
        await waiting;
        await pending.sessions.resolveSubmissionTitle(
          pending.session.id,
          "正文主题",
        );
        return { kind: "title" as const, title: "正文主题" };
      },
    }));

    const resolving = service.resolve(pending.session.id);
    await active;
    expect(await pending.sessions.getSession(pending.session.id)).toMatchObject({
      submissionTitleStatus: "resolving",
    });
    await expect(
      pending.sessions.deleteSession(pending.session.id),
    ).rejects.toThrow(/active/i);
    release();
    await resolving;
    pending.sessions.close();
  });
});
