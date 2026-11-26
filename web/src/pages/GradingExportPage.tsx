import { useEffect, useMemo, useRef, useState } from "react";
import { apiErrorFromResponse, apiFetch, withJsonHeaders } from "../lib/api";
import { LatestRequestGate } from "../lib/async-state";
import {
  COURSE_CHANGED_EVENT,
  readCourseFromUrl,
  resolveActiveCourseId,
} from "../lib/course-context";
import { SearchableOptionPicker } from "../components/SearchableOptionPicker";
import { useToast } from "../components/ToastProvider";
import { batchStatusLabel } from "./grading-batch-page-model";
import { rubricSelectionKey } from "./grading-page-model";
import {
  buildExportFilename,
  computeExportSummaryStats,
  countSelectedExportColumns,
  exportPresetOptions,
  filterExportPreviewRows,
  filterExportSelectedRows,
  getVisibleSelectionState,
  hasMultipleRubricsInRows,
  hasSelectedExportColumn,
  normalizeGradingExportOptions,
  parseGradingExportLocation,
  parseGradingExportOptions,
  pickPreferredExportRubric,
  pruneDeselectedSessionIds,
  resolveExportQuickReturn,
  serializeExportCsv,
  toggleAllVisibleExportRows,
  toggleExportRowSelection,
  type ExportPreviewRow,
  type GradingExportOptions,
  type GradingExportPreset,
  type GradingExportScopeKind,
} from "./grading-export-page-model";

