import type { GradingResultService } from "./grading-result-service.js";
import type { GradingSession, GradingSessionService } from "./grading-session-service.js";
import type { RubricService } from "./rubric-service.js";
import { normalizeRubric } from "../schemas/rubric-engine.js";

export interface GradingCsvColumns {
  studentName?: boolean;
  studentNumber?: boolean;
  submissionTitle?: boolean;
  rubricName?: boolean;
  itemDetails?: boolean;
  itemConfidence?: boolean;
  totalScore?: boolean;
  possibleScore?: boolean;
  scoreRate?: boolean;
  overallConfidence?: boolean;
  reviewStatus?: boolean;
}

export type GradingCsvScope =
  | { kind: "student"; courseId: string; studentNumber: string }
  | { kind: "rubric"; assignmentId: string; rubricVersion: number }
  | { kind: "batch"; batchId: string; includeUnconfirmed?: boolean };

export interface GradingCsvExportRequest {
  scope: GradingCsvScope;
  columns: GradingCsvColumns;
}

export interface BatchExportReader {
  getBatch(batchId: string): Promise<{
    id: string;
    courseId?: string;
    title: string;
    assignmentId: string;
    rubricVersion: number;
    jobs: Array<{ id: string; sessionId: string; status: string }>;
  }>;
}

export interface GradingCsvPreviewRow {
  sessionId: string;
  rubricKey: string;
  rubricTitle: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  reviewStatus: "confirmed" | "needs_review";
  earnedScore: number;
  possibleScore: number;
  overallConfidence: number;
  cells: Array<string | number>;
}

export interface GradingCsvSummaryStats {
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

export interface GradingCsvPreviewResult {
  headers: string[];
  rows: GradingCsvPreviewRow[];
  summary: GradingCsvSummaryStats;
  csvText: string;
}

type ConfirmedOrDraftResult = NonNullable<Awaited<ReturnType<GradingResultService["readConfirmedResult"]>>>["result"];

interface ExportRow {
  session: GradingSession;
  reviewStatus: "confirmed" | "needs_review";
  result: ConfirmedOrDraftResult;
  rubricTitle: string;
  rubric: Awaited<ReturnType<RubricService["getVersion"]>>["rubric"];
}

interface DetailColumn {
  key: string;
  rubricKey: string;
  rubricLabel: string;
  itemName: string;
  itemLabel: string;
  heading: string;
  confidenceHeading: string;
  kind: "criterion" | "deduction" | "bonus" | "scoreCap";
  id: string;
}

export class GradingCsvExportService {
  constructor(
    private readonly sessions: GradingSessionService,
    private readonly results: GradingResultService,
    private readonly rubrics: RubricService,
    private readonly batches?: BatchExportReader,
  ) {}

  async export(request: GradingCsvExportRequest): Promise<string> {
    return (await this.buildExportDataset(request)).csvText;
  }

  async preview(request: GradingCsvExportRequest): Promise<GradingCsvPreviewResult> {
    return this.buildExportDataset(request);
  }

