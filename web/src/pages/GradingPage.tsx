import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { consumeSse } from "../lib/consume-sse";
import { ApiError, apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import type { RubricValue } from "../components/RubricPreviewEditor";
import { GradingReviewChecklist } from "../components/GradingReviewChecklist.js";
import { ConfirmDialog, PromptDialog } from "../components/ConfirmDialog";
import { DecisionCards, DecisionEditor } from "../components/grading/DecisionPanels";
import { useToast } from "../components/ToastProvider";
import { useUnsavedGuard } from "../lib/use-unsaved-guard";
import { COURSE_CHANGED_EVENT, readCourseFromUrl, resolveActiveCourseId, withCourseQuery } from "../lib/course-context";
import { navigateWithinApp } from "../lib/app-navigation";

function gradingRubricStorageKey(courseId: string): string {
  return courseId ? `grading-rubric:${courseId}` : "grading-rubric";
}
export { DecisionCards, DecisionEditor };
import {
  applyGradingEvent,
  buildAssetManifest,
  clampGradingPreviewPercent,
  conversionPresentation,
  gradingSessionStatusLabel,
  gradingSessionWorkflowSummary,
  gradingStatusLabel,
  gradingConversationRequest,
  canAnswerGradingQuestion,
  gradingItemLabel,
  initialLiveMessage,
  normalizeGradingExportOptions,
  parseGradingExportOptions,
  exportPresetOptions,
  filterCsvPreviewRows,
  filterGradingSessions,
  parseCsvPreview,
  serializeCsvTable,
  type CsvPreviewTable,
  type GradingExportPreset,
  type GradingSessionFilterStatus,
  resolveGradingSessionScope,
  resolveGradingRubricKey,
  rubricSelectionKey,
  shouldPollSessionPreparation,
  submissionTitlePresentation,
  type GradingExportOptions,
  type GradingToolStep,
  type LiveGradingMessage,
} from "./grading-page-model";

type GradingSession = {
  id: string;
  courseId: string;
  studentName: string;
  studentNumber: string;
  title: string;
  submissionTitle?: string;
  submissionTitleStatus:
    | "provided"
    | "pending"
    | "resolving"
    | "resolved"
    | "failed";
  submissionTitleError?: {
    code: string;
    message: string;
    lastFailedAt: string;
  };
  assignmentId: string;
  rubricVersion: number;
  conversionStatus: string;
  conversionAttemptCount: number;
  conversionError?: {
    code: string;
    message: string;
    retryable: boolean;
    lastFailedAt: string;
    nextRetryAt?: string;
  };
  gradingStatus: string;
  activeRunId?: string;
  submissionVersion?: number;
};
type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  runId: string;
  process?: string;
  tools?: GradingToolStep[];
  options?: string[];
};
type Draft = {
  version: number;
  result: {
    score: { earned: number; possible: number };
    confidence: {
      overall: number;
      minimum: number;
      lowConfidenceCount: number;
    };
    review: { requiresReview: boolean; reasons: string[] };
    decisions: Record<string, unknown>;
  };
};
type SessionDetail = GradingSession & {
  owningBatchId?: string | null;
  rubric: RubricValue;
  submission: { markdown: string; locked: boolean } | null;
  draft: Draft | null;
  confirmed: ({ resultHash: string } & Draft) | null;
  conversation: { messages: ConversationMessage[] };
};
type FrozenRubric = {
  assignmentId: string;
  courseId?: string;
  title: string;
  version: number;
  hash: string;
  rubric: RubricValue;
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function GradingPage() {
  const toast = useToast();
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const query = new URLSearchParams(locationSearch);
  const selectedId = query.get("session") ?? undefined;
  const [sessions, setSessions] = useState<GradingSession[]>([]),
    [detail, setDetail] = useState<SessionDetail>(),
    [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const [activeCourseId, setActiveCourseId] = useState(() => readCourseFromUrl());
  const [creating, setCreating] = useState(!selectedId),
    [selectedRubricKey, setSelectedRubricKey] = useState(
      query.get("rubric") ?? localStorage.getItem(gradingRubricStorageKey(readCourseFromUrl())) ?? "",
    ),
    [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [previewPercent, setPreviewPercent] = useState(40),
    [dragging, setDragging] = useState(false);
  const [previewMode, setPreviewMode] = useState<"submission" | "result">(
      "submission",
    ),
    [fullscreen, setFullscreen] = useState(false),
    [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState(""),
    [message, setMessage] = useState(""),
    [live, setLive] = useState<LiveGradingMessage>(),
    [notice, setNotice] = useState("正在加载批改会话…"),
    [reviewNote, setReviewNote] = useState(""),
    [acknowledgedReasons, setAcknowledgedReasons] = useState<string[]>([]);
  const [sessionToRename, setSessionToRename] = useState<GradingSession>(),
    [renameTitle, setRenameTitle] = useState(""),
    [sessionToDelete, setSessionToDelete] = useState<GradingSession>(),
    [sessionActionError, setSessionActionError] = useState(""),
    [exportModalOpen, setExportModalOpen] = useState(false),
    [sessionSearch, setSessionSearch] = useState(""),
    [sessionStatusFilter, setSessionStatusFilter] = useState<GradingSessionFilterStatus>("all"),
    [rubricPickerOpen, setRubricPickerOpen] = useState(false),
    [rubricSearch, setRubricSearch] = useState("");
  const [retryingTitle, setRetryingTitle] = useState<string>();
  const [sessionOperations, setSessionOperations] = useState<string[]>([]);
  const [exportOptions, setExportOptions] = useState<GradingExportOptions>(() =>
    parseGradingExportOptions(localStorage.getItem("grading-csv-columns")),
  );
  const splitRef = useRef<HTMLElement>(null);
  const detailGate = useRef(new LatestRequestGate());
  const listGate = useRef(new LatestRequestGate());
  const pageLoadGate = useRef(new LatestRequestGate());
  const runGate = useRef(new LatestRequestGate());
  const selectedIdRef = useRef(selectedId);
  const editingRef = useRef(editing);
  const markdownSessionRef = useRef<string | undefined>(undefined);
  const operationKeysRef = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  editingRef.current = editing;
  useUnsavedGuard(editing);
  const navigateWithinGrading = (search: URLSearchParams) => {
    const currentCourse = readCourseFromUrl() || activeCourseId;
    if (currentCourse && !search.has("course")) search.set("course", currentCourse);
    const suffix = search.toString();
    const nextSessionId = search.get("session") ?? undefined;
    selectedIdRef.current = nextSessionId;
    detailGate.current.invalidate();
    setDetail((current) => current?.id === nextSessionId ? current : undefined);
    window.history.pushState(null, "", `/grading${suffix ? `?${suffix}` : ""}`);
    setLocationSearch(window.location.search);
  };
  const navigateToSession = (id: string) => {
    const search = new URLSearchParams();
    search.set("session", id);
    navigateWithinGrading(search);
  };
  const navigateToRubric = (key: string) => {
    const search = new URLSearchParams();
    if (key) search.set("rubric", key);
    navigateWithinGrading(search);
  };
  const selectedRubric = rubrics.find(
    (rubric) => rubricSelectionKey(rubric) === selectedRubricKey,
  );
  const refreshList = async (
    currentSession?: Pick<GradingSession, "assignmentId" | "rubricVersion">,
  ) => {
    const lease = listGate.current.begin();
    const rubric = resolveGradingSessionScope(
      currentSession,
      rubrics,
      selectedRubricKey,
    );
    const next = rubric
      ? await api<GradingSession[]>(
          `/api/grading/sessions?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`,
        )
      : [];
    if (!lease.isCurrent()) return undefined;
    setSessions(next);
    return next;
  };
  const refreshDetail = async (id = selectedId) => {
    const lease = detailGate.current.begin();
    if (!id) {
      if (lease.isCurrent()) setDetail(undefined);
      return undefined;
    }
    const next = await api<SessionDetail>(`/api/grading/sessions/${id}`);
    if (!lease.isCurrent() || id !== selectedIdRef.current) return undefined;
    setDetail(next);
    const editing = editingRef.current;
    if (markdownSessionRef.current !== next.id) {
      setMarkdown(next.submission?.markdown ?? "");
      markdownSessionRef.current = next.id;
    } else if (!editing) {
      setMarkdown(next.submission?.markdown ?? "");
    }
    if (next.draft || next.confirmed) setPreviewMode("result");
    return next;
  };

  useEffect(() => {
    const updateLocation = () => {
      const nextSessionId = new URLSearchParams(window.location.search).get("session") ?? undefined;
      selectedIdRef.current = nextSessionId;
      detailGate.current.invalidate();
      setDetail((current) => current?.id === nextSessionId ? current : undefined);
      setLocationSearch(window.location.search);
    };
    window.addEventListener("popstate", updateLocation);
    window.addEventListener(COURSE_CHANGED_EVENT, updateLocation);
    return () => {
      window.removeEventListener("popstate", updateLocation);
      window.removeEventListener(COURSE_CHANGED_EVENT, updateLocation);
    };
  }, []);
  useEffect(() => {
    setExportModalOpen(false);
    setRubricPickerOpen(false);
    setCreating(!selectedId && !query.has("rubric"));
  }, [locationSearch]);
  useEffect(() => {
    if (!rubricPickerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRubricPickerOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".rubric-picker")) setRubricPickerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [rubricPickerOpen]);
  useEffect(() => {
    const lease = pageLoadGate.current.begin();
    void (async () => {
      try {
        const courses = await api<Array<{ id: string }>>("/api/courses");
        const resolvedCourseId = resolveActiveCourseId(courses, readCourseFromUrl());
        setActiveCourseId(resolvedCourseId);
        const rubricsUrl = resolvedCourseId
          ? `/api/grading/rubrics?courseId=${encodeURIComponent(resolvedCourseId)}`
          : "/api/grading/rubrics";
        const [rawRubrics, nextDetail] = await Promise.all([
          api<FrozenRubric[]>(rubricsUrl),
          refreshDetail(),
        ]);
        if (!lease.isCurrent()) return;
        const nextRubrics = resolvedCourseId
          ? rawRubrics.filter((item) => !item.courseId || item.courseId === resolvedCourseId)
          : rawRubrics;
        const scopedDetail =
          nextDetail && (!resolvedCourseId || nextDetail.courseId === resolvedCourseId)
            ? nextDetail
            : undefined;
        if (nextDetail && !scopedDetail) {
          selectedIdRef.current = undefined;
          setDetail(undefined);
          navigateWithinApp(withCourseQuery("/grading", resolvedCourseId), true);
        }
        setRubrics(nextRubrics);
        const requestedRubricKey = new URLSearchParams(locationSearch).get("rubric")
          ?? localStorage.getItem(gradingRubricStorageKey(resolvedCourseId))
          ?? "";
        const key = resolveGradingRubricKey(
          nextRubrics,
          scopedDetail
            ? `${scopedDetail.assignmentId}:${scopedDetail.rubricVersion}`
            : requestedRubricKey,
        );
        setSelectedRubricKey(key);
        if (key) localStorage.setItem(gradingRubricStorageKey(resolvedCourseId), key);
        const rubric = nextRubrics.find(
          (item) => rubricSelectionKey(item) === key,
        );
        await refreshList(
          scopedDetail ??
            (rubric
              ? {
                  assignmentId: rubric.assignmentId,
                  rubricVersion: rubric.version,
                }
              : undefined),
        );
        if (!lease.isCurrent()) return;
        setNotice("会话状态已恢复；不会自动重新调用模型。");
      } catch (error) {
        if (lease.isCurrent()) setNotice((error as Error).message);
      }
    })();
    return () => {
      if (lease.isCurrent()) pageLoadGate.current.invalidate();
    };
  }, [locationSearch]);
  useEffect(() => {
    localStorage.setItem("grading-csv-columns", JSON.stringify(exportOptions));
  }, [exportOptions]);
  useEffect(() => {
    setAcknowledgedReasons([]);
  }, [detail?.draft?.version]);
  useEffect(() => {
    if (!detail || !shouldPollSessionPreparation(detail)) return;
    return startSerialPolling(
      async () => {
        const next = await refreshDetail(detail.id);
        if (next) await refreshList(next);
      },
      {
        intervalMs: 1_000,
        onError: (error) => setNotice((error as Error).message),
      },
    );
  }, [
    detail?.id,
    detail?.conversionStatus,
    detail?.conversionError?.nextRetryAt,
    detail?.submissionTitleStatus,
  ]);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const box = splitRef.current?.getBoundingClientRect();
      if (box)
        setPreviewPercent(
          clampGradingPreviewPercent(
            ((box.right - event.clientX) / box.width) * 100,
          ),
        );
    };
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging]);

  const followRun = async (sessionId: string, runId: string) => {
    const lease = runGate.current.begin();
    setLive((current) =>
      current?.runId === runId ? current : initialLiveMessage(runId),
    );
    let after = 0;
    let terminal = false;
    while (!terminal && lease.isCurrent()) {
      const response = await apiFetch(
        `/api/grading/sessions/${sessionId}/runs/${runId}/events?after=${after}&follow=true`,
      );
      if (!response.ok) throw new Error("无法连接批改事件流");
      const result = await consumeSse(response, (type, value) => {
        if (!lease.isCurrent() || selectedIdRef.current !== sessionId) return;
        const event = value as Record<string, unknown>;
        const eventType = typeof event.type === "string" ? event.type : type;
        if (typeof event.sequence === "number")
          after = Math.max(after, event.sequence);
        terminal = ["final", "error", "cancelled"].includes(eventType);
        setLive((current) =>
          applyGradingEvent(current ?? initialLiveMessage(runId), eventType, event),
        );
      });
      if (result.terminalEvent) terminal = true;
      else throw new Error("批改连接已中断，请重试");
    }
    if (lease.isCurrent() && selectedIdRef.current === sessionId)
      await Promise.all([refreshDetail(sessionId), refreshList()]);
  };
  const runSessionOperation = async <T,>(
    name: string,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    const key = `${sessionId}:${name}`;
    if (operationKeysRef.current.has(key)) return undefined;
    operationKeysRef.current.add(key);
    setSessionOperations((current) =>
      current.includes(key) ? current : [...current, key],
    );
    try {
      return await operation();
    } catch (error) {
      if (selectedIdRef.current === sessionId) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
      return undefined;
    } finally {
      operationKeysRef.current.delete(key);
      setSessionOperations((current) =>
        current.filter((item) => item !== key),
      );
    }
  };
  const isSessionOperationBusy = (name: string, sessionId = detail?.id) =>
    Boolean(sessionId && sessionOperations.includes(`${sessionId}:${name}`));
  const startRun = async (kind: "grade" | "chat", text: string) => {
    if (!detail) return;
    const sessionId = detail.id;
    await runSessionOperation("run", sessionId, async () => {
      const run = await api<{ id: string }>(
        kind === "grade"
          ? `/api/grading/sessions/${sessionId}/runs`
          : `/api/grading/sessions/${sessionId}/messages`,
        { method: "POST", body: JSON.stringify({ message: kind === "chat" ? gradingConversationRequest(detail.gradingStatus, text) : text }) },
      );
      if (selectedIdRef.current === sessionId) setMessage("");
      await followRun(sessionId, run.id);
    });
  };
  const cancelRun = async () => {
    if (!detail || !live || live.complete) return;
    const sessionId = detail.id;
    await runSessionOperation("cancel", sessionId, async () => {
      await api(`/api/agent-runs/${live.runId}/cancel`, { method: "POST" });
      if (selectedIdRef.current === sessionId) setNotice("本次运行已停止。");
    });
  };
  const retryConversion = async () => {
    if (!detail) return;
    const sessionId = detail.id;
    await runSessionOperation("conversion", sessionId, async () => {
      await api(`/api/grading/sessions/${sessionId}/conversion/retry`, {
        method: "POST",
      });
      if (selectedIdRef.current === sessionId)
        await Promise.all([refreshDetail(sessionId), refreshList()]);
    });
  };
  const retrySubmissionTitle = async () => {
    if (!detail || retryingTitle === detail.id) return;
    const sessionId = detail.id;
    setRetryingTitle(sessionId);
    setNotice("作业名称正在重新识别…");
    setDetail((current) => current?.id === sessionId
      ? { ...current, submissionTitleStatus: "resolving", submissionTitleError: undefined }
      : current);
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, submissionTitleStatus: "resolving", submissionTitleError: undefined }
      : session));
    try {
      const next = await api<GradingSession>(
        `/api/grading/sessions/${sessionId}/title/retry`,
        { method: "POST" },
      );
      if (selectedIdRef.current === sessionId) {
        setDetail((current) => current?.id === sessionId
          ? { ...current, ...next }
          : current);
        await refreshList(next);
      }
    } catch (error) {
      setRetryingTitle((current) => current === sessionId ? undefined : current);
      if (selectedIdRef.current === sessionId) {
        setNotice((error as Error).message);
        await refreshDetail(sessionId).catch(() => undefined);
      }
    }
  };
  const createRevision = async () => {
    if (!detail) return;
    const sessionId = detail.id;
    await runSessionOperation("revision", sessionId, async () => {
      const revision = await api<{ id: string }>(
        `/api/grading/sessions/${sessionId}/revisions`,
        { method: "POST" },
      );
      if (selectedIdRef.current === sessionId) navigateToSession(revision.id);
    });
  };
  const saveSubmission = async () => {
    if (!detail?.submissionVersion) return;
    const sessionId = detail.id;
    const expectedVersion = detail.submissionVersion;
    await runSessionOperation("save", sessionId, async () => {
      await api(`/api/grading/sessions/${sessionId}/submission`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion, markdown }),
      });
      if (selectedIdRef.current === sessionId) {
        editingRef.current = false;
        setEditing(false);
        await refreshDetail(sessionId);
        await refreshList();
      }
    });
  };
  const confirm = async () => {
    if (!detail?.draft) return;
    const sessionId = detail.id;
    const expectedVersion = detail.draft.version;
    await runSessionOperation("confirm", sessionId, async () => {
      await api(`/api/grading/sessions/${sessionId}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion,
          reviewNote,
          acknowledgedReasons,
        }),
      });
      if (selectedIdRef.current === sessionId) {
        await refreshDetail(sessionId);
        await refreshList();
      }
    });
  };
  const chooseRubric = (key: string) => {
    setSelectedRubricKey(key);
    localStorage.setItem(gradingRubricStorageKey(activeCourseId), key);
    setCreating(false);
    navigateToRubric(key);
  };
  const renameSession = async () => {
    if (!sessionToRename) return;
    try {
      await api(`/api/grading/sessions/${sessionToRename.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: renameTitle }),
      });
      setSessionToRename(undefined);
      setSessionActionError("");
      await refreshList();
      if (detail?.id === sessionToRename.id) await refreshDetail(detail.id);
      toast.success("会话已重命名。");
    } catch (error) {
      setSessionActionError((error as Error).message);
    }
  };
  const deleteSession = async () => {
    if (!sessionToDelete) return;
    try {
      const response = await apiFetch(
        `/api/grading/sessions/${sessionToDelete.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw await apiErrorFromResponse(response, "删除失败");
      const deletingCurrent = selectedId === sessionToDelete.id;
      setSessionToDelete(undefined);
      setSessionActionError("");
      if (deletingCurrent)
        navigateToRubric(selectedRubricKey);
      else await refreshList();
    } catch (error) {
      setSessionActionError((error as Error).message);
    }
  };
  const updateExportOption = (
    key: keyof GradingExportOptions,
    value: boolean,
  ) =>
    setExportOptions((current) =>
      normalizeGradingExportOptions({ ...current, [key]: value }),
    );
  const fetchExportCsv = async (
    kind: "student" | "rubric",
    options: GradingExportOptions,
  ): Promise<{ filename: string; text: string }> => {
    if (!selectedRubric || (kind === "student" && !detail)) {
      throw new Error("请先选择评分标准或批改会话");
    }
    const scope =
      kind === "student"
        ? {
            kind,
            courseId: detail!.courseId,
            studentNumber: detail!.studentNumber,
          }
        : {
            kind,
            assignmentId: selectedRubric.assignmentId,
            rubricVersion: selectedRubric.version,
          };
    const response = await apiFetch(
      "/api/grading/exports/csv",
      withJsonHeaders({
        method: "POST",
        body: JSON.stringify({ scope, columns: options }),
      }),
    );
    if (!response.ok) throw await apiErrorFromResponse(response, "导出失败");
    const text = await response.text();
    const filename =
      kind === "student"
        ? `${detail!.studentNumber}-全部作业.csv`
        : `${selectedRubric.title}-v${selectedRubric.version}-全部学生.csv`;
    return { filename, text };
  };
  const downloadCsv = async (kind: "student" | "rubric") => {
    if (!selectedRubric || (kind === "student" && !detail)) return;
    const scope =
      kind === "student"
        ? {
            kind,
            courseId: detail!.courseId,
            studentNumber: detail!.studentNumber,
          }
        : {
            kind,
            assignmentId: selectedRubric.assignmentId,
            rubricVersion: selectedRubric.version,
          };
    const response = await apiFetch(
      "/api/grading/exports/csv",
      withJsonHeaders({
        method: "POST",
        body: JSON.stringify({ scope, columns: exportOptions }),
      }),
    );
    if (!response.ok) throw await apiErrorFromResponse(response, "导出失败");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download =
      kind === "student"
        ? `${detail!.studentNumber}-全部作业.csv`
        : `${selectedRubric.title}-v${selectedRubric.version}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  useEffect(() => {
    if (detail?.activeRunId && (!live || live.runId !== detail.activeRunId))
      void followRun(detail.id, detail.activeRunId).catch((error: Error) =>
        setNotice(error.message),
      );
  }, [detail?.activeRunId]);

  useEffect(() => {
    if (!retryingTitle) return;
    if (selectedId !== retryingTitle) {
      setRetryingTitle(undefined);
      return;
    }
    if (
      detail?.id === retryingTitle &&
      !["pending", "resolving"].includes(detail.submissionTitleStatus)
    ) setRetryingTitle(undefined);
  }, [selectedId, retryingTitle, detail?.id, detail?.submissionTitleStatus]);

  useEffect(() => {
    runGate.current.invalidate();
    setDetail((current) => current?.id === selectedId ? current : undefined);
    editingRef.current = false;
    setEditing(false);
    setLive(undefined);
  }, [selectedId]);

  const titlePresentation = detail
    ? submissionTitlePresentation({
        status: detail.submissionTitleStatus,
        title: detail.submissionTitle,
        error: detail.submissionTitleError,
        retrying: retryingTitle === detail.id,
      })
    : undefined;

  return (
    <div className="grading-page">
      <header className="grading-header">
        {sidebarCollapsed && (
          <button
            className="rubric-session-toggle"
            type="button"
            onClick={() => setSidebarCollapsed(false)}
          >
            展开会话
          </button>
        )}
        <div className="grading-header-title">
          <h1 title={detail ? detail.title : "单份作业批改"}>{detail ? detail.title : "单份作业批改"}</h1>
          <span className="grading-header-notice">{notice}</span>
        </div>
        <div className="grading-header-tools">
          <div className="grading-header-rubric">
            <span className="grading-header-rubric-label">评分标准</span>
            <div className="rubric-picker">
              <button
                type="button"
                className="rubric-picker-trigger"
                aria-haspopup="listbox"
                aria-expanded={rubricPickerOpen}
                onClick={() => {
                  setRubricPickerOpen((open) => !open);
                  setRubricSearch("");
                }}
              >
                <span className="rubric-picker-value" title={selectedRubric ? `${selectedRubric.title} · v${selectedRubric.version}` : undefined}>
                  {selectedRubric
                    ? `${selectedRubric.title} · v${selectedRubric.version}`
                    : rubrics.length === 0
                      ? "当前课程暂无评分标准"
                      : "选择评分标准"}
                </span>
                <span className="rubric-picker-caret" aria-hidden="true">▾</span>
              </button>
              {rubricPickerOpen && (
                <div className="rubric-picker-popover" role="listbox" aria-label="选择评分标准">
                  <input
                    type="search"
                    className="rubric-picker-search"
                    aria-label="搜索评分标准"
                    value={rubricSearch}
                    onChange={(event) => setRubricSearch(event.target.value)}
                    placeholder="搜索评分标准…"
                    autoFocus
                  />
                  <div className="rubric-picker-list">
                    {(() => {
                      const q = rubricSearch.trim().toLowerCase();
                      const matched = rubrics.filter((rubric) =>
                        !q || `${rubric.title} v${rubric.version}`.toLowerCase().includes(q),
                      );
                      if (matched.length === 0) {
                        return <p className="rubric-picker-empty">没有匹配的评分标准</p>;
                      }
                      return matched.map((rubric) => {
                        const key = rubricSelectionKey(rubric);
                        const active = key === selectedRubricKey;
                        return (
                          <button
                            key={key}
                            type="button"
                            role="option"
                            aria-selected={active}
                            title={`${rubric.title} · v${rubric.version}`}
                            className={`rubric-picker-option ${active ? "active" : ""}`}
                            onClick={() => {
                              setRubricPickerOpen(false);
                              setRubricSearch("");
                              chooseRubric(key);
                            }}
                          >
                            <strong>{rubric.title}</strong>
                            <span>v{rubric.version}</span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
          <ExportPanel
            options={exportOptions}
            active={exportModalOpen}
            disabled={!selectedRubric && !detail}
            onOpen={() => setExportModalOpen((current) => !current)}
          />
        </div>
      </header>
      <div
        className={`grading-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      >
        <aside className="grading-sessions">
          <div className="grading-sidebar-heading">
            <div>
              <strong>批改会话</strong>
              <span>{sessions.length}</span>
            </div>
            <button
              className="rubric-pane-collapse"
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              aria-label="收起批改会话列表"
              title="收起会话列表"
            >
              «
            </button>
          </div>
          <button type="button" onClick={() => { setExportModalOpen(false); setCreating(true); }}>
            ＋ 上传作业
          </button>
          {sessions.length > 0 && (
            <div className="grading-session-filter-box">
              <input
                type="search"
                className="grading-session-search"
                aria-label="搜索批改会话"
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
                placeholder="搜索姓名、学号或作业…"
              />
              <div className="grading-session-filters" role="tablist" aria-label="按批改状态筛选">
                {(
                  [
                    ["all", "全部"],
                    ["pending", "待确认"],
                    ["confirmed", "已确认"],
                    ["attention", "异常"],
                  ] as Array<[GradingSessionFilterStatus, string]>
                ).map(([statusKey, label]) => (
                  <button
                    key={statusKey}
                    type="button"
                    className={sessionStatusFilter === statusKey ? "active" : ""}
                    onClick={() => setSessionStatusFilter(statusKey)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <nav>
            {(() => {
              const filteredSessions = filterGradingSessions(
                sessions,
                sessionStatusFilter,
                sessionSearch,
              );
              if (sessions.length > 0 && filteredSessions.length === 0) {
                return (
                  <div className="sidebar-empty-hint">
                    <p className="muted">没有符合筛选条件的作业</p>
                    <button
                      type="button"
                      className="sidebar-clear-filter"
                      onClick={() => {
                        setSessionSearch("");
                        setSessionStatusFilter("all");
                      }}
                    >
                      清除筛选
                    </button>
                  </div>
                );
              }
              return filteredSessions.map((session) => (
              <article
                className={session.id === selectedId ? "active" : ""}
                key={session.id}
              >
                <a
                  href={`/grading?session=${session.id}`}
                  title={`${session.studentName}（${session.studentNumber}）· ${session.title}`}
                  onClick={(event) => {
                    event.preventDefault();
                    setExportModalOpen(false);
                    setCreating(false);
                    navigateToSession(session.id);
                  }}
                >
                  <strong>{session.title}</strong>
                  {(!session.submissionTitle || !(session.title ?? "").includes(session.submissionTitle)) && (
                    <span>{session.submissionTitle ?? gradingSessionStatusLabel(session)}</span>
                  )}
                  {session.title !== `${session.studentName} · ${session.studentNumber}` && (
                    <small>
                      {session.studentName} · {session.studentNumber}
                    </small>
                  )}
                  <small className={`grading-workflow-tag ${session.conversionStatus === "conversion_failed" || session.gradingStatus === "failed" ? "is-error" : session.gradingStatus === "confirmed" ? "is-confirmed" : ""}`}>
                    {gradingSessionWorkflowSummary(session)}
                  </small>
                </a>
                <div className="grading-session-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setSessionToRename(session);
                      setRenameTitle(session.title);
                      setSessionActionError("");
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionToDelete(session);
                      setSessionActionError("");
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
              ));
            })()}
          </nav>
        </aside>
        <section
          className={`grading-split ${creating || exportModalOpen ? "is-creating" : ""}`}
          ref={splitRef}
          style={{ "--grading-preview": `${previewPercent}%` } as CSSProperties}
        >
          <main className="grading-conversation">
            {exportModalOpen ? (
              <ExportPreviewDialog
                open={exportModalOpen}
                options={exportOptions}
                setOption={updateExportOption}
                applyPreset={(preset) => setExportOptions(exportPresetOptions(preset))}
                canExportStudent={Boolean(detail)}
                canExportRubric={Boolean(selectedRubric)}
                studentLabel={detail ? `${detail.studentName}（${detail.studentNumber}）` : undefined}
                rubricLabel={selectedRubric ? `${selectedRubric.title} · v${selectedRubric.version}` : undefined}
                fetchCsv={fetchExportCsv}
                onClose={() => setExportModalOpen(false)}
              />
            ) : creating ? (
              <NewSessionPanel
                rubric={selectedRubric}
                close={() => setCreating(false)}
                created={navigateToSession}
              />
            ) : !detail ? (
              <div className="grading-empty">
                <h2>从一份学生报告开始</h2>
                <p>
                  上传 Markdown、DOCX、PDF、PPTX 或图片，并选择已冻结的评分表。
                </p>
                <button type="button" onClick={() => setCreating(true)}>
                  创建批改会话
                </button>
              </div>
            ) : (
              <>
                <div className="grading-chat-heading">
                  <div>
                    <h2>与批改 Agent 对话</h2>
                    <p>
                      评分标准版本 {detail.rubricVersion} ·{" "}
                      {gradingStatusLabel(detail.gradingStatus)}
                    </p>
                    <p>
                      作业名称：
                      {titlePresentation?.label}
                    </p>
                    {titlePresentation?.error && (
                      <p className="modal-error">
                        {userErrorMessage(titlePresentation.error.code)}
                      </p>
                    )}
                  </div>
                  {titlePresentation?.showRetry && (
                    <button
                      type="button"
                      disabled={titlePresentation.retryDisabled}
                      onClick={() => void retrySubmissionTitle()}
                    >
                      {titlePresentation.retryLabel}
                    </button>
                  )}
                  {detail.conversionStatus === "ready" &&
                    !detail.owningBatchId &&
                    ["not_started", "queued", "failed", "cancelled"].includes(
                      detail.gradingStatus,
                    ) &&
                    !detail.activeRunId && (
                      <button
                        type="button"
                        disabled={isSessionOperationBusy("run")}
                        onClick={() =>
                          void startRun("grade", "请开始批改当前作业。")
                        }
                      >
                        {isSessionOperationBusy("run")
                          ? "正在开始…"
                          : ["failed", "cancelled"].includes(detail.gradingStatus)
                            ? "重试批改"
                            : "开始批改"}
                      </button>
                    )}
                </div>
                <div className="grading-message-list">
                  {detail.conversation.messages.map((item, index) => (
                    <ConversationBubble
                      message={item}
                      canAnswer={!detail.owningBatchId && canAnswerGradingQuestion(detail.gradingStatus, Boolean(live && !live.complete), index, detail.conversation.messages.length - 1) && !isSessionOperationBusy("run")}
                      onOption={(option) => void startRun("chat", option)}
                      key={`${item.runId}-${index}`}
                    />
                  ))}
                  {live &&
                    !detail.conversation.messages.some(
                      ({ runId, role }) =>
                        runId === live.runId && role === "assistant",
                    ) && <LiveBubble message={live} />}
                </div>
                {detail.owningBatchId ? <div className="grading-composer grading-composer-help" role="status">
                  <p>此会话属于批量批改，不能在单份页面发送对话。请进入批次 Review 核对评分、人工修订或确认；需要回答教师问题时，请到批量工作台处理。</p>
                  <a href={`/grading/batches/review?batch=${encodeURIComponent(detail.owningBatchId)}&session=${encodeURIComponent(detail.id)}`}>进入本批次 Review</a>
                </div> : <form
                  className="grading-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim()) void startRun("chat", message);
                  }}
                >
                  <textarea
                    aria-label="批改对话消息"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                      event.preventDefault();
                      if (message.trim() && !isSessionOperationBusy("run") && !(live && !live.complete)) void startRun("chat", message);
                    }}
                    aria-describedby="grading-send-help"
                    placeholder={detail.gradingStatus === "waiting_for_teacher" ? "回答上面的评分问题，发送后继续批改" : "询问评分依据，或明确要求 Agent 修改草稿"}
                    disabled={
                      Boolean(live && !live.complete) ||
                      isSessionOperationBusy("run")
                    }
                  />
                  {live && !live.complete ? (
                    <button
                      type="button"
                      disabled={isSessionOperationBusy("cancel")}
                      onClick={() => void cancelRun()}
                    >
                      {isSessionOperationBusy("cancel") ? "正在停止…" : "停止"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!message.trim() || isSessionOperationBusy("run")}
                    >
                      {isSessionOperationBusy("run") ? "正在发送…" : detail.gradingStatus === "waiting_for_teacher" ? "回答并继续批改" : "发送"}
                    </button>
                  )}
                </form>}
                {!detail.owningBatchId && <p className="grading-send-help" id="grading-send-help">Enter 换行 · Ctrl＋Enter（Mac：⌘＋Enter）发送；发送后等待本轮完成。</p>}
              </>
            )}
          </main>
          <button
            className="grading-resizer"
            type="button"
            aria-label="调整预览宽度"
            onPointerDown={() => setDragging(true)}
          />
          <aside
            className={`grading-preview ${fullscreen ? "fullscreen" : ""}`}
          >
            <div className="grading-preview-toolbar">
              <div>
                <button
                  disabled={creating}
                  className={previewMode === "submission" ? "active" : ""}
                  onClick={() => setPreviewMode("submission")}
                >
                  学生作业
                </button>
                <button
                  disabled={creating}
                  className={previewMode === "result" ? "active" : ""}
                  onClick={() => setPreviewMode("result")}
                >
                  评分结果
                </button>
              </div>
              <button disabled={creating} onClick={() => setFullscreen((value) => !value)}>
                {fullscreen ? "退出全屏" : "全屏"}
              </button>
            </div>
            <div className="grading-preview-body">
              {creating ? (
                <div className="grading-empty"><h3>正在新建会话</h3><p>请完成左侧表单。创建成功后，这里会显示新报告；当前尚无新会话的成绩。</p></div>
              ) : !detail ? (
                <p>选择会话后在此预览。</p>
              ) : previewMode === "submission" ? (
                <SubmissionPreview
                  detail={detail}
                  editing={editing}
                  markdown={markdown}
                  setMarkdown={setMarkdown}
                  setEditing={setEditing}
                  save={saveSubmission}
                  retry={retryConversion}
                  reupload={() => setCreating(true)}
                  createRevision={createRevision}
                  operationBusy={{
                    conversion: isSessionOperationBusy("conversion"),
                    revision: isSessionOperationBusy("revision"),
                    save: isSessionOperationBusy("save"),
                  }}
                />
              ) : (
                <ResultPreview
                  detail={detail}
                  reviewNote={reviewNote}
                  setReviewNote={setReviewNote}
                  acknowledgedReasons={acknowledgedReasons}
                  setAcknowledgedReasons={setAcknowledgedReasons}
                  confirm={confirm}
                  createRevision={createRevision}
                  refresh={() => refreshDetail(detail.id).then(() => undefined)}
                  operationBusy={{
                    confirm: isSessionOperationBusy("confirm"),
                    revision: isSessionOperationBusy("revision"),
                  }}
                />
              )}
            </div>
          </aside>
        </section>
      </div>
      <PromptDialog
        open={Boolean(sessionToRename)}
        title="重命名批改会话"
        label="会话名称"
        value={renameTitle}
        maxLength={80}
        error={sessionActionError}
        onChange={setRenameTitle}
        onConfirm={() => void renameSession()}
        onCancel={() => { setSessionToRename(undefined); setSessionActionError(""); }}
      />
      <ConfirmDialog
        open={Boolean(sessionToDelete)}
        title="删除批改会话？"
        description={sessionToDelete ? `“${sessionToDelete.title}”的作业文件、批改过程和结果将从本机永久删除，无法恢复。` : ""}
        confirmLabel="永久删除"
        tone="danger"
        error={sessionActionError}
        onConfirm={() => void deleteSession()}
        onCancel={() => { setSessionToDelete(undefined); setSessionActionError(""); }}
      />
    </div>
  );
}

export function ConversationBubble({
  message,
  onOption,
  canAnswer,
}: {
  message: ConversationMessage;
  onOption(option: string): void;
  canAnswer: boolean;
}) {
  return (
    <article className={`grading-message ${message.role}`}>
      <div>
        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
        {message.options && message.options.length > 0 && (canAnswer ? (
          <div className="preview-actions">
            {message.options.map((option) => (
              <button
                type="button"
                onClick={() => onOption(option)}
                key={option}
              >
                {option}
              </button>
            ))}
          </div>
        ) : <section className="grading-question-history"><small>历史提问选项，仅作记录；请使用当前对话中的操作。</small><ul>{message.options.map(option => <li key={option}>{option}</li>)}</ul></section>)}
        {message.role === "assistant" && (
          <>
            <details>
              <summary>处理过程</summary>
              <p>{message.process || "已完成安全的评分分析。"}</p>
            </details>
            {message.tools && message.tools.length > 0 && (
              <details>
                <summary>工具调用（{message.tools.length}）</summary>
                <ToolList tools={message.tools} />
              </details>
            )}
          </>
        )}
      </div>
    </article>
  );
}
function LiveBubble({ message }: { message: LiveGradingMessage }) {
  return (
    <article className="grading-message assistant live">
      <div>
        <details open={!message.complete}>
          <summary>{message.complete ? "处理过程" : "正在处理…"}</summary>
          <p>{message.process}</p>
        </details>
        <ToolList tools={message.tools} />
        {message.content && (
          <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
        )}
      </div>
    </article>
  );
}
function ToolList({ tools }: { tools: GradingToolStep[] }) {
  return (
    <ol className="grading-tools">
      {tools.map((tool) => (
        <li className={tool.status} key={tool.id}>
          <strong>{tool.label}</strong>
          <span>{tool.summary}</span>
        </li>
      ))}
    </ol>
  );
}
function SubmissionPreview({
  detail,
  editing,
  markdown,
  setMarkdown,
  setEditing,
  save,
  retry,
  reupload,
  createRevision,
  operationBusy,
}: {
  detail: SessionDetail;
  editing: boolean;
  markdown: string;
  setMarkdown(value: string): void;
  setEditing(value: boolean): void;
  save(): Promise<void>;
  retry(): Promise<void>;
  reupload(): void;
  createRevision(): Promise<void>;
  operationBusy: {
    conversion: boolean;
    revision: boolean;
    save: boolean;
  };
}) {
  if (!detail.submission) {
    const presentation = conversionPresentation(detail)!;
    return (
      <div className={`grading-empty conversion-state ${presentation.tone}`}>
        <h3>{presentation.title}</h3>
        <p>{presentation.message}</p>
        <p>原始作业已保存在受控工作区；转换完成前不会开始评分或作业命名。</p>
        {detail.conversionAttemptCount > 0 && (
          <p>已尝试 {detail.conversionAttemptCount} 次</p>
        )}
        <div className="conversion-actions">
          {presentation.canRetry && (
            <button
              type="button"
              disabled={operationBusy.conversion}
              onClick={() => void retry()}
            >
              {operationBusy.conversion ? "正在重试…" : "立即重试"}
            </button>
          )}
          {presentation.canReupload && (
            <button type="button" className="secondary" onClick={reupload}>
              重新上传文件
            </button>
          )}
        </div>
        {presentation.canReupload && (
          <small>重新上传会创建新会话，不会覆盖本会话的原始文件。</small>
        )}
      </div>
    );
  }
  return (
    <div className="submission-document">
      <div className="preview-actions">
        <span>提交版本 {detail.submissionVersion}</span>
        {detail.submission.locked ? (
          <button
            type="button"
            disabled={operationBusy.revision}
            onClick={() => void createRevision()}
          >
            {operationBusy.revision ? "正在创建…" : "创建提交修订"}
          </button>
        ) : editing ? (
          <>
            <button onClick={() => setEditing(false)}>取消</button>
            <button
              disabled={operationBusy.save}
              onClick={() => void save()}
            >
              {operationBusy.save ? "正在保存…" : "保存修订"}
            </button>
          </>
        ) : (
          <button onClick={() => setEditing(true)}>编辑 Markdown</button>
        )}
      </div>
      {editing ? (
        <textarea
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
        />
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url, key) =>
            key === "src" && url.startsWith("assets/")
              ? `/api/grading/sessions/${detail.id}/assets/${encodeURIComponent(url.slice("assets/".length))}`
              : url
          }
        >
          {detail.submission.markdown}
        </Markdown>
      )}
    </div>
  );
}
function ResultPreview({
  detail,
  reviewNote,
  setReviewNote,
  acknowledgedReasons,
  setAcknowledgedReasons,
  confirm,
  createRevision,
  refresh,
  operationBusy,
}: {
  detail: SessionDetail;
  reviewNote: string;
  setReviewNote(value: string): void;
  acknowledgedReasons: string[];
  setAcknowledgedReasons(value: string[]): void;
  confirm(): Promise<void>;
  createRevision(): Promise<void>;
  refresh(): Promise<void>;
  operationBusy: { confirm: boolean; revision: boolean };
}) {
  const draft = detail.confirmed ?? detail.draft;
  const toast = useToast();
  const [manual, setManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  useUnsavedGuard(manual);
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [editNote, setEditNote] = useState("");
  useEffect(() => {
    if (draft) setEdited(structuredClone(draft.result.decisions));
  }, [draft?.version]);
  if (!draft)
    return (
      <div className="grading-empty">
        <h3>尚无评分草稿</h3>
        <p>开始批改后，逐项判断、证据和程序计算的总分会显示在这里。</p>
      </div>
    );
  const result = draft.result;
  const saveManual = async () => {
    if (!detail.draft || !editNote.trim() || savingManual) return;
    setSavingManual(true);
    try {
      await api(`/api/grading/sessions/${detail.id}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: detail.draft.version,
          draft: edited,
          note: editNote,
        }),
      });
      await refresh();
      setManual(false);
      setEditNote("");
      toast.success("人工修订已保存并重新计算总分。");
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSavingManual(false);
    }
  };
  const allAcknowledged = result.review.reasons.every((reason) =>
    acknowledgedReasons.includes(reason),
  );
  return (
    <div className="grading-result">
      <header>
        <div>
          <span>程序计算总分</span>
          <strong>
            {result.score.earned}/{result.score.possible}
          </strong>
        </div>
        <span>置信度 {(result.confidence.overall * 100).toFixed(0)}%</span>
      </header>
      <GradingReviewChecklist confirmed={Boolean(detail.confirmed)} reasons={result.review.reasons} notices={Array.isArray(result.decisions.warnings) ? result.decisions.warnings as string[] : []} acknowledgedReasons={acknowledgedReasons} onChange={setAcknowledgedReasons} />
      {manual && !detail.confirmed ? (
        <DecisionEditor decisions={edited} rubric={detail.rubric} baselineScore={result.score.earned} onChange={setEdited} />
      ) : (
        <DecisionCards decisions={result.decisions} rubric={detail.rubric} sessionId={detail.id} />
      )}
      {detail.confirmed ? (
        <section className="confirmed-badge">
          <p>已确认 · 结果哈希 {detail.confirmed.resultHash.slice(0, 12)}…</p>
          <div className="preview-actions">
            <a href={`/api/grading/sessions/${detail.id}/export.json`} download>
              导出 JSON
            </a>
            <a href={`/api/grading/sessions/${detail.id}/export.md`} download>
              导出 Markdown
            </a>
            <button
              type="button"
              disabled={operationBusy.revision}
              onClick={() => void createRevision()}
            >
              {operationBusy.revision ? "正在创建…" : "创建结果修订"}
            </button>
          </div>
        </section>
      ) : (
        <section className="confirm-panel">
          {manual ? (
            <>
              <label>
                人工修订备注
                <textarea
                  value={editNote}
                  onChange={(event) => setEditNote(event.target.value)}
                />
              </label>
              <div>
                <button onClick={() => setManual(false)}>取消修订</button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveManual()}
                  disabled={savingManual || !editNote.trim()}
                >
                  {savingManual ? "正在保存…" : "保存结构化修订"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button onClick={() => setManual(true)}>人工修订评分项</button>
              <label>
                复核备注
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirm()}
                disabled={
                  operationBusy.confirm ||
                  (result.review.requiresReview &&
                    (!reviewNote.trim() || !allAcknowledged))
                }
              >
                {operationBusy.confirm ? "正在确认…" : "确认并发布正式结果"}
              </button>
              {result.review.requiresReview && (!reviewNote.trim() || !allAcknowledged) && (
                <small className="inline-requirement-hint">
                  {!allAcknowledged && !reviewNote.trim()
                    ? "请先勾选上方全部复核原因，并填写复核备注后即可确认"
                    : !allAcknowledged
                      ? "请先勾选上方全部复核原因后即可确认"
                      : "请填写复核备注后即可确认"}
                </small>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
function NewSessionPanel({
  rubric,
  close,
  created,
}: {
  rubric?: FrozenRubric;
  close(): void;
  created(id: string): void;
}) {
  const [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false),
    [errorFields, setErrorFields] = useState<string[]>([]),
    [assetFiles, setAssetFiles] = useState<File[]>([]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setErrorFields([]);
    try {
      const form = new FormData(event.currentTarget);
      if (!rubric) throw new Error("请选择冻结评分表");
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        setErrorFields(["file"]);
        throw new Error("请先选择学生报告文件");
      }
      form.set("assignmentId", rubric.assignmentId);
      form.set("rubricVersion", String(rubric.version));
      form.delete("assetDirectory");
      const assetManifest = buildAssetManifest(assetFiles);
      for (const asset of assetFiles) form.append("asset", asset);
      form.set("assetManifest", JSON.stringify(assetManifest));
      if (!form.has("autoStartAfterConversion"))
        form.set("autoStartAfterConversion", "false");
      const response = await apiFetch("/api/grading/sessions", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "创建失败");
      const body = await response.json();
      created(String(body.id));
    } catch (cause) {
      if (cause instanceof ApiError) setErrorFields(cause.issuePaths);
      setError((cause as Error).message);
      setSubmitting(false);
    }
  };
  return (
    <div className="grading-inline-create">
      <form
        className="grading-new-dialog"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <h2>新建批改会话</h2>
        <p className="grading-selected-rubric">
          评分标准：
          {rubric ? `${rubric.title} · v${rubric.version}` : "请先在左侧选择"}
        </p>
        <div className="grading-create-row">
          <label>
            学生姓名
            <input
              name="studentName"
              placeholder="与学号同留空时自动从文件名识别"
              aria-invalid={errorFields.includes("studentName") || undefined}
            />
          </label>
          <label>
            学号
            <input
              name="studentNumber"
              placeholder="需与学生姓名同时填写"
              aria-invalid={errorFields.includes("studentNumber") || undefined}
            />
          </label>
        </div>
        <label>
          作业名称（可选）
          <input
            name="submissionTitle"
            maxLength={200}
            placeholder="留空时自动从正文或文件名识别（冲突时以正文为准）"
          />
        </label>
        <div className="grading-create-row">
          <label className="grading-file-field">
            学生报告
            <input
              name="file"
              type="file"
              required
              accept=".md,.txt,.pdf,.docx,.pptx,.png,.jpg,.jpeg"
              aria-invalid={errorFields.includes("file") || undefined}
            />
            <small>支持 Markdown、TXT、DOCX、PDF、PPTX 与图片</small>
          </label>
          <label className="grading-file-field">
            Markdown 图片目录（可选）
            <input
              name="assetDirectory"
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.gif,.webp"
              aria-invalid={errorFields.includes("assetManifest") || undefined}
              onChange={(event) => setAssetFiles(Array.from(event.target.files ?? []))}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
            <small>{assetFiles.length ? `已选择 ${assetFiles.length} 个附件` : "仅 Markdown 引用本地图片时选择 assets 目录"}</small>
          </label>
        </div>
        <label className="inline-check">
          <input
            name="autoStartAfterConversion"
            type="checkbox"
            value="true"
            defaultChecked={
              localStorage.getItem("grading-auto-start") === "true"
            }
            onChange={(event) =>
              localStorage.setItem(
                "grading-auto-start",
                String(event.target.checked),
              )
            }
          />
          转换完成后自动开始批改
        </label>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={submitting || !rubric}>
            {submitting ? "正在创建…" : "创建会话"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ExportPanel({
  options,
  active,
  disabled,
  onOpen,
}: {
  options: GradingExportOptions;
  active: boolean;
  disabled: boolean;
  onOpen(): void;
}) {
  const selectedCount = Object.values(options).filter(Boolean).length;
  return (
    <button
      type="button"
      className={`grading-export-header-button ${active ? "active" : ""}`}
      aria-pressed={active}
      disabled={disabled}
      title={`预览并导出成绩表 CSV（已选 ${selectedCount} 列）`}
      onClick={onOpen}
    >
      {active ? "返回批改" : `导出 CSV（${selectedCount}列）`}
    </button>
  );
}

function ExportPreviewDialog({
  open,
  options,
  setOption,
  applyPreset,
  canExportStudent,
  canExportRubric,
  studentLabel,
  rubricLabel,
  fetchCsv,
  onClose,
}: {
  open: boolean;
  options: GradingExportOptions;
  setOption(key: keyof GradingExportOptions, value: boolean): void;
  applyPreset(preset: GradingExportPreset): void;
  canExportStudent: boolean;
  canExportRubric: boolean;
  studentLabel?: string;
  rubricLabel?: string;
  fetchCsv(
    kind: "student" | "rubric",
    options: GradingExportOptions,
  ): Promise<{ filename: string; text: string }>;
  onClose(): void;
}) {
  const [scopeKind, setScopeKind] = useState<"student" | "rubric">(
    canExportRubric ? "rubric" : "student",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [csvText, setCsvText] = useState("");
  const [filename, setFilename] = useState("grades.csv");
  const [preview, setPreview] = useState<CsvPreviewTable>({ headers: [], rows: [] });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");

  useEffect(() => {
    if (!open) return;
    if (scopeKind === "student" && !canExportStudent && canExportRubric) {
      setScopeKind("rubric");
    } else if (scopeKind === "rubric" && !canExportRubric && canExportStudent) {
      setScopeKind("student");
    }
  }, [open, canExportStudent, canExportRubric, scopeKind]);

  useEffect(() => {
    if (!open) return;
    if ((scopeKind === "student" && !canExportStudent) || (scopeKind === "rubric" && !canExportRubric)) {
      setPreview({ headers: [], rows: [] });
      setCsvText("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void fetchCsv(scopeKind, options)
      .then((result) => {
        if (cancelled) return;
        setCsvText(result.text);
        setFilename(result.filename);
        setPreview(parseCsvPreview(result.text));
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setError(cause.message);
        setCsvText("");
        setPreview({ headers: [], rows: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scopeKind, options, canExportStudent, canExportRubric, reloadNonce]);

  useEffect(() => {
    setSearchQuery("");
    setMinScore("");
    setMaxScore("");
  }, [scopeKind]);

  if (!open) return null;

  const fields: Array<[keyof GradingExportOptions, string]> = [
    ["studentName", "学生姓名"],
    ["studentNumber", "学号"],
    ["submissionTitle", "作业名称"],
    ["itemDetails", "详细得分点 / 扣分点"],
    ["totalScore", "总分"],
    ["overallConfidence", "总置信度"],
  ];

  const scoreFilterAvailable =
    options.totalScore && preview.headers.some((header) => /总分|score/i.test(header));
  const hasActiveFilter = Boolean(
    searchQuery.trim() || (scoreFilterAvailable && (minScore.trim() || maxScore.trim())),
  );
  const filteredPreview = filterCsvPreviewRows(preview, {
    query: searchQuery,
    minScore: scoreFilterAvailable ? minScore : "",
    maxScore: scoreFilterAvailable ? maxScore : "",
  });

  const triggerDownload = () => {
    if (!csvText || filteredPreview.rows.length === 0) return;
    const outputText = hasActiveFilter ? serializeCsvTable(filteredPreview) : csvText;
    const blob = new Blob([outputText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="export-workspace"
      aria-label="导出成绩表预览"
    >
      <div className="export-preview-modal">
        <header className="export-preview-header">
          <div>
            <h2>导出成绩表 CSV</h2>
            <p>选择导出范围与列，筛选并实时预览表格内容后再下载。</p>
          </div>
        </header>

        <section className="export-preview-controls">
          <div className="export-scope-row" role="radiogroup" aria-label="导出范围">
            <button
              type="button"
              className={`export-scope-tab ${scopeKind === "rubric" ? "active" : ""}`}
              disabled={!canExportRubric}
              onClick={() => setScopeKind("rubric")}
            >
              <strong>当前评分标准全部学生</strong>
              <small title={rubricLabel}>{rubricLabel ?? "请先选择评分标准"}</small>
            </button>
            <button
              type="button"
              className={`export-scope-tab ${scopeKind === "student" ? "active" : ""}`}
              disabled={!canExportStudent}
              onClick={() => setScopeKind("student")}
            >
              <strong>当前学生全部作业</strong>
              <small title={studentLabel}>{studentLabel ?? "请先选择一份批改会话"}</small>
            </button>
          </div>

          <div className="export-presets-row">
            <span>快捷方案：</span>
            <button type="button" onClick={() => applyPreset("summary")}>仅成绩汇总</button>
            <button type="button" onClick={() => applyPreset("detailed")}>完整明细</button>
            <button type="button" onClick={() => applyPreset("full")}>含子项置信度</button>
          </div>

          <div className="export-column-chips" aria-label="导出列选择">
            {fields.map(([key, label]) => (
              <label key={key} className={options[key] ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={options[key]}
                  onChange={(event) => setOption(key, event.target.checked)}
                />
                {label}
              </label>
            ))}
            <label className={`${options.itemConfidence ? "checked" : ""} ${!options.itemDetails ? "disabled" : ""}`}>
              <input
                type="checkbox"
                checked={options.itemConfidence}
                disabled={!options.itemDetails}
                onChange={(event) => setOption("itemConfidence", event.target.checked)}
              />
              子项置信度
            </label>
          </div>
        </section>

        <section className="export-preview-table-section" aria-label="导出数据预览">
          <div className="export-filter-bar" aria-label="数据筛选">
            <input
              type="search"
              className="export-filter-search"
              aria-label="关键词筛选"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索学生姓名、学号、作业名称或评语…"
            />
            <div
              className={`export-score-range ${!scoreFilterAvailable ? "disabled" : ""}`}
              title={!scoreFilterAvailable ? "勾选「总分」列后可按总分区间筛选" : undefined}
            >
              <span>总分区间</span>
              <input
                type="number"
                aria-label="最低分"
                disabled={!scoreFilterAvailable}
                value={minScore}
                onChange={(event) => setMinScore(event.target.value)}
                placeholder="最低"
              />
              <span>–</span>
              <input
                type="number"
                aria-label="最高分"
                disabled={!scoreFilterAvailable}
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
              {loading
                ? "正在生成预览…"
                : hasActiveFilter
                  ? `筛选结果：显示 ${filteredPreview.rows.length} / 共 ${preview.rows.length} 条记录 · ${preview.headers.length} 列（导出将仅包含筛选结果）`
                  : `预览结果：共 ${preview.rows.length} 条记录 · ${preview.headers.length} 列`}
            </span>
            <button type="button" disabled={loading} onClick={() => setReloadNonce((n) => n + 1)}>
              刷新预览
            </button>
          </div>
          {error ? (
            <p className="export-preview-error" role="alert">{error}</p>
          ) : loading ? (
            <div className="export-preview-empty">正在读取当前范围的成绩数据…</div>
          ) : preview.headers.length === 0 || preview.rows.length === 0 ? (
            <div className="export-preview-empty">
              当前范围内暂无已确认发布的成绩记录。请先在批改会话中确认并发布正式结果后再导出。
            </div>
          ) : filteredPreview.rows.length === 0 ? (
            <div className="export-preview-empty">
              没有符合当前筛选条件的记录，请调整关键词或总分区间。
            </div>
          ) : (
            <div className="export-preview-table-wrap">
              <table className="export-preview-table">
                <thead>
                  <tr>
                    {filteredPreview.headers.map((header, index) => (
                      <th key={`${header}-${index}`}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPreview.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {filteredPreview.headers.map((_, colIndex) => {
                        const value = row[colIndex] ?? "";
                        return (
                          <td key={colIndex} title={value}>
                            {value}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="export-preview-footer">
          <span className="export-preview-filename" title={filename}>文件名：{filename}</span>
          <div className="export-preview-footer-actions">
            <button type="button" onClick={onClose}>返回</button>
            <button
              type="button"
              className="primary-button"
              disabled={loading || !csvText || filteredPreview.rows.length === 0}
              onClick={triggerDownload}
            >
              确认下载 CSV（{filteredPreview.rows.length} 条）
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}