type ExportBatchItem = {
  id: string;
  courseId?: string;
  title: string;
  assignmentId: string;
  rubricVersion: number;
  status: string;
  totalJobs: number;
  counts: {
    pending: number;
    running: number;
    waiting_for_teacher: number;
    needs_review: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
};

type ExportRubricItem = {
  assignmentId: string;
  courseId?: string;
  title: string;
  version: number;
  sessionCount?: number;
  confirmedCount?: number;
};

type ExportStudentItem = {
  studentNumber: string;
  studentName: string;
  confirmedCount: number;
  totalCount: number;
  rubricCount?: number;
};

type PreviewApiResponse = {
  headers: string[];
  rows: ExportPreviewRow[];
  csvText: string;
};

function exportRubricStorageKey(courseId: string): string {
  return courseId ? `export-rubric:${courseId}` : "export-rubric";
}

function exportBatchStorageKey(courseId: string): string {
  return courseId ? `export-batch:${courseId}` : "export-batch";
}

function exportStudentStorageKey(courseId: string): string {
  return courseId ? `export-student:${courseId}` : "export-student";
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

const SCOPE_ITEMS: Array<{
  kind: GradingExportScopeKind;
  title: string;
  description: string;
}> = [
  { kind: "batch", title: "按批改批次", description: "导出单次批量批改的班级成绩单" },
  { kind: "rubric", title: "按评分标准", description: "合并同标准下全部已确认作业" },
  { kind: "student", title: "按学生导出", description: "汇总单名学生本课程全部已确认作业" },
];

const COLUMN_FIELDS: Array<[keyof GradingExportOptions, string]> = [
  ["studentName", "学生姓名"],
  ["studentNumber", "学号"],
  ["submissionTitle", "作业名称"],
  ["rubricName", "评分标准"],
  ["itemDetails", "详细得分/扣分"],
  ["totalScore", "总分"],
  ["possibleScore", "满分"],
  ["scoreRate", "得分率"],
  ["overallConfidence", "总置信度"],
  ["reviewStatus", "复核状态"],
];
const TOTAL_EXPORT_COLUMNS = COLUMN_FIELDS.length + 1;

export function GradingExportPage() {
  const toast = useToast();
  const [locationSearch, setLocationSearch] = useState(() => window.location.search);
  const location = useMemo(() => parseGradingExportLocation(locationSearch), [locationSearch]);

  const [activeCourseId, setActiveCourseId] = useState(() => readCourseFromUrl(window.location.search));
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [batches, setBatches] = useState<ExportBatchItem[]>([]);
  const [rubrics, setRubrics] = useState<ExportRubricItem[]>([]);
  const [students, setStudents] = useState<ExportStudentItem[]>([]);

  const [scopeKind, setScopeKind] = useState<GradingExportScopeKind>(
    location.scope ?? "rubric",
  );
  const [selectedBatchId, setSelectedBatchId] = useState(location.batch ?? "");
  const [includeUnconfirmed, setIncludeUnconfirmed] = useState(
    location.includeUnconfirmed ?? false,
  );
  const [selectedRubricKey, setSelectedRubricKey] = useState(location.rubric ?? "");
  const [selectedStudentNumber, setSelectedStudentNumber] = useState(location.student ?? "");
  const [studentPickerQuery, setStudentPickerQuery] = useState("");

  const [exportOptions, setExportOptions] = useState<GradingExportOptions>(() =>
    parseGradingExportOptions(safeStorageGet("grading-csv-columns")),
  );
  const [studentExpandDetails, setStudentExpandDetails] = useState(false);
  const [columnPopoverOpen, setColumnPopoverOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [deselectedSessionIds, setDeselectedSessionIds] = useState<Set<string>>(() => new Set());

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewData, setPreviewData] = useState<PreviewApiResponse>({
    headers: [],
    rows: [],
    csvText: "",
  });
  const [reloadNonce, setReloadNonce] = useState(0);

  const loadGate = useRef(new LatestRequestGate());
  const previewGate = useRef(new LatestRequestGate());
  const columnPickerRef = useRef<HTMLDivElement>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const syncLocation = () => setLocationSearch(window.location.search);
    window.addEventListener("popstate", syncLocation);
    window.addEventListener(COURSE_CHANGED_EVENT, syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener(COURSE_CHANGED_EVENT, syncLocation);
    };
  }, []);

  useEffect(() => {
    safeStorageSet("grading-csv-columns", JSON.stringify(exportOptions));
  }, [exportOptions]);

  useEffect(() => {
    if (!columnPopoverOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (columnPickerRef.current && !columnPickerRef.current.contains(event.target as Node)) {
        setColumnPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColumnPopoverOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [columnPopoverOpen]);

  useEffect(() => {
    const lease = loadGate.current.begin();
    setLoadingOptions(true);
    setPreviewError("");
    void (async () => {
      try {
        const parsed = parseGradingExportLocation(locationSearch);
        const courses = await api<Array<{ id: string }>>("/api/courses");
        const resolvedCourseId = resolveActiveCourseId(courses, readCourseFromUrl(locationSearch));
        if (!lease.isCurrent()) return;
        setActiveCourseId(resolvedCourseId);

        const courseQuery = resolvedCourseId ? `?courseId=${encodeURIComponent(resolvedCourseId)}` : "";
        const [rawBatches, rawRubrics, nextStudents] = await Promise.all([
          api<ExportBatchItem[]>(`/api/grading/batches${courseQuery}`),
          api<ExportRubricItem[]>(`/api/grading/rubrics${courseQuery}`),
          api<ExportStudentItem[]>(`/api/grading/exports/students${courseQuery}`),
        ]);
        if (!lease.isCurrent()) return;

        const nextBatches = resolvedCourseId
          ? rawBatches.filter((item) => !item.courseId || item.courseId === resolvedCourseId)
          : rawBatches;
        const nextRubrics = resolvedCourseId
          ? rawRubrics.filter((item) => !item.courseId || item.courseId === resolvedCourseId)
          : rawRubrics;

        setBatches(nextBatches);
        setRubrics(nextRubrics);
        setStudents(nextStudents);

        const preferredBatchId = parsed.batch ?? safeStorageGet(exportBatchStorageKey(resolvedCourseId)) ?? "";
        const resolvedBatch = nextBatches.find((item) => item.id === preferredBatchId) ?? nextBatches[0];
        setSelectedBatchId(resolvedBatch?.id ?? "");

        const preferredRubricKey = parsed.rubric ?? safeStorageGet(exportRubricStorageKey(resolvedCourseId)) ?? "";
        const resolvedRubricKey = pickPreferredExportRubric(nextRubrics, preferredRubricKey);
        setSelectedRubricKey(resolvedRubricKey);

        const preferredStudent = parsed.student ?? safeStorageGet(exportStudentStorageKey(resolvedCourseId)) ?? "";
        const resolvedStudent = nextStudents.find((item) => item.studentNumber === preferredStudent) ?? nextStudents[0];
        setSelectedStudentNumber(resolvedStudent?.studentNumber ?? "");

        let nextScope: GradingExportScopeKind = parsed.scope ?? "rubric";
        if (!parsed.scope) {
          if (parsed.from === "batch" || parsed.batch) nextScope = "batch";
          else if (parsed.student && !parsed.rubric) nextScope = "student";
          else if (nextRubrics.length > 0) nextScope = "rubric";
          else if (nextBatches.length > 0) nextScope = "batch";
          else nextScope = "student";
        }
        setScopeKind(nextScope);

        if (parsed.includeUnconfirmed !== undefined) {
          setIncludeUnconfirmed(parsed.includeUnconfirmed);
        } else if (
          parsed.from === "batch" &&
          resolvedBatch &&
          resolvedBatch.counts.completed === 0 &&
          resolvedBatch.counts.needs_review > 0
        ) {
          setIncludeUnconfirmed(true);
        } else {
          setIncludeUnconfirmed(false);
        }
      } catch (error) {
        if (lease.isCurrent()) setPreviewError((error as Error).message);
      } finally {
        if (lease.isCurrent()) setLoadingOptions(false);
      }
    })();
    return () => {
      if (lease.isCurrent()) loadGate.current.invalidate();
    };
  }, [locationSearch]);

  const selectedBatch = useMemo(
    () => batches.find((item) => item.id === selectedBatchId),
    [batches, selectedBatchId],
  );
  const selectedRubric = useMemo(
    () => rubrics.find((item) => rubricSelectionKey(item) === selectedRubricKey),
    [rubrics, selectedRubricKey],
  );
  const selectedStudent = useMemo(
    () => students.find((item) => item.studentNumber === selectedStudentNumber),
    [students, selectedStudentNumber],
  );
  const visibleStudents = useMemo(() => {
    const q = studentPickerQuery.trim().toLowerCase();
    if (!q) return students;
    return students.filter((item) =>
      `${item.studentName} ${item.studentNumber}`.toLowerCase().includes(q),
    );
  }, [students, studentPickerQuery]);

  const isMultiRubricStudent = useMemo(
    () =>
      scopeKind === "student" &&
      ((selectedStudent?.rubricCount ?? 0) >= 2 || hasMultipleRubricsInRows(previewData.rows)),
    [scopeKind, selectedStudent?.rubricCount, previewData.rows],
  );
  const isStudentSummaryActive = isMultiRubricStudent && !studentExpandDetails;
  const activeExportOptions = useMemo(
    () =>
      isStudentSummaryActive
        ? exportPresetOptions("student-summary", { includeUnconfirmed: false })
        : exportOptions,
    [isStudentSummaryActive, exportOptions],
  );

  const hasSelectedColumn = useMemo(
    () => hasSelectedExportColumn(activeExportOptions),
    [activeExportOptions],
  );

  const scopePayload = useMemo(() => {
    if (scopeKind === "batch") {
      return selectedBatch
        ? { kind: "batch" as const, batchId: selectedBatch.id, includeUnconfirmed }
        : undefined;
    }
    if (scopeKind === "rubric") {
      return selectedRubric
        ? {
            kind: "rubric" as const,
            assignmentId: selectedRubric.assignmentId,
            rubricVersion: selectedRubric.version,
          }
        : undefined;
    }
    return activeCourseId && selectedStudentNumber
      ? {
          kind: "student" as const,
          courseId: activeCourseId,
          studentNumber: selectedStudentNumber,
        }
      : undefined;
  }, [scopeKind, selectedBatch, includeUnconfirmed, selectedRubric, activeCourseId, selectedStudentNumber]);

  useEffect(() => {
    setSearchQuery("");
    setMinScore("");
    setMaxScore("");
    setDeselectedSessionIds(new Set());
    setStudentExpandDetails(false);
  }, [activeCourseId, scopeKind, selectedBatchId, includeUnconfirmed, selectedRubricKey, selectedStudentNumber]);

  useEffect(() => {
    if (loadingOptions) return;
    if (!scopePayload || !hasSelectedColumn) {
      previewGate.current.invalidate();
      setPreviewLoading(false);
      setPreviewData({ headers: [], rows: [], csvText: "" });
      setPreviewError("");
      return;
    }
    const lease = previewGate.current.begin();
    setPreviewLoading(true);
    setPreviewError("");
    void api<PreviewApiResponse>("/api/grading/exports/preview", {
      method: "POST",
      body: JSON.stringify({ scope: scopePayload, columns: activeExportOptions }),
    })
      .then((result) => {
        if (!lease.isCurrent()) return;
        setPreviewData(result);
        setDeselectedSessionIds((current) => pruneDeselectedSessionIds(current, result.rows));
      })
      .catch((error: Error) => {
        if (!lease.isCurrent()) return;
        setPreviewError(error.message);
        setPreviewData({ headers: [], rows: [], csvText: "" });
      })
      .finally(() => {
        if (lease.isCurrent()) setPreviewLoading(false);
      });
    return () => {
      if (lease.isCurrent()) previewGate.current.invalidate();
    };
  }, [loadingOptions, scopePayload, activeExportOptions, hasSelectedColumn, reloadNonce]);

  const hasActiveFilter = Boolean(searchQuery.trim() || minScore.trim() || maxScore.trim());
  const filteredRows = useMemo(
    () => filterExportPreviewRows(previewData.rows, {
      query: searchQuery,
      minScore,
      maxScore,
    }),
    [previewData.rows, searchQuery, minScore, maxScore],
  );
  const exportableRows = useMemo(
    () => filterExportSelectedRows(filteredRows, deselectedSessionIds),
    [filteredRows, deselectedSessionIds],
  );
  const visibleSelection = useMemo(
    () => getVisibleSelectionState(filteredRows, deselectedSessionIds),
    [filteredRows, deselectedSessionIds],
  );
  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = visibleSelection.someSelected;
    }
  }, [visibleSelection.someSelected]);
  const stats = useMemo(
    () => computeExportSummaryStats(exportableRows),
    [exportableRows],
  );
  const selectedColumnCount = useMemo(
    () => countSelectedExportColumns(activeExportOptions),
    [activeExportOptions],
  );

  const filename = useMemo(() => buildExportFilename({
    scopeKind,
    batchTitle: selectedBatch?.title,
    includeUnconfirmed,
    rubricTitle: selectedRubric?.title,
    rubricVersion: selectedRubric?.version,
    studentNumber: selectedStudent?.studentNumber ?? selectedStudentNumber,
    studentName: selectedStudent?.studentName,
  }), [scopeKind, selectedBatch, includeUnconfirmed, selectedRubric, selectedStudent, selectedStudentNumber]);

  const quickReturn = useMemo(
    () => resolveExportQuickReturn(location, activeCourseId),
    [location, activeCourseId],
  );

  const updateExportOption = (key: keyof GradingExportOptions, checked: boolean) => {
    if (isStudentSummaryActive) {
      setStudentExpandDetails(true);
      setExportOptions(
        normalizeGradingExportOptions({
          ...exportPresetOptions("student-summary"),
          [key]: checked,
        }),
      );
      return;
    }
    setExportOptions((current) =>
      normalizeGradingExportOptions({ ...current, [key]: checked }),
    );
  };

  const applyPreset = (preset: GradingExportPreset) => {
    if (isMultiRubricStudent) {
      if (preset === "student-summary") {
        setStudentExpandDetails(false);
        return;
      }
      setStudentExpandDetails(true);
    }
    setExportOptions(
      exportPresetOptions(preset, {
        includeUnconfirmed: scopeKind === "batch" && includeUnconfirmed,
      }),
    );
  };

  const triggerDownload = () => {
    if (!hasSelectedColumn || exportableRows.length === 0) return;
    const hasDeselectedRows = deselectedSessionIds.size > 0;
    const outputText = !hasActiveFilter && !hasDeselectedRows && previewData.csvText
      ? previewData.csvText
      : serializeExportCsv(previewData.headers, exportableRows);
    const blob = new Blob([outputText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${exportableRows.length} 条成绩记录。`);
  };

  const missingTargetHint = scopeKind === "batch"
    ? (batches.length === 0 ? "当前课程暂无批量批改批次，请先创建并运行批量批改。" : "请在左侧选择一个批改批次。")
    : scopeKind === "rubric"
      ? (rubrics.length === 0 ? "当前课程暂无已冻结评分标准，请先在评分量表页冻结版本。" : "请在左侧选择一个评分标准。")
      : (students.length === 0 ? "当前课程暂无学生批改记录。" : "请在左侧选择一名学生。");

  return (
    <div className="export-page">
      <header className="workspace-header export-page-header">
        <div className="export-page-header-title">
          <h1>成绩导出</h1>
          <p>选择导出范围与列字段，勾选需导出记录并核对统计概览后下载成绩表 CSV。</p>
        </div>
        <div className="export-page-header-actions">
          <div className="export-column-picker" ref={columnPickerRef}>
            <button
              type="button"
              className={`export-column-trigger ${columnPopoverOpen ? "active" : ""} ${!hasSelectedColumn ? "has-warning" : ""}`}
              aria-expanded={columnPopoverOpen}
              aria-haspopup="dialog"
              aria-controls="export-column-settings-popover"
              onClick={() => setColumnPopoverOpen((open) => !open)}
            >
              <span>导出列设置</span>
              <span className="export-column-count">
                {hasSelectedColumn
                  ? `已选 ${selectedColumnCount}/${TOTAL_EXPORT_COLUMNS} 列`
                  : "未选列"}
              </span>
              <span aria-hidden="true">{columnPopoverOpen ? "▴" : "▾"}</span>
            </button>
            {columnPopoverOpen && (
              <div
                id="export-column-settings-popover"
                className="export-column-popover"
                role="dialog"
                aria-label="导出列设置"
              >
                <div className="export-column-popover-head">
                  <strong>导出列设置</strong>
                  <span>已选 {selectedColumnCount}/{TOTAL_EXPORT_COLUMNS} 列</span>
                </div>
                <div className="export-presets-row">
                  <span>快捷方案：</span>
                  <button type="button" onClick={() => applyPreset("summary")}>仅成绩汇总</button>
                  <button type="button" onClick={() => applyPreset("detailed")}>完整明细</button>
                  <button type="button" onClick={() => applyPreset("full")}>含子项置信度</button>
                  <button type="button" onClick={() => applyPreset("all")}>全部列</button>
                </div>
                <div className="export-column-chips" aria-label="导出列选择">
                  {COLUMN_FIELDS.map(([key, label]) => (
                    <label key={key} className={activeExportOptions[key] ? "checked" : ""}>
                      <input
                        type="checkbox"
                        checked={activeExportOptions[key]}
                        onChange={(event) => updateExportOption(key, event.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                  <label
                    className={`${activeExportOptions.itemConfidence ? "checked" : ""} ${!activeExportOptions.itemDetails ? "disabled" : ""}`}
                    title={!activeExportOptions.itemDetails ? "需先勾选「详细得分/扣分」" : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={activeExportOptions.itemConfidence}
                      disabled={!activeExportOptions.itemDetails}
                      onChange={(event) => updateExportOption("itemConfidence", event.target.checked)}
                    />
                    子项置信度
                  </label>
                </div>
                {!hasSelectedColumn && (
                  <p className="inline-requirement-hint" role="alert">
                    请至少选择 1 列导出字段后再预览或下载。
                  </p>
                )}
              </div>
            )}
          </div>
          {quickReturn && (
            <a className="secondary-link-button" href={quickReturn.href}>
              {quickReturn.label}
            </a>
          )}
        </div>
      </header>

      <div className="export-layout">
        <aside className="export-config-pane" aria-label="导出配置">
          <section className="export-config-group">
            <h2 className="export-config-heading">1. 导出维度</h2>
            <div className="export-scope-row" role="radiogroup" aria-label="导出范围">
              {SCOPE_ITEMS.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="radio"
                  aria-checked={scopeKind === item.kind}
                  className={`export-scope-tab ${scopeKind === item.kind ? "active" : ""}`}
                  onClick={() => setScopeKind(item.kind)}
                >
                  <strong>{item.title}</strong>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="export-config-group">
            <h2 className="export-config-heading">2. 选择导出对象</h2>
            {scopeKind === "batch" && (
              <div className="export-selector-stack">
                <label>
                  批改批次
                  <SearchableOptionPicker
                    ariaLabel="选择批改批次"
                    value={selectedBatchId}
                    disabled={batches.length === 0}
                    emptyText="当前课程暂无批次"
                    searchPlaceholder="搜索批次名称或状态…"
                    options={batches.map((batch) => ({
                      value: batch.id,
                      label: batch.title,
                      badge: `已确认 ${batch.counts.completed}/${batch.totalJobs}`,
                      meta: `${batchStatusLabel(batch.status)} · 共 ${batch.totalJobs} 份`,
                    }))}
                    onChange={(nextId) => {
                      setSelectedBatchId(nextId);
                      safeStorageSet(exportBatchStorageKey(activeCourseId), nextId);
                    }}
                  />
                </label>
                <div className="export-batch-mode-toggle" role="radiogroup" aria-label="批次数据口径">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!includeUnconfirmed}
                    className={!includeUnconfirmed ? "active" : ""}
                    onClick={() => setIncludeUnconfirmed(false)}
                  >
                    仅已确认成绩
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={includeUnconfirmed}
                    className={includeUnconfirmed ? "active" : ""}
                    onClick={() => setIncludeUnconfirmed(true)}
                  >
                    含待复核汇总
                  </button>
                </div>
              </div>
            )}

            {scopeKind === "rubric" && (
              <div className="export-selector-stack">
                <label>
                  冻结评分标准
                  <SearchableOptionPicker
                    ariaLabel="选择评分标准"
                    value={selectedRubricKey}
                    disabled={rubrics.length === 0}
                    emptyText="当前课程暂无冻结评分标准"
                    searchPlaceholder="搜索评分标准名称或版本号…"
                    options={rubrics.map((rubric) => {
                      const key = rubricSelectionKey(rubric);
                      const hasCounts = rubric.sessionCount !== undefined || rubric.confirmedCount !== undefined;
                      return {
                        value: key,
                        label: rubric.title,
                        badge: `v${rubric.version}`,
                        ...(hasCounts ? { meta: `已确认 ${rubric.confirmedCount ?? 0} / 共 ${rubric.sessionCount ?? 0} 份` } : {}),
                      };
                    })}
                    onChange={(nextKey) => {
                      setSelectedRubricKey(nextKey);
                      safeStorageSet(exportRubricStorageKey(activeCourseId), nextKey);
                    }}
                  />
                </label>
              </div>
            )}

            {scopeKind === "student" && (
              <div className="export-selector-stack">
                <label>
                  检索学生
                  <input
                    type="search"
                    aria-label="检索学生"
                    value={studentPickerQuery}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      setStudentPickerQuery(nextQuery);
                      const q = nextQuery.trim().toLowerCase();
                      const matched = q
                        ? students.filter((item) => `${item.studentName} ${item.studentNumber}`.toLowerCase().includes(q))
                        : students;
                      if (matched.length > 0 && !matched.some((item) => item.studentNumber === selectedStudentNumber)) {
                        const first = matched[0]!.studentNumber;
                        setSelectedStudentNumber(first);
                        safeStorageSet(exportStudentStorageKey(activeCourseId), first);
                      }
                    }}
                    placeholder="输入姓名或学号筛选…"
                  />
                </label>
                <label>
                  选择学生
                  <select
                    aria-label="选择导出学生"
                    value={selectedStudentNumber}
                    disabled={visibleStudents.length === 0}
                    onChange={(event) => {
                      const nextNum = event.target.value;
                      setSelectedStudentNumber(nextNum);
                      safeStorageSet(exportStudentStorageKey(activeCourseId), nextNum);
                    }}
                  >
                    {visibleStudents.length === 0 ? (
                      <option value="">没有匹配的学生记录</option>
                    ) : (
                      visibleStudents.map((student) => (
                        <option key={student.studentNumber} value={student.studentNumber}>
                          {student.studentName}（{student.studentNumber}）· 已确认 {student.confirmedCount}/{student.totalCount} 份
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            )}
          </section>
        </aside>

        <main className="export-preview-pane">
          <section className={`export-stats-bar ${loadingOptions || previewLoading ? "is-loading" : ""}`} aria-label="成绩统计概览">
            <article className="export-stat-card">
              <span>{scopeKind === "student" ? "导出作业 / 人数" : "导出人数"}</span>
              <strong>
                {loadingOptions || previewLoading
                  ? "—"
                  : stats.totalCount === 0
                    ? "0 人"
                    : stats.uniqueStudentCount === stats.totalCount
                      ? `${stats.uniqueStudentCount} 人`
                      : `${stats.uniqueStudentCount} 人 · ${stats.totalCount} 份`}
              </strong>
            </article>
            <article className="export-stat-card">
              <span>确认状态</span>
              <strong>
                {loadingOptions || previewLoading
                  ? "—"
                  : `已确认 ${stats.confirmedCount} · 待复核 ${stats.needsReviewCount}`}
              </strong>
            </article>
            {stats.totalCount > 0 && !stats.hasUniformPossibleScore && !(loadingOptions || previewLoading) ? (
              <>
                <article className="export-stat-card" title="所选记录含多种满分，已自动按各次作业满分折算百分比统计">
                  <span>平均得分率</span>
                  <strong>{stats.averageScoreRate !== null ? `${stats.averageScoreRate}%` : "—"}</strong>
                </article>
                <article className="export-stat-card" title="所选记录含多种满分，已自动按各次作业满分折算百分比统计">
                  <span>最高 / 最低得分率</span>
                  <strong>
                    {stats.highestScoreRate !== null && stats.lowestScoreRate !== null
                      ? `${stats.highestScoreRate}% / ${stats.lowestScoreRate}%`
                      : "—"}
                  </strong>
                </article>
              </>
            ) : (
              <>
                <article className="export-stat-card">
                  <span>平均分</span>
                  <strong>{loadingOptions || previewLoading ? "—" : stats.averageScore !== null ? stats.averageScore : "—"}</strong>
                </article>
                <article className="export-stat-card">
                  <span>最高 / 最低分</span>
                  <strong>
                    {loadingOptions || previewLoading
                      ? "—"
                      : stats.highestScore !== null && stats.lowestScore !== null
                        ? `${stats.highestScore} / ${stats.lowestScore}`
                        : "—"}
                  </strong>
                </article>
              </>
            )}
          </section>

          <section className="export-preview-table-section" aria-label="导出数据预览">
            <div className="export-filter-bar" aria-label="数据筛选">
              <input
                type="search"
                className="export-filter-search"
                aria-label="关键词筛选"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索学生姓名、学号、作业名称或明细…"
              />
              <div className="export-score-range">
                <span>总分区间</span>
                <input
                  type="number"
                  aria-label="最低分"
                  value={minScore}
                  onChange={(event) => setMinScore(event.target.value)}
                  placeholder="最低"
                />
                <span>–</span>
                <input
                  type="number"
                  aria-label="最高分"
                  value={maxScore}
                  onChange={(event) => setMaxScore(event.target.value)}
                  placeholder="最高"
                />
              </div>
              {hasActiveFilter && (
                <button
                  type="button"
                  className="export-filter-reset"
                  onClick={() => {
                    setSearchQuery("");
                    setMinScore("");
                    setMaxScore("");
                  }}
                >
                  重置筛选
                </button>
              )}
            </div>

            <div className="export-preview-bar">
              <span>
                {loadingOptions || previewLoading
                  ? "正在生成预览…"
                  : hasActiveFilter
                    ? `筛选结果：显示 ${filteredRows.length} / 共 ${previewData.rows.length} 条记录 · 已勾选 ${exportableRows.length} 条 · ${previewData.headers.length} 列`
                    : `预览结果：共 ${previewData.rows.length} 条记录 · 已勾选 ${exportableRows.length} 条 · ${previewData.headers.length} 列`}
              </span>
              <div className="export-preview-bar-actions">
                {isMultiRubricStudent && (
                  <button
                    type="button"
                    className="export-mode-switch-btn"
                    onClick={() => setStudentExpandDetails((expanded) => !expanded)}
                  >
                    {studentExpandDetails
                      ? "收起为跨标准汇总"
                      : `展开全部明细列（当前已省略跨标准稀疏细则）`}
                  </button>
                )}
                <button
                  type="button"
                  disabled={loadingOptions || previewLoading || !scopePayload || !hasSelectedColumn}
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  刷新预览
                </button>
              </div>
            </div>

            {previewError ? (
              <p className="export-preview-error" role="alert">{previewError}</p>
            ) : loadingOptions || previewLoading ? (
              <div className="export-preview-empty">正在读取当前范围的成绩数据…</div>
            ) : !scopePayload ? (
              <div className="export-preview-empty">{missingTargetHint}</div>
            ) : !hasSelectedColumn ? (
              <div className="export-preview-empty">请在顶部「导出列设置」中至少勾选 1 个导出列以预览成绩表格。</div>
            ) : previewData.headers.length === 0 || previewData.rows.length === 0 ? (
              <div className="export-preview-empty">
                {scopeKind === "batch" && !includeUnconfirmed
                  ? "当前批次暂无已确认发布的正式成绩。若需先核对进度，可在左侧切换为「含待复核汇总」。"
                  : "当前范围内暂无符合条件的成绩记录。"}
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="export-preview-empty">
                没有符合当前筛选条件的记录，请调整关键词或总分区间。
              </div>
            ) : (
              <div className="export-preview-table-wrap">
                <table className="export-preview-table">
                  <thead>
                    <tr>
                      <th className="export-select-col">
                        <input
                          ref={selectAllCheckboxRef}
                          type="checkbox"
                          aria-label="全选或取消全选当前记录"
                          checked={visibleSelection.allSelected}
                          onChange={(event) => {
                            setDeselectedSessionIds((current) =>
                              toggleAllVisibleExportRows(current, filteredRows, event.target.checked),
                            );
                          }}
                        />
                      </th>
                      {previewData.headers.map((header, index) => (
                        <th key={`${header}-${index}`}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const isRowSelected = !deselectedSessionIds.has(row.sessionId);
                      const isNeedsReviewRow = row.reviewStatus === "needs_review";
                      const showInlineReviewBadge = isNeedsReviewRow && !activeExportOptions.reviewStatus;
                      return (
                        <tr
                          key={row.sessionId}
                          className={`${isRowSelected ? "" : "is-unselected"} ${isNeedsReviewRow ? "is-needs-review" : ""}`.trim()}
                        >
                          <td className="export-select-col">
                            <input
                              type="checkbox"
                              aria-label={`选择导出 ${row.studentName || row.studentNumber}`}
                              checked={isRowSelected}
                              onChange={(event) => {
                                setDeselectedSessionIds((current) =>
                                  toggleExportRowSelection(current, row.sessionId, event.target.checked),
                                );
                              }}
                            />
                          </td>
                          {previewData.headers.map((header, colIndex) => {
                            const raw = row.cells[colIndex];
                            const text = raw === undefined || raw === null ? "" : String(raw);
                            const isStatusCol = header === "复核状态";
                            return (
                              <td key={colIndex} title={text}>
                                {isStatusCol ? (
                                  <span className={`export-status-badge ${row.reviewStatus === "confirmed" ? "is-confirmed" : "is-review"}`}>
                                    {text}
                                  </span>
                                ) : colIndex === 0 && showInlineReviewBadge ? (
                                  <span className="export-first-cell-inline">
                                    <span>{text}</span>
                                    <span className="export-row-review-tag">待复核</span>
                                  </span>
                                ) : (
                                  text
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className="export-preview-footer">
            <div className="export-preview-footer-meta">
              <span className="export-preview-filename" title={filename}>文件名：{filename}</span>
              {filteredRows.length > 0 && (
                <div className="export-footer-selection-bar">
                  <span>已勾选 {exportableRows.length}/{filteredRows.length} 条</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={visibleSelection.allSelected}
                    onClick={() =>
                      setDeselectedSessionIds((current) =>
                        toggleAllVisibleExportRows(current, filteredRows, true),
                      )
                    }
                  >
                    全选当前
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={exportableRows.length === 0}
                    onClick={() =>
                      setDeselectedSessionIds((current) =>
                        toggleAllVisibleExportRows(current, filteredRows, false),
                      )
                    }
                  >
                    清空
                  </button>
                </div>
              )}
            </div>
            <div className="export-preview-footer-actions">
              <button
                type="button"
                className="primary-button"
                disabled={loadingOptions || previewLoading || !hasSelectedColumn || exportableRows.length === 0}
                onClick={triggerDownload}
              >
                确认下载 CSV（{exportableRows.length} 条）
              </button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
