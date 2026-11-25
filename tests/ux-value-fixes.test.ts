import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RubricService } from "../src/services/rubric-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";
import {
  exportPresetOptions,
  filterCsvPreviewRows,
  filterGradingSessions,
  parseCsvPreview,
  serializeCsvTable,
} from "../web/src/pages/grading-page-model.js";
import { filterBatchDetailJobs } from "../web/src/pages/grading-batch-page-model.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore Windows SQLite handle release delay in temp cleanup.
      }
    }
  }
});

describe("UX value-directness & friction fixes", () => {
  it("supports .txt student submissions in single grading session service", async () => {
    const root = makeTempDir("course-agent-txt-single-");
    const rubrics = new RubricService(root);
    const assignment = await rubrics.createAssignment({
      courseId: "course-1",
      title: "栈与队列作业",
      totalScore: 100,
      requirements: "简述栈与队列区别",
      sources: [],
    });
    await rubrics.selectMode(assignment.id, "deductive");
    const draft = await rubrics.createDraft(assignment.id, {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [
        {
          id: "core_concept",
          name: "核心概念缺失",
          condition: "未区分 LIFO 与 FIFO",
          deduction: 20,
          maxDeduction: 20,
          occurrence: "once",
          evidenceRequired: true,
        },
      ],
      overlapGroups: [],
    });
    await rubrics.freeze(assignment.id, draft.version, []);

    const originalPath = path.join(root, "homework_zhangsan.txt");
    writeFileSync(originalPath, "学生姓名：张三\n栈是 LIFO，队列是 FIFO。", "utf8");
    const sessions = new GradingSessionService(root, rubrics);
    const created = await sessions.createSession({
      assignmentId: assignment.id,
      rubricVersion: 1,
      studentName: "张三",
      studentNumber: "20240101",
      originalPath,
      originalFilename: "homework_zhangsan.txt",
      autoStartAfterConversion: false,
    });

    expect(created.conversionStatus).toBe("ready");
    const markdown = await sessions.readSubmission(created.id);
    expect(markdown).toContain("栈是 LIFO，队列是 FIFO。");
  });

  it("supports .txt student submissions in batch grading upload service", () => {
    const batchServiceSource = readFileSync(path.resolve("src/services/grading-batch-upload-service.ts"), "utf8");
    expect(batchServiceSource).toContain('".txt"');
  });

  it("unifies responsive drawer breakpoint at max-width 960px without overlapping admin-main", () => {
    const polishCss = readFileSync(path.resolve("web/src/styles/ux-polish.css"), "utf8");
    const media960 = polishCss.slice(polishCss.indexOf("@media (max-width: 960px)"));
    expect(media960).toContain(".admin-nav");
    expect(media960).toContain("translateX");
    expect(media960).toContain(".admin-main");
    expect(media960).toContain("grid-column: 1");
  });

  it("removes webkitdirectory lock-in in KnowledgeLibraryPage", () => {
    const source = readFileSync(path.resolve("web/src/pages/KnowledgeLibraryPage.tsx"), "utf8");
    expect(source).not.toContain("webkitdirectory = true");
  });

  it("provides a direct link to knowledge library from CourseQaPage when knowledge is missing or errored", () => {
    const source = readFileSync(path.resolve("web/src/pages/CourseQaPage.tsx"), "utf8");
    expect(source).toContain("前往整理课程资料");
    expect(source).toContain("/knowledge?course=");
  });

  it("provides next-step grading links from RubricPage when a rubric is frozen", () => {
    const source = readFileSync(path.resolve("web/src/pages/RubricPage.tsx"), "utf8");
    expect(source).toContain("前往单份批改");
    expect(source).toContain("前往批量批改");
  });

  it("accepts .txt files and validates missing file in GradingPage and GradingBatchPage", () => {
    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    const batch = readFileSync(path.resolve("web/src/pages/GradingBatchPage.tsx"), "utf8");
    expect(grading).toContain(".txt");
    expect(batch).toContain(".txt");
    expect(grading).toContain("请先选择学生报告文件");
  });

  it("aligns dashboard copy with supported Markdown knowledge library format", () => {
    const model = readFileSync(path.resolve("web/src/pages/dashboard-model.ts"), "utf8");
    expect(model).not.toContain("支持 PDF、Word 与 Markdown");
    expect(model).toContain("Markdown");
  });

  it("keeps DashboardPage focused on 3 human-friendly sections with SVG workflow guides", () => {
    const dashboard = readFileSync(path.resolve("web/src/pages/DashboardPage.tsx"), "utf8");
    expect(dashboard).toContain("课程管理");
    expect(dashboard).toContain("课程与知识");
    expect(dashboard).toContain("评分与批改");
    expect(dashboard).toContain("<svg");
    expect(dashboard).not.toContain("metric-grid");
    expect(dashboard).not.toContain("最近工作");
  });

  it("includes red/yellow/green field guidance borders on RubricPage creation form", () => {
    const rubric = readFileSync(path.resolve("web/src/pages/RubricPage.tsx"), "utf8");
    const polishCss = readFileSync(path.resolve("web/src/styles/ux-polish.css"), "utf8");
    expect(rubric).toContain("is-missing");
    expect(rubric).toContain("is-optional");
    expect(rubric).toContain("is-ready");
    expect(polishCss).toContain(".rubric-guided-field.is-missing");
    expect(polishCss).toContain(".rubric-guided-field.is-optional");
    expect(polishCss).toContain(".rubric-guided-field.is-ready");
  });

  it("parses CSV preview with BOM, quoted commas, and presets for grading export", () => {
    const csv = '\uFEFF"学生姓名","总分","评语"\r\n"张三","92","逻辑清晰, ""结构完整"""\r\n"李四","85","不错"\r\n';
    const parsed = parseCsvPreview(csv);
    expect(parsed.headers).toEqual(["学生姓名", "总分", "评语"]);
    expect(parsed.rows).toEqual([
      ["张三", "92", '逻辑清晰, "结构完整"'],
      ["李四", "85", "不错"],
    ]);

    expect(exportPresetOptions("summary")).toMatchObject({
      studentName: true,
      studentNumber: true,
      submissionTitle: true,
      totalScore: true,
      itemDetails: false,
      overallConfidence: false,
      itemConfidence: false,
    });
    expect(exportPresetOptions("full").itemConfidence).toBe(true);

    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    expect(grading).toContain("ExportPreviewDialog");
    expect(grading).toContain("确认下载 CSV");
    expect(grading).toContain("filterCsvPreviewRows");

    const filteredByQuery = filterCsvPreviewRows(parsed, { query: "张三" });
    expect(filteredByQuery.rows).toHaveLength(1);
    expect(filteredByQuery.rows[0]?.[0]).toBe("张三");

    const filteredByScore = filterCsvPreviewRows(parsed, { minScore: "90", maxScore: "100" });
    expect(filteredByScore.rows).toHaveLength(1);
    expect(filteredByScore.rows[0]?.[0]).toBe("张三");

    const reserialized = serializeCsvTable(filteredByScore);
    expect(reserialized.startsWith("\uFEFF")).toBe(true);
    expect(parseCsvPreview(reserialized)).toEqual(filteredByScore);
  });

  it("fixes filtering UX across batch detail, batch review, and single grading", () => {
    const jobs = [
      { id: "1", studentName: "张三", studentNumber: "202401", submissionTitle: "栈与队列", status: "completed", reviewStatus: "needs_review" as const },
      { id: "2", studentName: "李四", studentNumber: "202402", submissionTitle: "二叉树", status: "failed" },
      { id: "3", studentName: "王五", studentNumber: "202403", submissionTitle: "图论", status: "waiting_for_teacher" },
      { id: "4", studentName: "赵六", studentNumber: "202404", submissionTitle: "排序", status: "completed", reviewStatus: "confirmed" as const },
    ];
    expect(filterBatchDetailJobs(jobs, "needs_review", "").map((j) => j.id)).toEqual(["1"]);
    expect(filterBatchDetailJobs(jobs, "failed", "").map((j) => j.id)).toEqual(["2"]);
    expect(filterBatchDetailJobs(jobs, "waiting_for_teacher", "").map((j) => j.id)).toEqual(["3"]);
    expect(filterBatchDetailJobs(jobs, "confirmed", "").map((j) => j.id)).toEqual(["4"]);
    expect(filterBatchDetailJobs(jobs, "all", "202402").map((j) => j.id)).toEqual(["2"]);

    const review = readFileSync(path.resolve("web/src/pages/GradingBatchReviewPage.tsx"), "utf8");
    expect(review).toContain("attentionCount === 0");
    expect(review).toContain("withCourseQuery(batchReviewHref");

    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    expect(grading).toContain("scoreFilterAvailable");
    expect(grading).toContain("sessionSearch");
    expect(grading).toContain("搜索评分标准");
    expect(grading).toContain("filterGradingSessions");

    const sampleSessions = [
      { id: "s1", studentName: "张三", studentNumber: "202401", title: "栈作业", conversionStatus: "ready", gradingStatus: "draft_ready" },
      { id: "s2", studentName: "李四", studentNumber: "202402", title: "队列作业", conversionStatus: "ready", gradingStatus: "confirmed" },
      { id: "s3", studentName: "王五", studentNumber: "202403", title: "树作业", conversionStatus: "conversion_failed", gradingStatus: "not_started" },
    ];
    expect(filterGradingSessions(sampleSessions, "all", "202401").map((s) => s.id)).toEqual(["s1"]);
    expect(filterGradingSessions(sampleSessions, "confirmed", "").map((s) => s.id)).toEqual(["s2"]);
    expect(filterGradingSessions(sampleSessions, "attention", "").map((s) => s.id)).toEqual(["s3"]);
    expect(filterGradingSessions(sampleSessions, "pending", "").map((s) => s.id)).toEqual(["s1"]);
  });

  it("keeps the CSV export workspace scrollable, flush to the pane without grading-split wrapper, and guarantees a visible table area", () => {
    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    expect(grading).not.toContain("creating || exportModalOpen");
    expect(grading).toMatch(/\{exportModalOpen \? \(\s*<ExportPreviewDialog[\s\S]*\) : \(\s*<section\s+className=\{`grading-split/);

    const polishCss = readFileSync(path.resolve("web/src/styles/ux-polish.css"), "utf8");

    const workspaceBlock = polishCss.match(/\.export-workspace\s*\{[^}]*\}/)?.[0] ?? "";
    expect(workspaceBlock).toContain("grid-column: 2;");
    expect(workspaceBlock).not.toContain("grid-row: 1 / -1");
    expect(workspaceBlock).toContain("overflow-y: auto");
    expect(workspaceBlock).toContain("margin: 0;");
    expect(workspaceBlock).toContain("padding: 0;");

    const controlsBlock = polishCss.match(/\.export-preview-controls\s*\{[^}]*\}/)?.[0] ?? "";
    expect(controlsBlock).toContain("margin: 0;");

    const modalBlock = polishCss.match(/\.export-preview-modal\s*\{[^}]*\}/)?.[0] ?? "";
    expect(modalBlock).toContain("min-height: 100%");
    expect(modalBlock).toContain("border: 0;");
    expect(modalBlock).not.toContain("overflow: hidden");

    const tableSectionBlock = polishCss.match(/\.export-preview-table-section\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tableSectionBlock).toContain("margin: 0;");
    expect(tableSectionBlock).toContain("minmax(240px, 1fr)");

    const tableWrapBlock = polishCss.match(/\.export-preview-table-wrap\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tableWrapBlock).toContain("min-height: 240px");
    expect(tableWrapBlock).toContain("overflow: auto");
  });
});
