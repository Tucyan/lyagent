export type GradingExportScopeKind = "batch" | "rubric" | "student";
export type GradingExportEntryOrigin = "grading" | "batch";

export interface GradingExportOptions {
  studentName: boolean;
  studentNumber: boolean;
  submissionTitle: boolean;
  rubricName: boolean;
  itemDetails: boolean;
  itemConfidence: boolean;
  totalScore: boolean;
  possibleScore: boolean;
  scoreRate: boolean;
  overallConfidence: boolean;
  reviewStatus: boolean;
}

export const defaultGradingExportOptions: GradingExportOptions = {
  studentName: true,
  studentNumber: true,
  submissionTitle: true,
  rubricName: true,
  itemDetails: true,
  itemConfidence: false,
  totalScore: true,
  possibleScore: false,
  scoreRate: false,
  overallConfidence: true,
  reviewStatus: false,
};

export type GradingExportPreset = "summary" | "detailed" | "full" | "all" | "student-summary";

export interface GradingExportLocation {
  course?: string;
  from?: GradingExportEntryOrigin;
  scope?: GradingExportScopeKind;
  batch?: string;
  rubric?: string;
  session?: string;
  student?: string;
  includeUnconfirmed?: boolean;
}

export interface ExportQuickReturn {
  origin: GradingExportEntryOrigin;
  label: string;
  href: string;
}

export interface ExportPreviewRow {
  sessionId: string;
  rubricKey?: string;
  rubricTitle?: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  reviewStatus: "confirmed" | "needs_review";
  earnedScore: number;
  possibleScore: number;
  overallConfidence: number;
  cells: Array<string | number>;
}

export interface ExportSummaryStats {
  totalCount: number;
  uniqueStudentCount: number;
  confirmedCount: number;
  needsReviewCount: number;
  averageScore: number | null;
  highestScore: number | null;
  lowestScore: number | null;
  hasUniformPossibleScore: boolean;
  commonPossibleScore: number | null;
  averageScoreRate: number | null;
  highestScoreRate: number | null;
  lowestScoreRate: number | null;
}

export interface CsvPreviewTable {
  headers: string[];
  rows: string[][];
}

export interface CsvPreviewFilter {
  query?: string;
  minScore?: string;
  maxScore?: string;
}

export function normalizeGradingExportOptions(
  value: Partial<GradingExportOptions>,
): GradingExportOptions {
  const normalized = {
    ...defaultGradingExportOptions,
    ...Object.fromEntries(
      Object.entries(value).map(([key, selected]) => [key, selected === true]),
    ),
  } as GradingExportOptions;
  if (!normalized.itemDetails) normalized.itemConfidence = false;
  return normalized;
}

export function parseGradingExportOptions(
  value: string | null,
): GradingExportOptions {
  if (!value) return { ...defaultGradingExportOptions };
  try {
    return normalizeGradingExportOptions(
      JSON.parse(value) as Partial<GradingExportOptions>,
    );
  } catch {
    return { ...defaultGradingExportOptions };
  }
}

export function hasSelectedExportColumn(options: GradingExportOptions): boolean {
  return Object.values(normalizeGradingExportOptions(options)).some(Boolean);
}

export function countSelectedExportColumns(options: GradingExportOptions): number {
  return Object.values(normalizeGradingExportOptions(options)).filter(Boolean).length;
}

