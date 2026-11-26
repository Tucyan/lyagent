import { describe, expect, it } from "vitest";
import {
  buildBatchGradingExportHref,
  buildExportFilename,
  buildSingleGradingExportHref,
  computeExportSummaryStats,
  countSelectedExportColumns,
  exportPresetOptions,
  filterExportPreviewRows,
  filterExportSelectedRows,
  getVisibleSelectionState,
  hasSelectedExportColumn,
  normalizeGradingExportOptions,
  parseGradingExportLocation,
  pickPreferredExportRubric,
  pruneDeselectedSessionIds,
  resolveExportQuickReturn,
  serializeExportCsv,
  toggleAllVisibleExportRows,
  toggleExportRowSelection,
  type ExportPreviewRow,
} from "../web/src/pages/grading-export-page-model.js";

describe("grading export page model", () => {
  it("exposes quick-return ONLY when entered from single grading or batch grading", () => {
    const direct = parseGradingExportLocation("?course=c1");
    expect(resolveExportQuickReturn(direct, "c1")).toBeUndefined();

    const tampered = parseGradingExportLocation("?from=dashboard&course=c1");
    expect(resolveExportQuickReturn(tampered, "c1")).toBeUndefined();

    const fromSingle = parseGradingExportLocation(
      buildSingleGradingExportHref({
        courseId: "c1",
        rubricKey: "a1:2",
        sessionId: "s1",
        studentNumber: "20260001",
      }).split("?")[1]!,
    );
    expect(fromSingle).toMatchObject({
      from: "grading",
      course: "c1",
      rubric: "a1:2",
      session: "s1",
      student: "20260001",
    });
    expect(resolveExportQuickReturn(fromSingle, "c1")).toEqual({
      origin: "grading",
      label: "返回单份批改",
      href: "/grading?session=s1&course=c1",
    });

    const fromSingleRubricOnly = parseGradingExportLocation("?from=grading&course=c1&rubric=a1%3A2");
    expect(resolveExportQuickReturn(fromSingleRubricOnly, "c1")).toEqual({
      origin: "grading",
      label: "返回单份批改",
      href: "/grading?rubric=a1%3A2&course=c1",
    });

    const fromBatch = parseGradingExportLocation(
      buildBatchGradingExportHref({
        courseId: "c1",
        batchId: "b1",
        rubricKey: "a1:2",
      }).split("?")[1]!,
    );
    expect(fromBatch).toMatchObject({
      from: "batch",
      scope: "batch",
      course: "c1",
      batch: "b1",
      rubric: "a1:2",
    });
    expect(resolveExportQuickReturn(fromBatch, "c1")).toEqual({
      origin: "batch",
      label: "返回批量批改",
      href: "/grading/batches?batch=b1&rubric=a1%3A2&course=c1",
    });
  });

  it("filters rows by keyword and score range regardless of exported column visibility, and recomputes stats", () => {
    const rows: ExportPreviewRow[] = [
      {
        sessionId: "s1",
        studentName: "=恶意张三",
        studentNumber: "20260001",
        submissionTitle: "报告A",
        reviewStatus: "confirmed",
        earnedScore: 90,
        possibleScore: 100,
        overallConfidence: 0.92,
        cells: ["=恶意张三", "20260001"],
      },
      {
        sessionId: "s2",
        studentName: "李四",
        studentNumber: "20260002",
        submissionTitle: "报告B",
        reviewStatus: "needs_review",
        earnedScore: 70,
        possibleScore: 100,
        overallConfidence: 0.78,
        cells: ["李四", "20260002"],
      },
      {
        sessionId: "s3",
        studentName: "李四",
        studentNumber: "20260002",
        submissionTitle: "报告C",
        reviewStatus: "confirmed",
        earnedScore: 80,
        possibleScore: 100,
        overallConfidence: 0.88,
        cells: ["李四", "20260002"],
      },
    ];

    expect(computeExportSummaryStats(rows)).toEqual({
      totalCount: 3,
      uniqueStudentCount: 2,
      confirmedCount: 2,
      needsReviewCount: 1,
      averageScore: 80,
      highestScore: 90,
      lowestScore: 70,
      hasUniformPossibleScore: true,
      commonPossibleScore: 100,
      averageScoreRate: 80,
      highestScoreRate: 90,
      lowestScoreRate: 70,
    });

    const filtered = filterExportPreviewRows(rows, {
      query: "李四",
      minScore: "75",
      maxScore: "95",
    });
    expect(filtered.map((row) => row.sessionId)).toEqual(["s3"]);
    expect(computeExportSummaryStats(filtered)).toEqual({
      totalCount: 1,
      uniqueStudentCount: 1,
      confirmedCount: 1,
      needsReviewCount: 0,
      averageScore: 80,
      highestScore: 80,
      lowestScore: 80,
      hasUniformPossibleScore: true,
      commonPossibleScore: 100,
      averageScoreRate: 80,
      highestScoreRate: 80,
      lowestScoreRate: 80,
    });

    const mixedScaleRows: ExportPreviewRow[] = [
      { ...rows[0]!, earnedScore: 19, possibleScore: 20 },
      { ...rows[1]!, earnedScore: 70, possibleScore: 100 },
    ];
    expect(computeExportSummaryStats(mixedScaleRows)).toMatchObject({
      hasUniformPossibleScore: false,
      commonPossibleScore: null,
      averageScoreRate: 82.5,
      highestScoreRate: 95,
      lowestScoreRate: 70,
    });

    const csv = serializeExportCsv(["学生姓名", "学号"], [rows[0]!]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("'=恶意张三,20260001");
  });

  it("validates selected columns, supports rubricName and all preset, and manages row selection state", () => {
    const empty = normalizeGradingExportOptions({
      studentName: false,
      studentNumber: false,
      submissionTitle: false,
      rubricName: false,
      itemDetails: false,
      itemConfidence: false,
      totalScore: false,
      possibleScore: false,
      scoreRate: false,
      overallConfidence: false,
      reviewStatus: false,
    });
    expect(hasSelectedExportColumn(empty)).toBe(false);
    expect(countSelectedExportColumns(empty)).toBe(0);

    const studentSummary = exportPresetOptions("student-summary");
    expect(studentSummary).toMatchObject({
      studentName: true,
      submissionTitle: true,
      rubricName: true,
      itemDetails: false,
      totalScore: true,
      possibleScore: true,
      scoreRate: true,
      overallConfidence: true,
    });

    const allColumns = exportPresetOptions("all");
    expect(allColumns).toEqual({
      studentName: true,
      studentNumber: true,
      submissionTitle: true,
      rubricName: true,
      itemDetails: true,
      itemConfidence: true,
      totalScore: true,
      possibleScore: true,
      scoreRate: true,
      overallConfidence: true,
      reviewStatus: true,
    });
    expect(countSelectedExportColumns(allColumns)).toBe(11);

    expect(
      pickPreferredExportRubric([
        { assignmentId: "a1", version: 2, sessionCount: 0, confirmedCount: 0 },
        { assignmentId: "a1", version: 1, sessionCount: 40, confirmedCount: 40 },
      ], ""),
    ).toBe("a1:1");

    const sampleRows: ExportPreviewRow[] = [
      {
        sessionId: "s1",
        studentName: "张三",
        studentNumber: "20260001",
        submissionTitle: "报告A",
        reviewStatus: "confirmed",
        earnedScore: 90,
        possibleScore: 100,
        overallConfidence: 0.9,
        cells: ["张三"],
      },
      {
        sessionId: "s2",
        studentName: "李四",
        studentNumber: "20260002",
        submissionTitle: "报告B",
        reviewStatus: "confirmed",
        earnedScore: 70,
        possibleScore: 100,
        overallConfidence: 0.8,
        cells: ["李四"],
      },
    ];

    expect(getVisibleSelectionState(sampleRows, new Set())).toEqual({
      selectedCount: 2,
      allSelected: true,
      someSelected: false,
    });
    const oneDeselected = toggleExportRowSelection(new Set(), "s1", false);
    expect(getVisibleSelectionState(sampleRows, oneDeselected)).toEqual({
      selectedCount: 1,
      allSelected: false,
      someSelected: true,
    });
    expect(filterExportSelectedRows(sampleRows, oneDeselected).map((r) => r.sessionId)).toEqual(["s2"]);

    const visibleOnlyS2 = sampleRows.slice(1);
    const noneVisibleSelected = toggleAllVisibleExportRows(oneDeselected, visibleOnlyS2, false);
    expect(getVisibleSelectionState(visibleOnlyS2, noneVisibleSelected)).toEqual({
      selectedCount: 0,
      allSelected: false,
      someSelected: false,
    });
    const reselectedVisible = toggleAllVisibleExportRows(noneVisibleSelected, visibleOnlyS2, true);
    expect(filterExportSelectedRows(sampleRows, reselectedVisible).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(Array.from(pruneDeselectedSessionIds(new Set(["s1", "gone"]), sampleRows))).toEqual(["s1"]);

    expect(buildExportFilename({
      scopeKind: "batch",
      batchTitle: "2026春/一班",
      includeUnconfirmed: false,
    })).toBe("2026春-一班-已确认成绩.csv");
    expect(buildExportFilename({
      scopeKind: "batch",
      batchTitle: "2026春/一班",
      includeUnconfirmed: true,
    })).toBe("2026春-一班-处理汇总.csv");
    expect(buildExportFilename({
      scopeKind: "rubric",
      rubricTitle: "实验一",
      rubricVersion: 2,
    })).toBe("实验一-v2-全部学生.csv");
    expect(buildExportFilename({
      scopeKind: "student",
      studentNumber: "20260001",
      studentName: "张晓明",
    })).toBe("20260001-张晓明-全部作业.csv");
  });
});
