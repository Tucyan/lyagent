import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GradingBatchService } from "../src/services/grading-batch-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import { MaterialService } from "../src/services/material-service.js";
import { RubricService } from "../src/services/rubric-service.js";

const roots: string[] = [];

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-naming-"));
  roots.push(root);
  const materials = new MaterialService(root);
  const course = await materials.createCourse("人工智能导论");
  const rubrics = new RubricService(root);
  const assignment = await rubrics.createAssignment({
    courseId: course.id,
    title: "期末报告评分标准",
    totalScore: 100,
    requirements: "提交课程报告",
    sources: [],
  });
  await rubrics.selectMode(assignment.id, "additive");
  await rubrics.createDraft(assignment.id, {
    schemaVersion: "1.0",
    mode: "additive",
    totalScore: 100,
    partialCreditAllowed: true,
    criteria: [{
      id: "content",
      name: "内容质量",
      description: "内容完整准确",
      maxScore: 100,
      scorePolicy: "continuous",
      evidenceRequired: false,
    }],
  });
  const frozen = await rubrics.freeze(assignment.id, 1, ["CONTINUOUS_WITHOUT_ANCHORS"]);
  const sessions = new GradingSessionService(root, rubrics);
  const makeReport = async (name: string, content: string) => {
    const filePath = path.join(root, name);
    await writeFile(filePath, content, "utf8");
    return filePath;
  };
  return { root, rubrics, assignment, frozen, sessions, makeReport };
}

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("unified automatic naming and manual rename across single and batch grading", () => {
  it("auto-names a session from studentName + submissionTitle on creation and upon title resolution without overriding manual renames", async () => {
    const { assignment, frozen, sessions, makeReport } = await makeWorkspace();
    try {
      const provided = await sessions.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        submissionTitle: "生成式 AI 生活助手的设计与实现报告",
        originalFilename: "20260001_张晓明_report.md",
        originalPath: await makeReport("20260001_张晓明_report.md", "# 生成式 AI 生活助手的设计与实现报告\n\n正文"),
        autoStartAfterConversion: false,
      });
      expect(provided.title).toBe("张晓明 · 生成式 AI 生活助手的设计与实现报告");

      const pending = await sessions.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "李华",
        studentNumber: "20260002",
        originalFilename: "20260002_李华_report.md",
        originalPath: await makeReport("20260002_李华_report.md", "# 校园智能答疑系统报告\n\n正文"),
        autoStartAfterConversion: false,
      });
      expect(pending.title).toBe("李华 · 20260002");

      const resolved = await sessions.resolveSubmissionTitle(pending.id, "校园智能答疑系统报告");
      expect(resolved.title).toBe("李华 · 校园智能答疑系统报告");

      const manual = await sessions.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "王芳",
        studentNumber: "20260003",
        originalFilename: "20260003_王芳_report.md",
        originalPath: await makeReport("20260003_王芳_report.md", "# 未命名草稿\n\n正文"),
        autoStartAfterConversion: false,
      });
      await sessions.renameSession(manual.id, "王芳 · 重点复核样本");
      const resolvedManual = await sessions.resolveSubmissionTitle(manual.id, "自动识别出来的标题");
      expect(resolvedManual.title).toBe("王芳 · 重点复核样本");
    } finally {
      sessions.close();
    }
  });

  it("supports renaming a grading batch with validation", async () => {
    const { root, assignment, frozen, sessions, makeReport } = await makeWorkspace();
    const batches = new GradingBatchService(root, {
      getSession: (id) => sessions.getSession(id),
      execute: async () => ({ status: "completed" }),
      readResult: async () => undefined,
    });
    try {
      const s1 = await sessions.createSession({
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        studentName: "张晓明",
        studentNumber: "20260001",
        submissionTitle: "报告一",
        originalFilename: "20260001_张晓明_report.md",
        originalPath: await makeReport("20260001_张晓明_report.md", "# 报告一\n\n正文"),
        autoStartAfterConversion: false,
      });
      const created = await batches.createBatch({
        title: "期末报告评分标准 · 批量批改",
        assignmentId: assignment.id,
        rubricVersion: frozen.version,
        concurrency: 2,
        sessionIds: [s1.id],
      });
      const renamed = await batches.renameBatch(created.id, "2026 春季班 · 期末报告一批");
      expect(renamed.title).toBe("2026 春季班 · 期末报告一批");
      expect((await batches.getBatch(created.id)).title).toBe("2026 春季班 · 期末报告一批");
      await expect(batches.renameBatch(created.id, "   ")).rejects.toThrow();
    } finally {
      batches.close();
      sessions.close();
    }
  });
});