export function exportPresetOptions(
  preset: GradingExportPreset,
  context: { includeUnconfirmed?: boolean } = {},
): GradingExportOptions {
  const reviewStatus = context.includeUnconfirmed === true;
  if (preset === "all") {
    return normalizeGradingExportOptions({
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
  }
  if (preset === "student-summary") {
    return normalizeGradingExportOptions({
      studentName: true,
      studentNumber: true,
      submissionTitle: true,
      rubricName: true,
      itemDetails: false,
      itemConfidence: false,
      totalScore: true,
      possibleScore: true,
      scoreRate: true,
      overallConfidence: true,
      reviewStatus,
    });
  }
  if (preset === "summary") {
    return normalizeGradingExportOptions({
      studentName: true,
      studentNumber: true,
      submissionTitle: true,
      rubricName: false,
      itemDetails: false,
      itemConfidence: false,
      totalScore: true,
      possibleScore: true,
      scoreRate: false,
      overallConfidence: false,
      reviewStatus,
    });
  }
  if (preset === "full") {
    return normalizeGradingExportOptions({
      studentName: true,
      studentNumber: true,
      submissionTitle: true,
      rubricName: true,
      itemDetails: true,
      itemConfidence: true,
      totalScore: true,
      possibleScore: true,
      scoreRate: false,
      overallConfidence: true,
      reviewStatus,
    });
  }
  return normalizeGradingExportOptions({
    studentName: true,
    studentNumber: true,
    submissionTitle: true,
    rubricName: true,
    itemDetails: true,
    itemConfidence: false,
    totalScore: true,
    possibleScore: false,
    scoreRate: false,
    overallConfidence: true,
    reviewStatus,
  });
}

export function pickPreferredExportRubric<
  T extends {
    assignmentId: string;
    version: number;
    sessionCount?: number;
    confirmedCount?: number;
  },
>(rubrics: readonly T[], preferredKey: string): string {
  if (rubrics.length === 0) return "";
  if (preferredKey) {
    const matched = rubrics.find(
      (item) => `${item.assignmentId}:${item.version}` === preferredKey,
    );
    if (matched) return preferredKey;
  }
  const withConfirmed = rubrics.find((item) => (item.confirmedCount ?? 0) > 0);
  if (withConfirmed) return `${withConfirmed.assignmentId}:${withConfirmed.version}`;
  const withSessions = rubrics.find((item) => (item.sessionCount ?? 0) > 0);
  if (withSessions) return `${withSessions.assignmentId}:${withSessions.version}`;
  return `${rubrics[0]!.assignmentId}:${rubrics[0]!.version}`;
}

export function hasMultipleRubricsInRows(
  rows: readonly Pick<ExportPreviewRow, "rubricKey">[],
): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.rubricKey) keys.add(row.rubricKey);
    if (keys.size >= 2) return true;
  }
  return false;
}

export function parseGradingExportLocation(search: string): GradingExportLocation {
  const params = new URLSearchParams(search);
  const rawFrom = params.get("from");
  const from: GradingExportEntryOrigin | undefined =
    rawFrom === "grading" || rawFrom === "batch" ? rawFrom : undefined;
  const rawScope = params.get("scope");
  const course = params.get("course")?.trim() || undefined;
  const batch = params.get("batch")?.trim() || undefined;
  const rubric = params.get("rubric")?.trim() || undefined;
  const session = params.get("session")?.trim() || undefined;
  const student = params.get("student")?.trim() || undefined;
  const rawIncludeUnconfirmed = params.get("includeUnconfirmed");
  const includeUnconfirmed =
    rawIncludeUnconfirmed === "true"
      ? true
      : rawIncludeUnconfirmed === "false"
        ? false
        : undefined;

  let scope: GradingExportScopeKind | undefined =
    rawScope === "batch" || rawScope === "rubric" || rawScope === "student"
      ? rawScope
      : undefined;
  if (!scope) {
    if (from === "batch" || batch) scope = "batch";
    else if (student && !rubric) scope = "student";
  }

  return {
    ...(course ? { course } : {}),
    ...(from ? { from } : {}),
    ...(scope ? { scope } : {}),
    ...(batch ? { batch } : {}),
    ...(rubric ? { rubric } : {}),
    ...(session ? { session } : {}),
    ...(student ? { student } : {}),
    ...(includeUnconfirmed !== undefined ? { includeUnconfirmed } : {}),
  };
}

export function resolveExportQuickReturn(
  location: GradingExportLocation,
  activeCourseId = "",
): ExportQuickReturn | undefined {
  const courseId = activeCourseId || location.course || "";
  if (location.from === "grading") {
    const params = new URLSearchParams();
    if (location.session) params.set("session", location.session);
    else if (location.rubric) params.set("rubric", location.rubric);
    if (courseId) params.set("course", courseId);
    const query = params.toString();
    return {
      origin: "grading",
      label: "返回单份批改",
      href: `/grading${query ? `?${query}` : ""}`,
    };
  }
  if (location.from === "batch") {
    const params = new URLSearchParams();
    if (location.batch) params.set("batch", location.batch);
    if (location.rubric) params.set("rubric", location.rubric);
    if (courseId) params.set("course", courseId);
    const query = params.toString();
    return {
      origin: "batch",
      label: "返回批量批改",
      href: `/grading/batches${query ? `?${query}` : ""}`,
    };
  }
  return undefined;
}

