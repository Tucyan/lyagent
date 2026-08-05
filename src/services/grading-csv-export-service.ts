import type { GradingResultService } from "./grading-result-service.js";
import type { GradingSession, GradingSessionService } from "./grading-session-service.js";
import type { RubricService } from "./rubric-service.js";

export interface GradingCsvColumns {
  studentName?: boolean;
  studentNumber?: boolean;
  submissionTitle?: boolean;
  itemDetails?: boolean;
  itemConfidence?: boolean;
  totalScore?: boolean;
  overallConfidence?: boolean;
}

export type GradingCsvScope =
  | { kind: "student"; courseId: string; studentNumber: string }
  | { kind: "rubric"; assignmentId: string; rubricVersion: number };

export interface GradingCsvExportRequest {
  scope: GradingCsvScope;
  columns: GradingCsvColumns;
}

interface ExportRow {
  session: GradingSession;
  confirmed: NonNullable<Awaited<ReturnType<GradingResultService["readConfirmedResult"]>>>;
  rubricTitle: string;
  rubric: Awaited<ReturnType<RubricService["getVersion"]>>["rubric"];
}

interface DetailColumn {
  key: string;
  heading: string;
  confidenceHeading: string;
  kind: "criterion" | "deduction" | "bonus";
  id: string;
}

export class GradingCsvExportService {
  constructor(private readonly sessions: GradingSessionService, private readonly results: GradingResultService, private readonly rubrics: RubricService) {}

  async export(request: GradingCsvExportRequest): Promise<string> {
    const columns = normalizeColumns(request.columns);
    if (!Object.values(columns).some(Boolean)) throw new Error("At least one CSV column must be selected");
    let candidates: GradingSession[];
    if (request.scope.kind === "student") {
      const { courseId, studentNumber } = request.scope;
      candidates = (await this.sessions.listSessions({ studentNumber })).filter((session) => session.courseId === courseId);
    } else {
      candidates = await this.sessions.listSessions({ assignmentId: request.scope.assignmentId, rubricVersion: request.scope.rubricVersion });
    }
    const rows: ExportRow[] = [];
    for (const session of candidates) {
      const confirmed = await this.results.readConfirmedResult(session.id);
      if (!confirmed) continue;
      const [assignment, frozen] = await Promise.all([this.rubrics.getAssignment(session.assignmentId), this.rubrics.getVersion(session.assignmentId, session.rubricVersion)]);
      rows.push({ session, confirmed, rubricTitle: assignment.title, rubric: frozen.rubric });
    }
    const details = columns.itemDetails ? detailColumns(rows) : [];
    const headings: string[] = [];
    if (columns.studentName) headings.push("学生姓名");
    if (columns.studentNumber) headings.push("学号");
    if (columns.submissionTitle) headings.push("作业名称");
    for (const detail of details) {
      headings.push(detail.heading);
      if (columns.itemConfidence) headings.push(detail.confidenceHeading);
    }
    if (columns.totalScore) headings.push("总分");
    if (columns.overallConfidence) headings.push("总置信度");
    const lines = [renderCsvRow(headings)];
    for (const row of rows) {
      const values: Array<string | number> = [];
      if (columns.studentName) values.push(row.session.studentName);
      if (columns.studentNumber) values.push(row.session.studentNumber);
      if (columns.submissionTitle) values.push(row.session.submissionTitle ?? "");
      for (const detail of details) {
        const decision = findDecision(row, detail);
        values.push(decision?.value ?? "");
        if (columns.itemConfidence) values.push(decision?.confidence ?? "");
      }
      if (columns.totalScore) values.push(row.confirmed.result.score.earned);
      if (columns.overallConfidence) values.push(row.confirmed.result.confidence.overall);
      lines.push(renderCsvRow(values));
    }
    return `\ufeff${lines.join("\r\n")}\r\n`;
  }
}

function normalizeColumns(columns: GradingCsvColumns): Required<GradingCsvColumns> {
  return {
    studentName: columns.studentName === true,
    studentNumber: columns.studentNumber === true,
    submissionTitle: columns.submissionTitle === true,
    itemDetails: columns.itemDetails === true,
    itemConfidence: columns.itemDetails === true && columns.itemConfidence === true,
    totalScore: columns.totalScore === true,
    overallConfidence: columns.overallConfidence === true,
  };
}

function detailColumns(rows: ExportRow[]): DetailColumn[] {
  const seen = new Set<string>();
  const output: DetailColumn[] = [];
  for (const row of rows) {
    const prefix = `${row.rubricTitle} v${row.session.rubricVersion}`;
    const add = (kind: DetailColumn["kind"], id: string, name: string, label: string) => {
      const key = `${row.session.assignmentId}:${row.session.rubricVersion}:${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push({ key, kind, id, heading: `${prefix} · ${label}：${name}`, confidenceHeading: `${prefix} · 置信度：${name}` });
    };
    if (row.rubric.mode === "additive") for (const item of row.rubric.criteria) add("criterion", item.id, item.name, "得分点");
    if (row.rubric.mode === "deductive") for (const item of row.rubric.rules) add("deduction", item.id, item.name, "扣分点");
    if (row.rubric.mode === "hybrid") {
      for (const item of row.rubric.criteria) add("criterion", item.id, item.name, "得分点");
      for (const item of row.rubric.bonusRules) add("bonus", item.id, item.name, "加分点");
      for (const item of row.rubric.deductionRules) add("deduction", item.id, item.name, "扣分点");
    }
  }
  return output;
}

function findDecision(row: ExportRow, column: DetailColumn): { value: number; confidence: number } | undefined {
  const expectedPrefix = `${row.session.assignmentId}:${row.session.rubricVersion}:`;
  if (!column.key.startsWith(expectedPrefix)) return undefined;
  const decisions = row.confirmed.result.decisions;
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