  private async buildExportDataset(request: GradingCsvExportRequest): Promise<GradingCsvPreviewResult> {
    const columns = normalizeColumns(request.columns);
    if (!Object.values(columns).some(Boolean)) throw new Error("At least one CSV column must be selected");

    const rows: ExportRow[] = [];
    const rubricCache = new Map<string, { rubricTitle: string; rubric: ExportRow["rubric"] }>();
    const loadRubricMeta = async (assignmentId: string, rubricVersion: number) => {
      const key = `${assignmentId}:${rubricVersion}`;
      const cached = rubricCache.get(key);
      if (cached) return cached;
      const [assignment, frozen] = await Promise.all([
        this.rubrics.getAssignment(assignmentId),
        this.rubrics.getVersion(assignmentId, rubricVersion),
      ]);
      const meta = { rubricTitle: assignment.title, rubric: frozen.rubric };
      rubricCache.set(key, meta);
      return meta;
    };

    let fallbackRubricRef: { assignmentId: string; rubricVersion: number } | undefined;

    if (request.scope.kind === "batch") {
      if (!this.batches) throw new Error("Batch export reader is not configured");
      const batch = await this.batches.getBatch(request.scope.batchId);
      fallbackRubricRef = { assignmentId: batch.assignmentId, rubricVersion: batch.rubricVersion };
      const includeUnconfirmed = request.scope.includeUnconfirmed === true;
      for (const job of batch.jobs) {
        const confirmed = await this.results.readConfirmedResult(job.sessionId);
        let entry: { reviewStatus: "confirmed" | "needs_review"; result: ConfirmedOrDraftResult } | undefined;
        if (confirmed) {
          entry = { reviewStatus: "confirmed", result: confirmed.result };
        } else if (includeUnconfirmed && ["needs_review", "completed"].includes(job.status)) {
          const draft = await this.results.readDraft(job.sessionId);
          if (draft) entry = { reviewStatus: "needs_review", result: draft.result };
        }
        if (!entry) continue;
        const session = await this.sessions.getSession(job.sessionId);
        const { rubricTitle, rubric } = await loadRubricMeta(session.assignmentId, session.rubricVersion);
        rows.push({ session, reviewStatus: entry.reviewStatus, result: entry.result, rubricTitle, rubric });
      }
      rows.sort((left, right) => left.session.studentNumber.localeCompare(right.session.studentNumber, "zh-CN") || left.session.id.localeCompare(right.session.id));
    } else {
      let candidates: GradingSession[];
      if (request.scope.kind === "student") {
        const { courseId, studentNumber } = request.scope;
        candidates = (await this.sessions.listSessions({ studentNumber })).filter((session) => session.courseId === courseId);
      } else {
        fallbackRubricRef = { assignmentId: request.scope.assignmentId, rubricVersion: request.scope.rubricVersion };
        candidates = await this.sessions.listSessions({
          assignmentId: request.scope.assignmentId,
          rubricVersion: request.scope.rubricVersion,
        });
      }
      for (const session of candidates) {
        const confirmed = await this.results.readConfirmedResult(session.id);
        if (!confirmed) continue;
        const { rubricTitle, rubric } = await loadRubricMeta(session.assignmentId, session.rubricVersion);
        rows.push({ session, reviewStatus: "confirmed", result: confirmed.result, rubricTitle, rubric });
      }
      if (request.scope.kind === "rubric") {
        rows.sort((left, right) => left.session.studentNumber.localeCompare(right.session.studentNumber, "zh-CN") || left.session.id.localeCompare(right.session.id));
      }
    }

    const details = columns.itemDetails
      ? rows.length > 0
        ? detailColumns(rows)
        : fallbackRubricRef
          ? await rubricScopeDetailColumns(this.rubrics, fallbackRubricRef.assignmentId, fallbackRubricRef.rubricVersion)
          : []
      : [];

    const headings: string[] = [];
    if (columns.studentName) headings.push("学生姓名");
    if (columns.studentNumber) headings.push("学号");
    if (columns.submissionTitle) headings.push("作业名称");
    if (columns.rubricName) headings.push("评分标准");
    for (const detail of details) {
      headings.push(detail.heading);
      if (columns.itemConfidence) headings.push(detail.confidenceHeading);
    }
    if (columns.totalScore) headings.push("总分");
    if (columns.possibleScore) headings.push("满分");
    if (columns.scoreRate) headings.push("得分率");
    if (columns.overallConfidence) headings.push("总置信度");
    if (columns.reviewStatus) headings.push("复核状态");

    const lines = [renderCsvRow(headings)];
    const previewRows: GradingCsvPreviewRow[] = [];
    for (const row of rows) {
      const cells: Array<string | number> = [];
      if (columns.studentName) cells.push(row.session.studentName);
      if (columns.studentNumber) cells.push(row.session.studentNumber);
      if (columns.submissionTitle) cells.push(row.session.submissionTitle ?? "");
      if (columns.rubricName) cells.push(`${row.rubricTitle} v${row.session.rubricVersion}`);
      for (const detail of details) {
        const decision = findDecision(row, detail);
        cells.push(decision?.value ?? "");
        if (columns.itemConfidence) cells.push(decision?.confidence ?? "");
      }
      if (columns.totalScore) cells.push(row.result.score.earned);
      if (columns.possibleScore) cells.push(row.result.score.possible);
      if (columns.scoreRate) {
        cells.push(
          row.result.score.possible > 0
            ? `${((row.result.score.earned / row.result.score.possible) * 100).toFixed(1)}%`
            : "—",
        );
      }
      if (columns.overallConfidence) cells.push(row.result.confidence.overall);
      if (columns.reviewStatus) cells.push(row.reviewStatus === "confirmed" ? "已确认" : "待复核");

      lines.push(renderCsvRow(cells));
      previewRows.push({
        sessionId: row.session.id,
        rubricKey: `${row.session.assignmentId}:${row.session.rubricVersion}`,
        rubricTitle: `${row.rubricTitle} v${row.session.rubricVersion}`,
        studentName: row.session.studentName,
        studentNumber: row.session.studentNumber,
        submissionTitle: row.session.submissionTitle ?? "",
        reviewStatus: row.reviewStatus,
        earnedScore: row.result.score.earned,
        possibleScore: row.result.score.possible,
        overallConfidence: row.result.confidence.overall,
        cells,
      });
    }

    return {
      headers: headings,
      rows: previewRows,
      summary: summarizePreviewRows(previewRows),
      csvText: `\ufeff${lines.join("\r\n")}\r\n`,
    };
  }
}

function summarizePreviewRows(rows: GradingCsvPreviewRow[]): GradingCsvSummaryStats {
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

function normalizeColumns(columns: GradingCsvColumns): Required<GradingCsvColumns> {
  return {
    studentName: columns.studentName === true,
    studentNumber: columns.studentNumber === true,
    submissionTitle: columns.submissionTitle === true,
    rubricName: columns.rubricName === true,
    itemDetails: columns.itemDetails === true,
    itemConfidence: columns.itemDetails === true && columns.itemConfidence === true,
    totalScore: columns.totalScore === true,
    possibleScore: columns.possibleScore === true,
    scoreRate: columns.scoreRate === true,
    overallConfidence: columns.overallConfidence === true,
    reviewStatus: columns.reviewStatus === true,
  };
}

function rubricDetailColumns(
  assignmentId: string,
  rubricVersion: number,
  rubricTitle: string,
  rubric: ExportRow["rubric"],
  seen: Set<string>,
  output: DetailColumn[],
): void {
  const rubricKey = `${assignmentId}:${rubricVersion}`;
  const rubricLabel = `${rubricTitle} v${rubricVersion}`;
  const add = (kind: DetailColumn["kind"], id: string, name: string, itemLabel: string) => {
    const key = `${rubricKey}:${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push({
      key,
      rubricKey,
      rubricLabel,
      itemName: name,
      itemLabel,
      kind,
      id,
      heading: name,
      confidenceHeading: `${name}（置信度）`,
    });
  };
  const normalized = normalizeRubric(rubric);
  for (const item of normalized.criteria) add("criterion", item.id, item.name, "得分点");
  for (const item of normalized.bonusRules) add("bonus", item.id, item.name, "加分点");
  for (const item of normalized.deductionRules) add("deduction", item.id, item.name, "扣分点");
  for (const item of normalized.scoreCaps) add("scoreCap", item.id, item.name, "总分封顶");
}

function assignDetailHeadings(columns: DetailColumn[]): DetailColumn[] {
  const countByName = new Map<string, number>();
  const rubricsByName = new Map<string, Set<string>>();
  const countByRubricAndName = new Map<string, number>();

  for (const column of columns) {
    countByName.set(column.itemName, (countByName.get(column.itemName) ?? 0) + 1);
    const rubricSet = rubricsByName.get(column.itemName) ?? new Set<string>();
    rubricSet.add(column.rubricKey);
    rubricsByName.set(column.itemName, rubricSet);
    const pairKey = `${column.rubricKey}:${column.itemName}`;
    countByRubricAndName.set(pairKey, (countByRubricAndName.get(pairKey) ?? 0) + 1);
  }

  const assignedCounts = new Map<string, number>();
  for (const column of columns) {
    const totalMatches = countByName.get(column.itemName) ?? 0;
    const distinctRubrics = rubricsByName.get(column.itemName)?.size ?? 0;
    const sameRubricMatches = countByRubricAndName.get(`${column.rubricKey}:${column.itemName}`) ?? 0;

    let suffix: string | undefined;
    if (totalMatches > 1) {
      if (distinctRubrics > 1) {
        suffix = sameRubricMatches > 1
          ? `${column.rubricLabel} · ${column.itemLabel}`
          : column.rubricLabel;
      } else {
        suffix = column.itemLabel;
      }
    }

    const baseHeading = suffix ? `${column.itemName}（${suffix}）` : column.itemName;
    const seenIndex = (assignedCounts.get(baseHeading) ?? 0) + 1;
    assignedCounts.set(baseHeading, seenIndex);
    const uniqueSuffix = seenIndex > 1
      ? (suffix ? `${suffix} #${seenIndex}` : `#${seenIndex}`)
      : suffix;

    column.heading = uniqueSuffix ? `${column.itemName}（${uniqueSuffix}）` : column.itemName;
    column.confidenceHeading = uniqueSuffix
      ? `${column.itemName}（${uniqueSuffix} · 置信度）`
      : `${column.itemName}（置信度）`;
  }

  return columns;
}

async function rubricScopeDetailColumns(
  rubrics: RubricService,
  assignmentId: string,
  rubricVersion: number,
): Promise<DetailColumn[]> {
  try {
    const [assignment, frozen] = await Promise.all([
      rubrics.getAssignment(assignmentId),
      rubrics.getVersion(assignmentId, rubricVersion),
    ]);
    const output: DetailColumn[] = [];
    rubricDetailColumns(assignmentId, rubricVersion, assignment.title, frozen.rubric, new Set<string>(), output);
    return assignDetailHeadings(output);
  } catch {
    return [];
  }
}

function detailColumns(rows: ExportRow[]): DetailColumn[] {
  const seen = new Set<string>();
  const output: DetailColumn[] = [];
  for (const row of rows) {
    rubricDetailColumns(row.session.assignmentId, row.session.rubricVersion, row.rubricTitle, row.rubric, seen, output);
  }
  return assignDetailHeadings(output);
}

function findDecision(row: ExportRow, column: DetailColumn): { value: number | string; confidence: number } | undefined {
  const expectedPrefix = `${row.session.assignmentId}:${row.session.rubricVersion}:`;
  if (!column.key.startsWith(expectedPrefix)) return undefined;
  const decisions = row.result.decisions;
  if (column.kind === "criterion" && (decisions.mode === "additive" || decisions.mode === "hybrid")) {
    const decision = decisions.criteria.find(({ criterionId }) => criterionId === column.id);
    return decision ? { value: decision.score, confidence: decision.confidence } : undefined;
  }
  if (column.kind === "deduction" && (decisions.mode === "deductive" || decisions.mode === "hybrid")) {
    const decision = decisions.deductions.find(({ ruleId }) => ruleId === column.id);
    return decision ? { value: decision.triggered ? -decision.deduction : 0, confidence: decision.confidence } : undefined;
  }
  if (column.kind === "bonus" && decisions.mode === "hybrid") {
    const decision = decisions.bonuses.find(({ ruleId }) => ruleId === column.id);
    return decision ? { value: decision.triggered ? decision.bonus : 0, confidence: decision.confidence } : undefined;
  }
  if (column.kind === "scoreCap") {
    const decision = (decisions.scoreCaps ?? []).find(({ ruleId }) => ruleId === column.id);
    return decision ? { value: decision.triggered ? "触发封顶" : "未触发", confidence: decision.confidence } : undefined;
  }
  return undefined;
}

function renderCsvRow(values: Array<string | number>): string {
  return values.map((value) => csvCell(value)).join(",");
}

function csvCell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