export function buildSingleGradingExportHref(input: {
  courseId?: string;
  rubricKey?: string;
  sessionId?: string;
  studentNumber?: string;
}): string {
  const params = new URLSearchParams({ from: "grading" });
  if (input.courseId) params.set("course", input.courseId);
  if (input.rubricKey) params.set("rubric", input.rubricKey);
  if (input.sessionId) params.set("session", input.sessionId);
  if (input.studentNumber) params.set("student", input.studentNumber);
  return `/grading/exports?${params.toString()}`;
}

export function buildBatchGradingExportHref(input: {
  courseId?: string;
  batchId: string;
  rubricKey?: string;
}): string {
  const params = new URLSearchParams({
    from: "batch",
    scope: "batch",
    batch: input.batchId,
  });
  if (input.courseId) params.set("course", input.courseId);
  if (input.rubricKey) params.set("rubric", input.rubricKey);
  return `/grading/exports?${params.toString()}`;
}

export function filterExportPreviewRows(
  rows: readonly ExportPreviewRow[],
  filter: CsvPreviewFilter,
): ExportPreviewRow[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const minVal = filter.minScore?.trim() ? Number(filter.minScore.trim()) : undefined;
  const maxVal = filter.maxScore?.trim() ? Number(filter.maxScore.trim()) : undefined;
  const hasMin = minVal !== undefined && Number.isFinite(minVal);
  const hasMax = maxVal !== undefined && Number.isFinite(maxVal);

  return rows.filter((row) => {
    if (query) {
      const matchesMeta = `${row.studentName} ${row.studentNumber} ${row.submissionTitle}`
        .toLowerCase()
        .includes(query);
      const matchesCell = row.cells.some((cell) =>
        String(cell).toLowerCase().includes(query),
      );
      if (!matchesMeta && !matchesCell) return false;
    }
    if (hasMin && row.earnedScore < minVal!) return false;
    if (hasMax && row.earnedScore > maxVal!) return false;
    return true;
  });
}

export function filterExportSelectedRows(
  rows: readonly ExportPreviewRow[],
  deselectedIds: ReadonlySet<string>,
): ExportPreviewRow[] {
  return rows.filter((row) => !deselectedIds.has(row.sessionId));
}

export function toggleExportRowSelection(
  deselectedIds: ReadonlySet<string>,
  sessionId: string,
  selected: boolean,
): Set<string> {
  const next = new Set(deselectedIds);
  if (selected) next.delete(sessionId);
  else next.add(sessionId);
  return next;
}

export function toggleAllVisibleExportRows(
  deselectedIds: ReadonlySet<string>,
  visibleRows: readonly ExportPreviewRow[],
  selectAll: boolean,
): Set<string> {
  const next = new Set(deselectedIds);
  for (const row of visibleRows) {
    if (selectAll) next.delete(row.sessionId);
    else next.add(row.sessionId);
  }
  return next;
}

export function getVisibleSelectionState(
  visibleRows: readonly ExportPreviewRow[],
  deselectedIds: ReadonlySet<string>,
): { selectedCount: number; allSelected: boolean; someSelected: boolean } {
  const total = visibleRows.length;
  if (total === 0) return { selectedCount: 0, allSelected: false, someSelected: false };
  let selectedCount = 0;
  for (const row of visibleRows) {
    if (!deselectedIds.has(row.sessionId)) selectedCount += 1;
  }
  return {
    selectedCount,
    allSelected: selectedCount === total,
    someSelected: selectedCount > 0 && selectedCount < total,
  };
}

export function pruneDeselectedSessionIds(
  deselectedIds: ReadonlySet<string>,
  rows: readonly ExportPreviewRow[],
): Set<string> {
  if (deselectedIds.size === 0) return new Set();
  const validIds = new Set(rows.map((row) => row.sessionId));
  const next = new Set<string>();
  for (const id of deselectedIds) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
}

