import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { consumeSse } from "../lib/consume-sse";
import { ApiError, apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage, rubricProblemMessage } from "../lib/api";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import type { RubricValue } from "../components/RubricPreviewEditor";
import { ConfirmDialog, PromptDialog } from "../components/ConfirmDialog";
import { DecisionCards, DecisionEditor } from "../components/grading/DecisionPanels";
import { AnnotatedSubmissionViewer } from "../components/grading/AnnotatedSubmissionViewer";
import { GradingResultReviewShell } from "../components/grading/GradingResultReviewShell";
import {
  collectAllEvidenceTargets,
  QUICK_EDIT_NOTES,
  QUICK_REVIEW_NOTES,
  type EvidenceJumpPayload,
  type EvidenceJumpTarget,
} from "../components/grading/grading-result-model.js";
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
  buildSingleGradingExportHref,
  clampGradingPreviewPercent,
  conversionPresentation,
  countGradingSessionsByStatus,
  formatGradingSessionDisplayTitle,
  gradingSessionStatusLabel,
  gradingSessionWorkflowSummary,
  gradingStatusLabel,
  gradingConversationRequest,
  canAnswerGradingQuestion,
  gradingItemLabel,
  initialLiveMessage,
  filterGradingSessions,
  type GradingSessionFilterStatus,
  resolveGradingSessionScope,
  resolveGradingRubricKey,
  rubricSelectionKey,
  shouldPollSessionPreparation,
  submissionTitlePresentation,
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
  autoConfirmHighConfidence?: boolean;
  confirmationMode?: "auto" | "manual";
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
      lowCount?: number;
      lowConfidenceCount?: number;
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
  confirmed: ({ resultHash: string; confirmationMode?: "auto" | "manual" } & Draft) | null;
  conversation: { messages: ConversationMessage[] };
};
type FrozenRubric = {
  assignmentId: string;
  courseId?: string;
  title: string;
  version: number;
  hash: string;
  rubric: RubricValue;
  sessionCount?: number;
  confirmedCount?: number;
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
  const [sessionList, setSessionList] = useState<{ search: string; items: GradingSession[] }>({ search: "", items: [] }),
    [detail, setDetail] = useState<SessionDetail>(),
    [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const sessions = sessionList.items;
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
    [annotationMode, setAnnotationMode] = useState(false),
    [activeEvidence, setActiveEvidence] = useState<EvidenceJumpTarget>(),
    [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState(""),
    [message, setMessage] = useState(""),
    [live, setLive] = useState<LiveGradingMessage>(),
    [notice, setNotice] = useState("正在加载批改会话…"),
    [reviewNote, setReviewNote] = useState<{ sessionId: string; text: string }>(),
    [acknowledgedReasons, setAcknowledgedReasons] = useState<string[]>([]);
  const [sessionToRename, setSessionToRename] = useState<GradingSession>(),
    [renameTitle, setRenameTitle] = useState(""),
    [sessionToDelete, setSessionToDelete] = useState<GradingSession>(),
    [sessionActionError, setSessionActionError] = useState(""),
    [sessionSearch, setSessionSearch] = useState(""),
    [sessionStatusFilter, setSessionStatusFilter] = useState<GradingSessionFilterStatus>("all"),
    [rubricPickerOpen, setRubricPickerOpen] = useState(false),
    [rubricSearch, setRubricSearch] = useState("");
  const [retryingTitle, setRetryingTitle] = useState<string>();
  const [sessionOperations, setSessionOperations] = useState<string[]>([]);
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
    listGate.current.invalidate();
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
    if (window.location.search !== locationSearch) return undefined;
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
    if (!lease.isCurrent() || window.location.search !== locationSearch) return undefined;
    setSessionList({ search: locationSearch, items: next });
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
      listGate.current.invalidate();
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
        const loadedSessions = await refreshList(
          scopedDetail ??
            (rubric
              ? {
                  assignmentId: rubric.assignmentId,
                  rubricVersion: rubric.version,
                }
              : undefined),
        );
        if (!lease.isCurrent()) return;
        const firstSession = loadedSessions?.[0];
        if (!scopedDetail && !selectedId && query.has("rubric") && firstSession) {
          navigateToSession(firstSession.id);
          return;
        }
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
    setAcknowledgedReasons([]);
  }, [detail?.draft?.version]);
  const preparingDetail = detail && shouldPollSessionPreparation(detail) ? detail : undefined;
  const hasPreparingBackgroundSession = sessionList.search === locationSearch && sessions.some(
    (session) => session.id !== selectedId && shouldPollSessionPreparation(session),
  );
  const shouldPollPreparation = Boolean(preparingDetail) || hasPreparingBackgroundSession;
  const refreshPreparation = useEffectEvent(async () => {
    if (preparingDetail) {
      const next = await refreshDetail(preparingDetail.id);
      if (next) await refreshList(next);
    } else if (hasPreparingBackgroundSession) {
      await refreshList(detail);
    }
  });
  useEffect(() => {
    if (!shouldPollPreparation) return;
    return startSerialPolling(
      () => refreshPreparation(),
      {
        intervalMs: 1_000,
        onError: (error) => setNotice((error as Error).message),
      },
    );
  }, [locationSearch, shouldPollPreparation]);
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
    setSessionList((current) => ({
      ...current,
      items: current.items.map((session) => session.id === sessionId
        ? { ...session, submissionTitleStatus: "resolving", submissionTitleError: undefined }
        : session),
    }));
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
          reviewNote: reviewNote?.sessionId === sessionId ? reviewNote.text : "",
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
    setReviewNote((current) => current?.sessionId === selectedId ? current : undefined);
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

  const dualPaneFullscreen = fullscreen && !creating && Boolean(detail);
  const closeFullscreen = () => {
    setFullscreen(false);
    setAnnotationMode(false);
    setActiveEvidence(undefined);
  };
  useEffect(() => {
    setActiveEvidence(undefined);
  }, [detail?.id]);
  useEffect(() => {
    if (!dualPaneFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sessionToRename && !sessionToDelete) {
        closeFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dualPaneFullscreen, sessionToRename, sessionToDelete]);

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
                    ? selectedRubric.title
                    : rubrics.length === 0
                      ? "当前课程暂无评分标准"
                      : "选择评分标准"}
                </span>
                {selectedRubric && (
                  <span className="rubric-picker-version-badge">v{selectedRubric.version}</span>
                )}
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
                        const sessionCount = rubric.sessionCount ?? 0;
                        const confirmedCount = rubric.confirmedCount ?? 0;
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
                            <span className="rubric-picker-option-meta">
                              {typeof rubric.sessionCount === "number" && (
                                <span className="rubric-picker-count">
                                  {confirmedCount}/{sessionCount} 份
                                </span>
                              )}
                              <span className="rubric-picker-version-badge">v{rubric.version}</span>
                            </span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
          <a
            className="grading-export-header-button"
            href={buildSingleGradingExportHref({
              courseId: activeCourseId,
              rubricKey: selectedRubricKey,
              sessionId: detail?.id,
              studentNumber: detail?.studentNumber,
            })}
          >
            导出成绩
          </a>
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
          <button
            type="button"
            className="grading-upload-trigger"
            onClick={() => setCreating(true)}
          >
            ＋ 上传作业
          </button>
          {(() => {
            const displayedSessions = detail
              ? sessions.map((session) => session.id === detail.id
                ? { ...session, conversionStatus: detail.conversionStatus }
                : session)
              : sessions;
            const statusCounts = countGradingSessionsByStatus(displayedSessions);
            const filteredSessions = filterGradingSessions(
              displayedSessions,
              sessionStatusFilter,
              sessionSearch,
            );
            const filterItems: Array<[GradingSessionFilterStatus, string, number]> = [
              ["all", "全部", statusCounts.all],
              ["pending", "待确认", statusCounts.pending],
              ["confirmed", "已确认", statusCounts.confirmed],
              ...(statusCounts.attention > 0 || sessionStatusFilter === "attention"
                ? ([["attention", "异常", statusCounts.attention]] as Array<[GradingSessionFilterStatus, string, number]>)
                : []),
            ];
            return (
              <>
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
                      {filterItems.map(([statusKey, label, count]) => (
                        <button
                          key={statusKey}
                          type="button"
                          className={sessionStatusFilter === statusKey ? "active" : ""}
                          onClick={() => setSessionStatusFilter(statusKey)}
                        >
                          <span>{label}</span>
                          <em>{count}</em>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <nav>
                  {sessions.length > 0 && filteredSessions.length === 0 ? (
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
                  ) : (
                    filteredSessions.map((session) => {
                      const displayTitle = formatGradingSessionDisplayTitle(session);
                      const statusTone =
                        session.conversionStatus === "conversion_failed" || session.gradingStatus === "failed"
                          ? "is-error"
                          : session.gradingStatus === "confirmed"
                            ? "is-confirmed"
                            : ["needs_review", "waiting_for_teacher"].includes(session.gradingStatus) ||
                                session.conversionStatus === "waiting_for_converter"
                              ? "is-warn"
                              : "";
                      return (
                        <article
                          className={session.id === selectedId ? "active" : ""}
                          key={session.id}
                        >
                          <a
                            href={`/grading?session=${session.id}`}
                            title={`${session.studentName}（${session.studentNumber}）· ${session.title}`}
                            onClick={(event) => {
                              event.preventDefault();
                              setCreating(false);
                              navigateToSession(session.id);
                            }}
                          >
                            <div className="grading-session-card-head">
                              <strong className="grading-session-student-name">{session.studentName}</strong>
                              <span className="grading-session-student-no">{session.studentNumber}</span>
                            </div>
                            {displayTitle &&
                              displayTitle !== session.studentName &&
                              displayTitle !== `${session.studentName} · ${session.studentNumber}` && (
                                <span className="grading-session-card-subtitle">{displayTitle}</span>
                              )}
                            <div className="grading-session-card-meta">
                              <small className={`grading-workflow-tag ${statusTone}${session.gradingStatus === "confirmed" && session.confirmationMode === "auto" ? " is-auto-confirmed" : ""}`}>
                                {gradingSessionWorkflowSummary(session)}
                              </small>
                            </div>
                          </a>
                          <div className="grading-session-actions">
                            <button
                              type="button"
                              aria-label="重命名"
                              title="重命名"
                              onClick={() => {
                                setSessionToRename(session);
                                setRenameTitle(session.title);
                                setSessionActionError("");
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M11.5 2.5a1.5 1.5 0 0 1 2.12 2.12L5.5 12.74l-3 .76.76-3 8.24-8Z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="is-danger"
                              aria-label="删除"
                              title="删除"
                              onClick={() => {
                                setSessionToDelete(session);
                                setSessionActionError("");
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5m2 0-.6 8.1a1.5 1.5 0 0 1-1.5 1.4H6.1a1.5 1.5 0 0 1-1.5-1.4L4 4.5" />
                              </svg>
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </nav>
              </>
            );
          })()}
        </aside>
        <section
          className={`grading-split ${creating ? "is-creating" : ""}`}
          ref={splitRef}
          style={{ "--grading-preview": `${previewPercent}%` } as CSSProperties}
        >
          <main className="grading-conversation">
            {creating ? (
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
                      {gradingStatusLabel(detail.gradingStatus, detail.confirmed?.confirmationMode ?? detail.confirmationMode)}
                      {detail.autoConfirmHighConfidence ? " · 已启用高置信度自动确认" : ""}
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
            className={`grading-preview ${dualPaneFullscreen ? "fullscreen" : ""}`}
          >
            <div className="grading-preview-toolbar">
              {dualPaneFullscreen && detail ? (
                <div className="grading-fullscreen-title">
                  <strong>{annotationMode ? "批注模式" : "双栏全屏对照"}</strong>
                  <span>
                    {detail.studentName}（{detail.studentNumber}）· {detail.submissionTitle ?? detail.title}
                  </span>
                </div>
              ) : (
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
              )}
              <div className="grading-preview-toolbar-actions">
                {dualPaneFullscreen ? (
                  <>
                    <button
                      type="button"
                      className={!annotationMode ? "active" : ""}
                      onClick={() => {
                        setAnnotationMode(false);
                        setActiveEvidence(undefined);
                      }}
                    >
                      双栏对照
                    </button>
                    <button
                      type="button"
                      className={annotationMode ? "active" : ""}
                      onClick={() => setAnnotationMode(true)}
                    >
                      批注模式
                    </button>
                    <button type="button" onClick={closeFullscreen}>
                      退出全屏
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={creating || !detail}
                      onClick={() => {
                        setFullscreen(true);
                        setAnnotationMode(true);
                      }}
                    >
                      批注模式
                    </button>
                    <button
                      type="button"
                      disabled={creating || !detail}
                      onClick={() => {
                        setFullscreen(true);
                        setAnnotationMode(false);
                      }}
                    >
                      双栏全屏
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="grading-preview-body">
              {creating ? (
                <div className="grading-empty"><h3>正在新建会话</h3><p>请完成左侧表单。创建成功后，这里会显示新报告；当前尚无新会话的成绩。</p></div>
              ) : !detail ? (
                <p>选择会话后在此预览。</p>
              ) : (
                <div className={dualPaneFullscreen ? "grading-fullscreen-split" : "grading-single-pane-stack"}>
                  {(dualPaneFullscreen || previewMode === "submission") && (
                    <section className="grading-fullscreen-pane is-submission">
                      {dualPaneFullscreen && (
                        <header className="grading-fullscreen-pane-header">
                          <h3>{annotationMode ? "学生作业（批注视图）" : "学生作业"}</h3>
                          <span>提交版本 {detail.submissionVersion ?? 1}</span>
                        </header>
                      )}
                      {dualPaneFullscreen && annotationMode && !editing && detail.submission ? (
                        <AnnotatedSubmissionViewer
                          sessionId={detail.id}
                          markdown={detail.submission.markdown}
                          decisions={(detail.confirmed ?? detail.draft)?.result.decisions}
                          allTargets={
                            (detail.confirmed ?? detail.draft)?.result.decisions
                              ? collectAllEvidenceTargets((detail.confirmed ?? detail.draft)!.result.decisions, detail.rubric)
                              : []
                          }
                          activeTarget={activeEvidence}
                          onSelectTarget={(payload) => {
                            setActiveEvidence((prev) => ({ ...payload, nonce: (prev?.nonce ?? 0) + 1 }));
                          }}
                          onClearTarget={() => setActiveEvidence(undefined)}
                        />
                      ) : (
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
                      )}
                    </section>
                  )}
                  <section
                    className="grading-fullscreen-pane is-result"
                    hidden={!dualPaneFullscreen && previewMode !== "result"}
                  >
                    {dualPaneFullscreen && (
                      <header className="grading-fullscreen-pane-header">
                        <h3>评分结果与复核</h3>
                        <span>评分标准 v{detail.rubricVersion}</span>
                      </header>
                    )}
                    <ResultPreview
                      key={`${detail.id}:${detail.confirmed ? "confirmed" : "draft"}:${(detail.confirmed ?? detail.draft)?.version ?? ""}`}
                      detail={detail}
                      reviewNote={reviewNote?.sessionId === detail.id ? reviewNote.text : ""}
                      setReviewNote={(text) => setReviewNote({ sessionId: detail.id, text })}
                      acknowledgedReasons={acknowledgedReasons}
                      setAcknowledgedReasons={setAcknowledgedReasons}
                      confirm={confirm}
                      createRevision={createRevision}
                      refresh={async () => {
                        if (selectedIdRef.current === detail.id) await refreshDetail(detail.id);
                      }}
                      operationBusy={{
                        confirm: isSessionOperationBusy("confirm"),
                        revision: isSessionOperationBusy("revision"),
                      }}
                      annotationMode={dualPaneFullscreen && annotationMode}
                      activeEvidenceKey={activeEvidence?.key}
                      onSelectEvidence={dualPaneFullscreen ? (payload) => {
                        setAnnotationMode(true);
                        setActiveEvidence((prev) => ({ ...payload, nonce: (prev?.nonce ?? 0) + 1 }));
                      } : undefined}
                    />
                  </section>
                </div>
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
  annotationMode = false,
  activeEvidenceKey,
  onSelectEvidence,
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
  annotationMode?: boolean;
  activeEvidenceKey?: string | undefined;
  onSelectEvidence?: ((target: EvidenceJumpPayload) => void) | undefined;
}) {
  const draft = detail.confirmed ?? detail.draft;
  const toast = useToast();
  const [manual, setManual] = useState(false);
  const [focusItemKey, setFocusItemKey] = useState<string>();
  const [savingManual, setSavingManual] = useState(false);
  const [showOptionalNote, setShowOptionalNote] = useState(false);
  useUnsavedGuard(manual);
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [editNote, setEditNote] = useState("");
  if (!draft)
    return (
      <div className="grading-empty">
        <h3>尚无评分草稿</h3>
        <p>开始批改后，逐项判断、证据和程序计算的总分会显示在这里。</p>
      </div>
    );
  const result = draft.result;
  const closeManual = () => {
    setManual(false);
    setFocusItemKey(undefined);
    setEdited({});
    setEditNote("");
  };
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
      closeManual();
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
  const requiresReview = result.review.requiresReview;
  const noteVisible = requiresReview || showOptionalNote || reviewNote.length > 0;

  return (
    <div className="grading-result">
      <GradingResultReviewShell
        mode="single"
        sessionId={detail.id}
        result={result}
        rubric={detail.rubric}
        confirmed={Boolean(detail.confirmed)}
        confirmationMode={detail.confirmed?.confirmationMode}
        editing={Boolean(manual && !detail.confirmed)}
        acknowledgedReasons={acknowledgedReasons}
        onChangeAcknowledgedReasons={setAcknowledgedReasons}
        annotationMode={annotationMode}
        activeEvidenceKey={activeEvidenceKey}
        onSelectEvidence={onSelectEvidence}
        onEditItem={!detail.confirmed ? (itemKey) => {
          setEdited(structuredClone(result.decisions));
          setFocusItemKey(itemKey);
          setManual(true);
        } : undefined}
        confirmedSection={detail.confirmed ? (
          <section className={`confirmed-badge${detail.confirmed.confirmationMode === "auto" ? " is-auto-confirmed" : ""}`}>
            <p title={`防篡改校验摘要：${detail.confirmed.resultHash}`}>
              {detail.confirmed.confirmationMode === "auto"
                ? "成绩已自动确认并归档（整体置信度 ≥ 85%）"
                : "成绩已人工确认并归档"}
            </p>
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
        ) : undefined}
        reviewActions={!detail.confirmed && !manual ? (
          <section className="confirm-panel">
            {noteVisible ? (
              <>
                <label>
                  复核备注{requiresReview ? "（必填）" : "（可选）"}
                  <textarea
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                    placeholder={requiresReview ? "请说明核对结果与确认依据…" : "可选：补充复核说明"}
                  />
                </label>
                <div className="grading-quick-note-chips" aria-label="常用复核备注快捷填入">
                  {QUICK_REVIEW_NOTES.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      onClick={() => setReviewNote(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button
                type="button"
                className="text-button grading-optional-note-toggle"
                onClick={() => setShowOptionalNote(true)}
              >
                + 添加复核备注（可选）
              </button>
            )}
            <div className="confirm-panel-actions">
              <button
                type="button"
                onClick={() => {
                  setEdited(structuredClone(result.decisions));
                  setManual(true);
                }}
              >
                人工修订评分项
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirm()}
                disabled={
                  operationBusy.confirm ||
                  (requiresReview && (!reviewNote.trim() || !allAcknowledged))
                }
              >
                {operationBusy.confirm ? "正在确认…" : "确认并发布正式结果"}
              </button>
            </div>
            {requiresReview && (!reviewNote.trim() || !allAcknowledged) && (
              <small className="inline-requirement-hint">
                {!allAcknowledged && !reviewNote.trim()
                  ? "请先勾选上方全部复核原因，并填写复核备注后即可确认"
                  : !allAcknowledged
                    ? "请先勾选上方全部复核原因后即可确认"
                    : "请填写复核备注后即可确认"}
              </small>
            )}
          </section>
        ) : undefined}
        editorSection={manual && !detail.confirmed ? (
          <>
            <DecisionEditor
              decisions={edited}
              rubric={detail.rubric}
              baselineScore={result.score.earned}
              focusItemKey={focusItemKey}
              onChange={setEdited}
            />
            <section className="confirm-panel">
              <label>
                人工修订备注
                <textarea
                  value={editNote}
                  onChange={(event) => setEditNote(event.target.value)}
                  placeholder="简述人工调整分数或理由的原因…"
                />
              </label>
              <div className="grading-quick-note-chips" aria-label="常用修订备注快捷填入">
                {QUICK_EDIT_NOTES.map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    onClick={() => setEditNote(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div>
                <button type="button" onClick={closeManual}>取消修订</button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveManual()}
                  disabled={savingManual || !editNote.trim()}
                >
                  {savingManual ? "正在保存…" : "保存结构化修订"}
                </button>
              </div>
            </section>
          </>
        ) : undefined}
      />
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
  const [error, setError] = useState<{ message: string; fields: string[]; missingReport?: true }>(),
    [submitting, setSubmitting] = useState(false),
    [assetFiles, setAssetFiles] = useState<File[]>([]);
  const errorFields = error?.fields ?? [];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    let reportFilename = "";
    try {
      const form = new FormData(event.currentTarget);
      if (!rubric) throw new Error("请选择冻结评分表");
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        setError({ message: "请先选择学生报告文件", fields: ["file"], missingReport: true });
        return;
      }
      reportFilename = file.name;
      setSubmitting(true);
      form.set("assignmentId", rubric.assignmentId);
      form.set("rubricVersion", String(rubric.version));
      form.delete("assetDirectory");
      const assetManifest = buildAssetManifest(assetFiles);
      for (const asset of assetFiles) form.append("asset", asset);
      form.set("assetManifest", JSON.stringify(assetManifest));
      if (!form.has("autoStartAfterConversion"))
        form.set("autoStartAfterConversion", "false");
      if (!form.has("autoConfirmHighConfidence"))
        form.set("autoConfirmHighConfidence", "false");
      const response = await apiFetch("/api/grading/sessions", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "创建失败");
      const body = await response.json();
      created(String(body.id));
    } catch (cause) {
      const apiError = cause instanceof ApiError ? cause : undefined;
      let message = (cause as Error).message;
      let fields = apiError?.issuePaths ?? [];
      switch (apiError?.code) {
        case "CONVERTER_NOT_CONFIGURED":
          message = "转换服务尚未就绪。请使用发布包启动器启动并等待就绪，再点击“创建会话”。也可改用 Markdown 报告。";
          break;
        case "SUBMISSION_ASSET_MISSING":
          if (reportFilename.toLowerCase().endsWith(".txt")) {
            message = "TXT 报告不支持图片附件。请将报告另存为 .md 并附带 assets 目录，或移除图片引用后重新上传 TXT。";
            fields = ["file"];
          } else {
            message = "Markdown 引用的图片未包含在附件中。请确认引用以 assets/ 开头，在“Markdown 图片目录（可选）”补选包含图片的 assets 目录，再点击“创建会话”。";
            fields = ["assetManifest"];
          }
          break;
      }
      setError({ message, fields });
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
              onChange={(event) => {
                const report = event.currentTarget.files?.[0];
                if (report && report.size > 0) {
                  setError((current) => current?.missingReport ? undefined : current);
                }
              }}
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
        <label className="inline-check inline-check-with-hint">
          <input
            name="autoConfirmHighConfidence"
            type="checkbox"
            value="true"
            defaultChecked={
              localStorage.getItem("grading-auto-confirm") === "true"
            }
            onChange={(event) =>
              localStorage.setItem(
                "grading-auto-confirm",
                String(event.target.checked),
              )
            }
          />
          <span>
            <strong>高置信度结果自动复核确认</strong>
            <small>
              仅作用于本次会话：Agent 批改完成且整体置信度 ≥ 85%、单项 ≥ 70%、无低置信度项、无复核提示或警告且未等待教师回答时自动确认。
            </small>
          </span>
        </label>
        {error?.message && <p className="modal-error">{error.message}</p>}
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