export function computeExportSummaryStats(
  rows: readonly ExportPreviewRow[],
): ExportSummaryStats {
  const totalCount = rows.length;
  const uniqueStudentCount = new Set(rows.map((row) => row.studentNumber)).size;
  let confirmedCount = 0;
  let needsReviewCount = 0;
  let scoreSum = 0;
  let highestScore = -Infinity;
  let lowestScore = Infinity;
  const possibleScores = new Set<number>();
  let rateSum = 0;
  let rateCount = 0;
  let highestScoreRate = -Infinity;
  let lowestScoreRate = Infinity;

  for (const row of rows) {
    if (row.reviewStatus === "confirmed") confirmedCount += 1;
    else needsReviewCount += 1;
    scoreSum += row.earnedScore;
    if (row.earnedScore > highestScore) highestScore = row.earnedScore;
    if (row.earnedScore < lowestScore) lowestScore = row.earnedScore;
    possibleScores.add(row.possibleScore);
    if (row.possibleScore > 0) {
      const rate = (row.earnedScore / row.possibleScore) * 100;
      rateSum += rate;
      rateCount += 1;
      if (rate > highestScoreRate) highestScoreRate = rate;
      if (rate < lowestScoreRate) lowestScoreRate = rate;
    }
  }

  return {
    totalCount,
    uniqueStudentCount,
    confirmedCount,
    needsReviewCount,
    averageScore: totalCount > 0 ? Number((scoreSum / totalCount).toFixed(2)) : null,
    highestScore: totalCount > 0 ? highestScore : null,
    lowestScore: totalCount > 0 ? lowestScore : null,
    hasUniformPossibleScore: possibleScores.size <= 1,
    commonPossibleScore: possibleScores.size === 1 ? rows[0]!.possibleScore : null,
    averageScoreRate: rateCount > 0 ? Number((rateSum / rateCount).toFixed(1)) : null,
    highestScoreRate: rateCount > 0 ? Number(highestScoreRate.toFixed(1)) : null,
    lowestScoreRate: rateCount > 0 ? Number(lowestScoreRate.toFixed(1)) : null,
  };
}

function csvCell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function serializeExportCsv(
  headers: readonly string[],
  rows: readonly Pick<ExportPreviewRow, "cells">[],
): string {
  const lines = [headers.map((header) => csvCell(header)).join(",")];
  for (const row of rows) {
    lines.push(row.cells.map((cell) => csvCell(cell)).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/-+/g, "-") || "export";
}

export function buildExportFilename(input: {
  scopeKind: GradingExportScopeKind;
  batchTitle?: string;
  includeUnconfirmed?: boolean;
  rubricTitle?: string;
  rubricVersion?: number;
  studentNumber?: string;
  studentName?: string;
}): string {
  if (input.scopeKind === "batch") {
    const title = sanitizeFilenamePart(input.batchTitle || "批次成绩");
    return `${title}-${input.includeUnconfirmed ? "处理汇总" : "已确认成绩"}.csv`;
  }
  if (input.scopeKind === "rubric") {
    const title = sanitizeFilenamePart(input.rubricTitle || "评分标准");
    const version = input.rubricVersion ? `-v${input.rubricVersion}` : "";
    return `${title}${version}-全部学生.csv`;
  }
  const number = sanitizeFilenamePart(input.studentNumber || "学生");
  const name = input.studentName ? `-${sanitizeFilenamePart(input.studentName)}` : "";
  return `${number}${name}-全部作业.csv`;
}

export function parseCsvPreview(csvText: string): CsvPreviewTable {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return { headers: [], rows: [] };

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && cleaned[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) records.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) records.push(row);
  }

  const [headers = [], ...rows] = records;
  return { headers, rows };
}

function extractNumericScore(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

export function filterCsvPreviewRows(
  table: CsvPreviewTable,
  filter: CsvPreviewFilter,
): CsvPreviewTable {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const minVal = filter.minScore?.trim() ? Number(filter.minScore.trim()) : undefined;
  const maxVal = filter.maxScore?.trim() ? Number(filter.maxScore.trim()) : undefined;
  const hasMin = minVal !== undefined && Number.isFinite(minVal);
  const hasMax = maxVal !== undefined && Number.isFinite(maxVal);
  const scoreColIndex = table.headers.findIndex((header) =>
    /总分|score/i.test(header),
  );

  const rows = table.rows.filter((row) => {
    if (query && !row.some((cell) => cell.toLowerCase().includes(query))) {
      return false;
    }
    if ((hasMin || hasMax) && scoreColIndex >= 0) {
      const score = extractNumericScore(row[scoreColIndex]);
      if (score === undefined) return false;
      if (hasMin && score < minVal!) return false;
      if (hasMax && score > maxVal!) return false;
    }
    return true;
  });

  return { headers: table.headers, rows };
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function serializeCsvTable(table: CsvPreviewTable): string {
  const lines = [table.headers, ...table.rows].map((row) =>
    row.map((cell) => escapeCsvCell(cell)).join(","),
  );
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
