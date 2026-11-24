import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RubricDocument, RubricEditor, type RubricMode, type RubricValue } from "../components/RubricPreviewEditor";
import { ToolActivity, type ToolStep } from "../components/ToolActivity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { useUnsavedGuard } from "../lib/use-unsaved-guard";
import { withJsonHeaders, apiFetch, apiErrorFromResponse, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";
import {
  COURSE_CHANGED_EVENT,
  readCourseFromUrl,
  readStoredCourseId,
  resolveActiveCourseId,
  withCourseQuery,
} from "../lib/course-context";
import { LatestRequestGate, type RequestLease } from "../lib/async-state";
import { consumeSse } from "../lib/consume-sse";
import { appendRubricProcess, appendRubricReply, assertRubricStreamSucceeded, assignmentIdFromSearch, clampPreviewPercent, loadRubricSession, rubricCompletionNotice, rubricDeleteWarning, shouldFollowRubricStream } from "./rubric-page-model";

type Course = { id: string; name: string };
type RubricAssignment = { id: string; courseId: string; title: string; totalScore: number; requirements: string; sources: Array<{ id: string; role: "rubric_draft" | "note"; name: string; size: number }> };
type Recommendation = { mode: RubricMode; recommended: boolean; reason?: string; benefit?: string };
type RubricDraft = { version: number; updatedAt: string; baseRubricVersion?: number; rubric: RubricValue };
type FrozenRubric = { version: number; hash: string; frozenAt: string; rubric: RubricValue };
type RubricMessage = { id: string; role: "user" | "assistant"; content: string; process?: string; tools?: ToolStep[]; options?: string[] };
type RubricSession = { assignmentId: string; selectedMode: RubricMode; updatedAt: string; messages: Array<{ role: "user" | "assistant"; content: string; process?: string; tools?: Array<{ id: string; label: string; summary: string; status: "completed" | "failed" }>; options?: string[] }> };
type RubricValidation = { errors: Array<{ code: string; message: string; path?: string }>; warnings: Array<{ code: string; message: string; path?: string }> };
type StreamEvent = { code?: string; type?: string; id?: string; label?: string; summary?: string; status?: "completed" | "failed"; delta?: string; kind?: "question" | "reply" | "draft"; message?: string; reply?: string; question?: { question: string; options?: string[] } };

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };
const firstDraftRequest = "请根据当前作业要求和参考资料生成第一版评分表。";
const narrowRubricWorkspace = "(max-width: 900px)";

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response, "请求失败");
  return response.json() as Promise<T>;
}

function storedMessages(session: RubricSession | null): RubricMessage[] {
  return (session?.messages ?? []).map((message, index) => ({
    ...message,
    id: `${session!.assignmentId}-${index}`,
    ...(message.tools ? { tools: message.tools.map((tool) => ({ ...tool })) } : {}),
  }));
}

export function RubricPage() {
  const toast = useToast();
  const selectedAssignmentId = assignmentIdFromSearch(window.location.search);
  const [assignments, setAssignments] = useState<RubricAssignment[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const courseIdRef = useRef("");
  courseIdRef.current = courseId;
  const [courseName, setCourseName] = useState("");
  const [assignment, setAssignment] = useState<RubricAssignment>();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [selectedMode, setSelectedMode] = useState<RubricMode>();
  const [draft, setDraft] = useState<RubricDraft>();
  const [versions, setVersions] = useState<FrozenRubric[]>([]);
  const [messages, setMessages] = useState<RubricMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [title, setTitle] = useState("");
  const [totalScore, setTotalScore] = useState("100");
  const [requirements, setRequirements] = useState("");
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceRole, setSourceRole] = useState<"rubric_draft" | "note">("rubric_draft");
  const [notice, setNotice] = useState("正在加载评分会话…");
  const [submitting, setSubmitting] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia(narrowRubricWorkspace).matches);
  const [previewPercent, setPreviewPercent] = useState(38);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followStreamRef = useRef(true);
  const assignmentGate = useRef(new LatestRequestGate());
  const versionsGate = useRef(new LatestRequestGate());
  const streamGate = useRef(new LatestRequestGate());
  const streamControllerRef = useRef<AbortController | undefined>(undefined);
  const selectedAssignmentIdRef = useRef(selectedAssignmentId);
  selectedAssignmentIdRef.current = selectedAssignmentId;
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<"draft" | number>("draft");
  const [editing, setEditing] = useState(false);
  useUnsavedGuard(editing);
  const [editedRubric, setEditedRubric] = useState<RubricValue>();
  const [validation, setValidation] = useState<RubricValidation>();
  const [freezeReady, setFreezeReady] = useState(false);
  const [assignmentToDelete, setAssignmentToDelete] = useState<RubricAssignment>();
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const assignmentsGate = useRef(new LatestRequestGate());

  useEffect(() => {
    const media = window.matchMedia(narrowRubricWorkspace);
    const update = (event: MediaQueryListEvent) => setSidebarCollapsed(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const refreshAssignments = async (targetCourseId?: string) => {
    const effectiveCourseId = targetCourseId ?? (readCourseFromUrl() || courseIdRef.current || readStoredCourseId());
    const lease = assignmentsGate.current.begin();
    if (!effectiveCourseId) {
      if (lease.isCurrent()) setAssignments([]);
      return [];
    }
    const raw = await api<RubricAssignment[]>(
      `/api/rubrics/assignments?courseId=${encodeURIComponent(effectiveCourseId)}`,
    );
    const next = raw.filter((item) => item.courseId === effectiveCourseId);
    if (!lease.isCurrent()) return next;
    setAssignments(next);
    return next;
  };
  const refreshCourses = async (preferredCourseId?: string) => {
    const next = await api<Course[]>("/api/courses");
    setCourses(next);
    setCourseId((current) => {
      const preferred = preferredCourseId ?? current;
      if (next.some((course) => course.id === preferred)) return preferred;
      return resolveActiveCourseId(next, readCourseFromUrl());
    });
    return next;
  };
  const refreshVersions = async (assignmentId: string, owner?: RequestLease) => {
    const lease = versionsGate.current.begin();
    const next = await api<FrozenRubric[]>(`/api/rubrics/assignments/${assignmentId}/versions`);
    if (
      !lease.isCurrent() ||
      assignmentId !== selectedAssignmentIdRef.current ||
      (owner && !owner.isCurrent())
    ) return undefined;
    setVersions(next);
    return next;
  };
  const refreshSessionState = async (assignmentId: string) => {
    const lease = assignmentGate.current.begin();
    const [nextDraft, nextSession, nextVersions] = await Promise.all([
      api<RubricDraft | null>(`/api/rubrics/assignments/${assignmentId}/draft`),
      api<RubricSession | null>(`/api/rubrics/assignments/${assignmentId}/session`),
      api<FrozenRubric[]>(`/api/rubrics/assignments/${assignmentId}/versions`),
    ]);
    if (!lease.isCurrent() || assignmentId !== selectedAssignmentIdRef.current) return undefined;
    setDraft(nextDraft ?? undefined);
    setSelectedMode(nextSession?.selectedMode);
    setMessages(storedMessages(nextSession));
    setVersions(nextVersions);
    if (nextDraft) setPreviewVersion("draft");
    else if (nextVersions[0]) setPreviewVersion(nextVersions[0].version);
    return { nextDraft, nextSession, nextVersions };
  };

  const clearSelectedSession = () => {
    streamControllerRef.current?.abort();
    streamControllerRef.current = undefined;
    streamGate.current.invalidate();
    assignmentGate.current.invalidate();
    versionsGate.current.invalidate();
    setAssignment(undefined);
    setRecommendations([]);
    setSelectedMode(undefined);
    setDraft(undefined);
    setVersions([]);
    setMessages([]);
    setSubmitting(false);
    setStreamingMessageId(undefined);
  };

  useEffect(() => {
    void refreshCourses(readCourseFromUrl()).then((nextCourses) => {
      const resolved = resolveActiveCourseId(nextCourses, readCourseFromUrl());
      courseIdRef.current = resolved;
      setCourseId(resolved);
      return refreshAssignments(resolved).then((list) => ({ resolved, list }));
    }).then(({ resolved, list }) => {
      if (selectedAssignmentId && !list.some((item) => item.id === selectedAssignmentId)) {
        clearSelectedSession();
        navigateWithinApp(withCourseQuery("/rubrics", resolved), true);
        return;
      }
      if (!selectedAssignmentId) setNotice("创建新评分表，或继续已有评分会话。");
    }).catch((error: Error) => setNotice(error.message));
  }, [selectedAssignmentId]);

  useEffect(() => {
    const syncRoute = () => {
      const nextAssignmentId = assignmentIdFromSearch(window.location.search);
      if (nextAssignmentId === selectedAssignmentIdRef.current) return;
      selectedAssignmentIdRef.current = nextAssignmentId;
      streamControllerRef.current?.abort();
      streamControllerRef.current = undefined;
      streamGate.current.invalidate();
      assignmentGate.current.invalidate();
      versionsGate.current.invalidate();
      setAssignment(undefined);
      setRecommendations([]);
      setSelectedMode(undefined);
      setDraft(undefined);
      setVersions([]);
      setMessages([]);
      setSubmitting(false);
      setStreamingMessageId(undefined);
    };
    const syncCourseAndAssignments = () => {
      const nextCourseId = readCourseFromUrl() || readStoredCourseId();
      if (nextCourseId !== courseIdRef.current) {
        setAssignments([]);
        setSessionQuery("");
      }
      courseIdRef.current = nextCourseId;
      setCourseId(nextCourseId);
      void Promise.all([refreshAssignments(nextCourseId), refreshCourses(nextCourseId)]).then(([list]) => {
        const currentAssignment = assignmentIdFromSearch(window.location.search);
        if (currentAssignment && !list.some((item) => item.id === currentAssignment)) {
          clearSelectedSession();
          navigateWithinApp(withCourseQuery("/rubrics", nextCourseId), true);
        }
      }).catch((error: Error) => setNotice(error.message));
    };
    const handlePopState = () => {
      syncRoute();
      const nextCourseId = readCourseFromUrl();
      if (nextCourseId && nextCourseId !== courseIdRef.current) {
        syncCourseAndAssignments();
      }
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener(COURSE_CHANGED_EVENT, syncCourseAndAssignments);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener(COURSE_CHANGED_EVENT, syncCourseAndAssignments);
    };
  }, []);

  useEffect(() => {
    streamControllerRef.current?.abort();
    streamControllerRef.current = undefined;
    streamGate.current.invalidate();
    setSubmitting(false);
    setStreamingMessageId(undefined);
    const lease = assignmentGate.current.begin();
    if (!selectedAssignmentId) {
      setAssignment(undefined);
      setSelectedMode(undefined);
      setDraft(undefined);
      setVersions([]);
      setMessages([]);
      return;
    }
    setNotice("正在加载所选评分会话…");
    setAssignment(undefined);
    setSelectedMode(undefined);
    setDraft(undefined);
    setVersions([]);
    setMessages([]);
    setRecommendations([]);
    setEditing(false);
    setValidation(undefined);
    let loadedDraft: RubricDraft | null | undefined;
    void Promise.all([
      loadRubricSession({
        assignment: () => api<RubricAssignment>(`/api/rubrics/assignments/${selectedAssignmentId}`),
        draft: () => api<RubricDraft | null>(`/api/rubrics/assignments/${selectedAssignmentId}/draft`),
        session: () => api<RubricSession | null>(`/api/rubrics/assignments/${selectedAssignmentId}/session`),
        recommendations: () => api<{ options: Recommendation[] }>(`/api/rubrics/assignments/${selectedAssignmentId}/recommendations`),
        onCore: (nextAssignment, nextDraft, nextSession) => {
          if (!lease.isCurrent() || selectedAssignmentId !== selectedAssignmentIdRef.current) return;
          const activeCourse = readCourseFromUrl() || courseIdRef.current;
          if (activeCourse && nextAssignment.courseId && nextAssignment.courseId !== activeCourse) {
            clearSelectedSession();
            navigateWithinApp(withCourseQuery("/rubrics", activeCourse), true);
            return;
          }
          loadedDraft = nextDraft;
          setAssignment(nextAssignment);
          setDraft(nextDraft ?? undefined);
          setSelectedMode(nextSession?.selectedMode);
          const restored = storedMessages(nextSession);
          setMessages(restored.length === 0 && nextSession && nextDraft ? [{ id: `${nextSession.assignmentId}-legacy`, role: "assistant", content: "已恢复现有评分表草稿。该会话创建于历史记录持久化功能上线前，因此早期对话和工具步骤无法恢复；后续对话会完整保存。" }] : restored);
          setPreviewVersion(nextDraft ? "draft" : "draft");
          setNotice(nextSession ? "已恢复评分会话和历史记录，不会自动调用 AI。" : "请选择评分制度后开始设计。");
        },
        onRecommendations: (recommendation) => {
          if (!lease.isCurrent() || selectedAssignmentId !== selectedAssignmentIdRef.current) return;
          setRecommendations(recommendation.options);
          setNotice("请选择评分制度；选择后会直接生成第一版草稿，无需填写备注。");
        },
      }),
      refreshVersions(selectedAssignmentId, lease),
    ]).then(([, nextVersions]) => {
      if (!lease.isCurrent() || selectedAssignmentId !== selectedAssignmentIdRef.current) return;
      if (!loadedDraft && nextVersions?.[0]) setPreviewVersion(nextVersions[0].version);
    }).catch((error: Error) => {
      if (lease.isCurrent()) setNotice(error.message);
    });
  }, [selectedAssignmentId]);

  useEffect(() => () => {
    streamControllerRef.current?.abort();
    streamGate.current.invalidate();
    assignmentGate.current.invalidate();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setPreviewPercent(clampPreviewPercent(((bounds.right - event.clientX) / bounds.width) * 100));
    };
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
  }, [dragging]);

  useEffect(() => {
    if (!editing && draft) setEditedRubric(structuredClone(draft.rubric));
  }, [draft, editing]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!streamingMessageId || !followStreamRef.current || !list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, streamingMessageId]);

  const createAssignment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!courseId) { setNotice("请选择课程；如果还没有课程，可以在下方直接新建。"); return; }
    if (!requirements.trim() && !source.trim()) { setNotice("请填写作业要求，或提供一份参考资料。"); return; }
    setSubmitting(true);
    try {
      const sourceContent = source.trim();
      const created = await api<RubricAssignment>("/api/rubrics/assignments", {
        method: "POST",
        body: JSON.stringify({ courseId, title, totalScore: Number(totalScore), requirements, sources: sourceContent ? [{ role: sourceRole, name: sourceName || (sourceRole === "rubric_draft" ? "评分标准草稿.txt" : "设计备注.txt"), content: sourceContent }] : [] }),
      });
      navigateWithinApp(withCourseQuery(`/rubrics?assignment=${encodeURIComponent(created.id)}`, courseId));
    } catch (error) { setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const createCourse = async () => {
    const name = courseName.trim();
    if (!name) return;
    setSubmitting(true);
    try {
      const created = await api<Course>("/api/courses", { method: "POST", body: JSON.stringify({ name }) });
      setCourseName("");
      await refreshCourses(created.id);
      setNotice(`已创建并选择课程：${created.name}`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const readSourceFile = async (file: File | undefined) => {
    if (!file) return;
    try { setSource(await file.text()); setSourceName(file.name); setNotice(`已载入参考资料：${file.name}`); }
    catch { setNotice("参考资料读取失败，请改为粘贴文本。"); }
  };

  const updateStreamingAssistant = (assistantId: string, update: (message: RubricMessage) => RubricMessage) => {
    setMessages((items) => items.map((message) => message.id === assistantId ? update(message) : message));
  };

  const runAgentRequest = async (url: string, init: RequestInit, teacherMessage: string) => {
    if (!selectedAssignmentId) return;
    const requestAssignmentId = selectedAssignmentId;
    const lease = streamGate.current.begin();
    const aborter = new AbortController();
    streamControllerRef.current = aborter;
    const assistantId = crypto.randomUUID();
    followStreamRef.current = true;
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", content: teacherMessage }, { id: assistantId, role: "assistant", content: "", tools: [] }]);
    setStreamingMessageId(assistantId);
    try {
    const response = await apiFetch(url, withJsonHeaders({ ...init, signal: aborter.signal }));
    if (!response.ok) throw await apiErrorFromResponse(response, "设计请求失败");
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const manual = await response.json() as { selectedMode?: RubricMode; message?: string; draft?: RubricDraft };
      if (!lease.isCurrent() || requestAssignmentId !== selectedAssignmentIdRef.current) return;
      if (manual.selectedMode) setSelectedMode(manual.selectedMode);
      if (manual.draft) { setDraft(manual.draft); setPreviewVersion("draft"); }
      setMessages((items) => items.filter((message) => message.id !== assistantId));
      setNotice(manual.message ?? "评分制度已保存；当前可使用右侧人工编辑器创建草稿。");
      return;
    }
    let streamFailure: string | undefined;
    let completedKind: StreamEvent["kind"];
    const result = await consumeSse(response, (eventName, raw) => {
      if (!lease.isCurrent() || requestAssignmentId !== selectedAssignmentIdRef.current) return;
      const event = raw as StreamEvent;
      const eventType = event.type ?? eventName;
      if (eventType === "process_delta" && event.delta) updateStreamingAssistant(assistantId, (message) => ({ ...message, process: appendRubricProcess(message.process ?? "", event.delta!) }));
      if (eventType === "reply_delta" && event.delta) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: appendRubricReply(message.content, event.delta!) }));
      if (eventType === "tool_start" && event.id && event.label && event.summary) updateStreamingAssistant(assistantId, (message) => ({ ...message, tools: [...(message.tools ?? []), { id: event.id!, label: event.label!, summary: event.summary!, status: "running" }] }));
      if (eventType === "tool_end" && event.id) updateStreamingAssistant(assistantId, (message) => ({ ...message, tools: (message.tools ?? []).map((tool) => tool.id === event.id ? { ...tool, status: event.status === "failed" ? "failed" : "completed" } : tool) }));
      if (eventType === "question" && event.question) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: event.question!.question, options: event.question!.options }));
      if (eventType === "reply" && event.reply) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: event.reply! }));
      if (eventType === "draft") void api<RubricDraft | null>(`/api/rubrics/assignments/${requestAssignmentId}/draft`).then((nextDraft) => {
        if (lease.isCurrent() && requestAssignmentId === selectedAssignmentIdRef.current) setDraft(nextDraft ?? undefined);
      }).catch((error: Error) => {
        if (lease.isCurrent() && requestAssignmentId === selectedAssignmentIdRef.current) setNotice(error.message);
      });
      if (eventType === "final") {
        completedKind = event.kind;
        updateStreamingAssistant(assistantId, (message) => ({ ...message, content: message.content || (event.kind === "draft" ? event.summary ?? "评分表草稿已更新，可以在右侧预览并继续修改。" : event.message ?? "本轮处理已完成。") }));
      }
      if (eventType === "error") {
        streamFailure = userErrorMessage(event.code ?? "RUBRIC_DESIGN_FAILED");
        updateStreamingAssistant(assistantId, (message) => ({ ...message, content: streamFailure! }));
      }
    });
    if (!result.terminalEvent) throw new Error("评分表设计连接已中断，请重试");
    assertRubricStreamSucceeded(streamFailure);
    if (!lease.isCurrent() || requestAssignmentId !== selectedAssignmentIdRef.current) return;
    await refreshSessionState(requestAssignmentId);
    await refreshAssignments();
    if (requestAssignmentId === selectedAssignmentIdRef.current) setNotice(rubricCompletionNotice(completedKind));
    } finally {
      if (streamControllerRef.current === aborter)
        streamControllerRef.current = undefined;
    }
  };

  const chooseMode = async (mode: RubricMode) => {
    if (!selectedAssignmentId) return;
    const requestAssignmentId = selectedAssignmentId;
    setSubmitting(true);
    setSelectedMode(mode);
    setNotice(`已选择${modeLabel[mode]}，Agent 正在生成第一版草稿…`);
    try { await runAgentRequest(`/api/rubrics/assignments/${selectedAssignmentId}/mode/stream`, { method: "PUT", body: JSON.stringify({ mode }) }, firstDraftRequest); }
    catch (error) {
      if (requestAssignmentId === selectedAssignmentIdRef.current) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setNotice((error as Error).message);
        await refreshSessionState(requestAssignmentId).catch(() => undefined);
      }
    }
    finally {
      if (requestAssignmentId === selectedAssignmentIdRef.current) {
        setSubmitting(false);
        setStreamingMessageId(undefined);
      }
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!selectedAssignmentId || !selectedMode || !text) return;
    const requestAssignmentId = selectedAssignmentId;
    setChatInput("");
    setSubmitting(true);
    setNotice("Agent 正在根据你的反馈更新评分表…");
    try { await runAgentRequest(`/api/rubrics/assignments/${selectedAssignmentId}/messages/stream`, { method: "POST", body: JSON.stringify({ message: text }) }, text); }
    catch (error) {
      if (requestAssignmentId === selectedAssignmentIdRef.current) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setNotice((error as Error).message);
        await refreshSessionState(requestAssignmentId).catch(() => undefined);
      }
    }
    finally {
      if (requestAssignmentId === selectedAssignmentIdRef.current) {
        setSubmitting(false);
        setStreamingMessageId(undefined);
      }
    }
  };

  const saveManualDraft = async () => {
    if (!selectedAssignmentId || !draft || !editedRubric) return;
    const requestAssignmentId = selectedAssignmentId;
    setSubmitting(true);
    try {
      const saved = await api<RubricDraft>(`/api/rubrics/assignments/${requestAssignmentId}/draft`, { method: "PUT", body: JSON.stringify({ expectedVersion: draft.version, rubric: editedRubric }) });
      if (requestAssignmentId !== selectedAssignmentIdRef.current) return;
      setDraft(saved); setEditing(false); setValidation(undefined); setFreezeReady(false); setNotice(`人工修改已保存为草稿 v${saved.version}。`); toast.success(`人工修改已保存为草稿 v${saved.version}。`);
    } catch (error) { if (requestAssignmentId === selectedAssignmentIdRef.current) setNotice((error as Error).message); }
    finally { if (requestAssignmentId === selectedAssignmentIdRef.current) setSubmitting(false); }
  };

  const validateForFreeze = async () => {
    if (!selectedAssignmentId || !draft) return;
    const requestAssignmentId = selectedAssignmentId;
    setSubmitting(true);
    try {
      const result = await api<RubricValidation>(`/api/rubrics/assignments/${requestAssignmentId}/validate`, { method: "POST", body: JSON.stringify({ rubric: draft.rubric }) });
      if (requestAssignmentId !== selectedAssignmentIdRef.current) return;
      setValidation(result); setFreezeReady(result.errors.length === 0); setNotice(result.errors.length ? "评分表仍有错误，修正后才能冻结。" : "校验通过，请确认冻结为正式版本。");
    } catch (error) { if (requestAssignmentId === selectedAssignmentIdRef.current) { setFreezeReady(false); setNotice((error as Error).message); } }
    finally { if (requestAssignmentId === selectedAssignmentIdRef.current) setSubmitting(false); }
  };

  const freezeDraft = async () => {
    if (!selectedAssignmentId || !draft || !validation || validation.errors.length > 0) return;
    const requestAssignmentId = selectedAssignmentId;
    setSubmitting(true);
    try {
      const frozen = await api<FrozenRubric>(`/api/rubrics/assignments/${requestAssignmentId}/freeze`, { method: "POST", body: JSON.stringify({ expectedVersion: draft.version, acknowledgedWarningCodes: validation.warnings.map((warning) => warning.code) }) });
      if (requestAssignmentId !== selectedAssignmentIdRef.current) return;
      setDraft(undefined); setEditing(false); setFreezeReady(false); setValidation(undefined); setPreviewVersion(frozen.version); await refreshVersions(requestAssignmentId); await refreshAssignments(); if (requestAssignmentId === selectedAssignmentIdRef.current) { setNotice(`评分表 v${frozen.version} 已冻结，可正式应用。`); toast.success(`评分表 v${frozen.version} 已冻结，可用于作业批改。`); }
    } catch (error) { if (requestAssignmentId === selectedAssignmentIdRef.current) setNotice((error as Error).message); }
    finally { if (requestAssignmentId === selectedAssignmentIdRef.current) setSubmitting(false); }
  };

  const createRevision = async (version: number) => {
    if (!selectedAssignmentId) return;
    const requestAssignmentId = selectedAssignmentId;
    setSubmitting(true);
    try {
      const revision = await api<RubricDraft>(`/api/rubrics/assignments/${requestAssignmentId}/versions/${version}/revisions`, { method: "POST" });
      if (requestAssignmentId !== selectedAssignmentIdRef.current) return;
      setDraft(revision); setPreviewVersion("draft"); setEditing(false); setValidation(undefined); setNotice(`已从冻结版本 v${version} 创建新的可编辑修订草稿。`);
    } catch (error) { if (requestAssignmentId === selectedAssignmentIdRef.current) setNotice((error as Error).message); }
    finally { if (requestAssignmentId === selectedAssignmentIdRef.current) setSubmitting(false); }
  };

  const deleteAssignment = async () => {
    if (!assignmentToDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await apiFetch(`/api/rubrics/assignments/${assignmentToDelete.id}`, { method: "DELETE" });
      if (!response.ok) throw await apiErrorFromResponse(response, "删除评分会话失败");
      const deletedSelectedAssignment = assignmentToDelete.id === selectedAssignmentIdRef.current;
      setAssignmentToDelete(undefined);
      if (deletedSelectedAssignment) {
        navigateWithinApp(withCourseQuery("/rubrics", courseIdRef.current || readCourseFromUrl()));
        return;
      }
      await refreshAssignments();
      setNotice("评分会话及其参考资料、聊天记录、草稿和全部冻结正式版本已删除。");
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const selectedFrozen = typeof previewVersion === "number" ? versions.find((version) => version.version === previewVersion) : undefined;
  const previewRubric = previewVersion === "draft" ? draft?.rubric : selectedFrozen?.rubric;
  const frozenWithoutDraft = !draft && versions.length > 0;
  const workspaceStyle = { "--rubric-preview-width": `${previewPercent}%` } as CSSProperties;

  const currentCourse = courses.find((course) => course.id === courseId);
  const titleReady = Boolean(title.trim());
  const scoreReady = Number(totalScore) > 0;
  const reqReady = Boolean(requirements.trim());
  const sourceReady = Boolean(source.trim());
  const requirementOrSourceReady = reqReady || sourceReady;
  const chatContent = assignment && selectedMode ? <section className="rubric-chat">
    <div className="rubric-chat-heading"><div><h2>{assignment.title}</h2><p>{assignment.totalScore} 分 · {modeLabel[selectedMode]}</p></div></div>
    <details className="rubric-context"><summary>作业要求与参考资料</summary>{assignment.requirements ? <p>{assignment.requirements}</p> : <p>未单独填写作业要求，将以参考资料为设计依据。</p>}{assignment.sources.length > 0 && <ul>{assignment.sources.map((item) => <li key={item.id}>{item.role === "rubric_draft" ? "评分草稿" : "设计备注"}：{item.name}</li>)}</ul>}</details>
    <div className="rubric-message-list" ref={messageListRef} aria-live="polite" onScroll={(event) => { const list = event.currentTarget; followStreamRef.current = shouldFollowRubricStream(list.scrollHeight - list.scrollTop - list.clientHeight); }}>{messages.length === 0 ? <div className="rubric-chat-welcome"><h3>{frozenWithoutDraft ? "当前评分表已冻结" : "继续设计评分表"}</h3><p>{frozenWithoutDraft ? "如需继续修改评分标准，请先基于当前冻结版本创建修订草稿。" : "可以直接生成第一版，也可以先补充希望采用的评分维度。"}</p>{!frozenWithoutDraft && <button className="primary-button" type="button" disabled={submitting} onClick={() => void chooseMode(selectedMode)}>直接生成第一版评分表</button>}</div> : messages.map((message, index) => { const isActionableQuestion = Boolean(message.options?.length) && index === messages.length - 1 && !submitting && !frozenWithoutDraft; return <article className={`rubric-chat-message ${message.role}`} key={message.id}>{message.role === "assistant" && <><ToolActivity steps={message.tools ?? []} streaming={streamingMessageId === message.id} title="处理步骤" streamingTitle="正在设计评分表" />{streamingMessageId === message.id && message.process && <details className="assistant-process" open><summary>处理过程</summary><p>{message.process}</p></details>}</>}<div className="rubric-message-content">{message.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown> : <p>{message.content}</p>}</div>{message.options && message.options.length > 0 && (isActionableQuestion ? <div className="rubric-question-options">{message.options.map((option) => <button type="button" key={option} onClick={() => setChatInput(option)}>{option}</button>)}</div> : <div className="rubric-question-history"><small>历史提问选项</small><ul>{message.options.map((option) => <li key={option}>{option}</li>)}</ul></div>)}</article>; })}</div>
    {frozenWithoutDraft && versions[0] ? <div className="rubric-frozen-bar" role="status"><div><strong>当前评分表已定稿（v{versions[0].version}）</strong><p>可直接前往批改作业，或基于当前版本创建修订草稿。</p></div><div className="rubric-frozen-actions"><a className="primary-button" href={withCourseQuery(`/grading?rubric=${encodeURIComponent(`${selectedAssignmentId}:${versions[0].version}`)}`, courseId)}>前往单份批改</a><a className="secondary-link-button" href={withCourseQuery(`/grading/batches?rubric=${encodeURIComponent(`${selectedAssignmentId}:${versions[0].version}`)}`, courseId)}>前往批量批改</a><button type="button" disabled={submitting} onClick={() => void createRevision(versions[0]!.version)}>基于 v{versions[0].version} 创建修订</button></div></div> : <form className="rubric-composer" onSubmit={(event) => void sendMessage(event)}><textarea value={chatInput} disabled={submitting || frozenWithoutDraft} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); if (!submitting && !frozenWithoutDraft && chatInput.trim()) event.currentTarget.form?.requestSubmit(); }} placeholder="告诉 Agent 需要调整的评分项目、分值、等级或扣分规则…（Ctrl+Enter 发送）" /><button className="primary-button" disabled={submitting || frozenWithoutDraft || !chatInput.trim()} type="submit">发送</button></form>}
  </section> : assignment ? <section className="rubric-mode-gate"><div className="rubric-session-heading"><div><p className="eyebrow">第 2 步 · 选择评分方式</p><h2>{assignment.title}</h2><p>{assignment.totalScore} 分 · {assignment.sources.length} 份参考资料</p></div><a href={withCourseQuery("/rubrics", courseId)}>新建评分表</a></div><details className="rubric-context"><summary>查看作业要求与参考资料</summary>{assignment.requirements ? <p>{assignment.requirements}</p> : <p>未单独填写作业要求，将以参考资料为设计依据。</p>}{assignment.sources.length > 0 && <ul>{assignment.sources.map((item) => <li key={item.id}>{item.name}</li>)}</ul>}</details><h3>先选择评分制度</h3><p>选择后会直接调用 Agent 生成第一版草稿，无需填写额外备注。</p><div className="rubric-mode-grid">{recommendations.length === 0 ? <p>正在生成评分制度建议…</p> : recommendations.map((item) => <article key={item.mode} className={item.recommended ? "recommended" : ""}><div><strong>{modeLabel[item.mode]}{item.recommended ? "（推荐）" : ""}</strong><p>{item.reason ?? item.benefit ?? "适用于当前评分场景。"}</p></div><button type="button" className={item.recommended ? "primary-button" : ""} disabled={submitting} onClick={() => void chooseMode(item.mode)}>选择并开始</button></article>)}</div></section> : <section className="rubric-create-panel"><div className="rubric-step-strip" aria-label="设计步骤"><span className="active"><b>1</b> 填写作业信息</span><span className="step-sep" aria-hidden="true">→</span><span><b>2</b> AI 生成评分草稿</span><span className="step-sep" aria-hidden="true">→</span><span><b>3</b> 调整并定稿</span></div><div className="rubric-create-heading"><h2>新建评分标准</h2><p>{currentCourse ? `当前课程「${currentCourse.name}」：填写名称、满分，并补充作业要求或参考资料（至少一项）。` : "请先在课程总览创建或选择课程。"}</p></div>{!courseId ? <a className="primary-button" href="/">前往课程总览创建课程</a> : <form onSubmit={(event) => void createAssignment(event)} className="rubric-create-form"><div className="rubric-create-top-row"><label className={`rubric-guided-field ${titleReady ? "is-ready" : "is-missing"}`}><span>评分标准名称 <em>{titleReady ? "已就绪" : "必填"}</em></span><input required value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：第 3 章栈与队列作业评分标准" /></label><label className={`rubric-guided-field ${scoreReady ? "is-ready" : "is-missing"}`}><span>满分 <em>{scoreReady ? "已就绪" : "必填"}</em></span><input required type="number" min="0.01" step="0.01" value={totalScore} onChange={(event) => setTotalScore(event.target.value)} /></label></div><div className="rubric-create-content-grid"><label className={`rubric-guided-field rubric-panel-field ${reqReady ? "is-ready" : requirementOrSourceReady ? "is-optional" : "is-missing"}`}><span>作业要求 <em>{reqReady ? "已就绪" : requirementOrSourceReady ? "可选补充" : "与右侧至少填一项"}</em></span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="说明作业考察重点、提交格式、字数或代码规范要求；若右侧参考资料已包含，可留空。" /></label><fieldset className={`rubric-source-fieldset rubric-guided-field ${sourceReady ? "is-ready" : "is-optional"}`}><div className="rubric-source-header"><span>参考资料</span><em>{sourceReady ? "已就绪" : "可选补充"}</em></div><div className="rubric-source-file-row"><label className="rubric-file-button">导入文件<input className="visually-hidden" type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown" onChange={(event) => void readSourceFile(event.target.files?.[0])} /></label><span title={sourceName || undefined}>{sourceName || "支持 .txt / .md / .csv / .json"}</span>{source.trim() && <select className="rubric-source-role-select" aria-label="资料类型" value={sourceRole} onChange={(event) => setSourceRole(event.target.value as "rubric_draft" | "note")}><option value="rubric_draft">评分标准草稿</option><option value="note">设计备注</option></select>}</div><textarea value={source} onChange={(event) => { setSource(event.target.value); if (!event.target.value) setSourceName(""); }} placeholder="直接粘贴现有评分标准草稿或设计说明…" /></fieldset></div><div className="rubric-form-actions">{(!titleReady || !scoreReady || !requirementOrSourceReady) && <small className="inline-requirement-hint">完成红框必填项即可进入下一步</small>}<button className="primary-button" type="submit" disabled={submitting || !courseId || !titleReady || !scoreReady || !requirementOrSourceReady}>下一步：选择评分方式</button></div></form>}</section>;

  const previewPanel = <aside className={`rubric-preview-panel ${previewFullscreen ? "fullscreen" : ""}`} aria-label="评分表预览"><div className="rubric-preview-toolbar"><div><h2>评分表预览</h2><span title={selectedFrozen ? "只有冻结版本才允许被正式应用于批改" : undefined}>{previewVersion === "draft" && draft ? `可编辑草稿 v${draft.version}` : selectedFrozen ? `冻结版本 v${selectedFrozen.version}` : "尚无草稿"}</span></div><div>{(draft || versions.length > 0) && <select aria-label="选择预览版本" value={previewVersion} onChange={(event) => { const value = event.target.value; setPreviewVersion(value === "draft" ? "draft" : Number(value)); setEditing(false); setValidation(undefined); }}><option value="draft" disabled={!draft}>当前草稿{draft ? ` v${draft.version}` : "（无）"}</option>{versions.map((version) => <option value={version.version} key={version.version}>冻结版本 v{version.version}</option>)}</select>}{draft && previewVersion === "draft" && <button type="button" onClick={() => { setEditing((value) => !value); setEditedRubric(structuredClone(draft.rubric)); }}>{editing ? "查看预览" : "人工编辑"}</button>}<button type="button" onClick={() => setPreviewFullscreen((value) => !value)}>{previewFullscreen ? "退出全屏" : "全屏预览"}</button></div></div><div className="rubric-preview-body">{previewRubric ? editing && draft && previewVersion === "draft" && editedRubric ? <RubricEditor rubric={editedRubric} onChange={setEditedRubric} /> : <RubricDocument rubric={previewRubric} /> : <div className="rubric-preview-empty"><strong>{assignment ? "等待评分表草稿" : "尚未开始设计"}</strong><p>{assignment ? "选择评分制度后，Agent 生成的草稿会显示在这里。" : "创建会话后，可在这里预览、编辑和冻结评分表。"}</p></div>}</div>{draft && previewVersion === "draft" && <footer className="rubric-preview-actions">{editing ? <><button type="button" onClick={() => { setEditing(false); setEditedRubric(structuredClone(draft.rubric)); }}>取消修改</button><button className="primary-button" type="button" disabled={submitting} onClick={() => void saveManualDraft()}>保存人工修改</button></> : <><button type="button" disabled={submitting} onClick={() => void validateForFreeze()}>校验并准备冻结</button>{freezeReady && <button className="primary-button" type="button" disabled={submitting} onClick={() => void freezeDraft()}>确认冻结为正式版本</button>}</>}{validation && <div className={`rubric-validation ${validation.errors.length ? "error" : "success"}`}><strong>{validation.errors.length ? `${validation.errors.length} 个错误` : "校验通过"}</strong>{[...validation.errors, ...validation.warnings].map((problem, index) => <p key={`${problem.code}-${index}`}>{rubricProblemMessage(problem)}</p>)}</div>}</footer>}{selectedFrozen && <footer className="rubric-preview-actions frozen-footer"><button className="primary-button" type="button" disabled={submitting || Boolean(draft)} onClick={() => void createRevision(selectedFrozen.version)}>基于 v{selectedFrozen.version} 创建修订</button><div className="rubric-export-links"><a href={`/api/rubrics/assignments/${selectedAssignmentId}/versions/${selectedFrozen.version}/export.md`} download>导出 Markdown</a><a href={`/api/rubrics/assignments/${selectedAssignmentId}/versions/${selectedFrozen.version}/export.json`} download>导出 JSON</a></div></footer>}</aside>;

  return <div className="rubric-page">
    <header className="rubric-page-header">
      <div className="rubric-header-title"><h1>评分量表设计</h1><span className="rubric-header-notice">{notice}</span></div>
      {sidebarCollapsed && <button className="rubric-session-toggle" type="button" onClick={() => setSidebarCollapsed(false)} aria-controls="rubric-session-list" aria-expanded={false}>展开会话</button>}
    </header>
    <section className={`rubric-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={workspaceStyle}>
      <aside id="rubric-session-list" className="rubric-session-list" aria-label="评分会话列表" inert={sidebarCollapsed} onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]") && window.matchMedia(narrowRubricWorkspace).matches) setSidebarCollapsed(true);
      }}>
        <div className="rubric-pane-heading"><div><h2>评分会话</h2><span>{assignments.length}</span></div><button className="rubric-pane-collapse" type="button" onClick={() => setSidebarCollapsed(true)} aria-label="收起评分会话列表" title="收起会话列表">«</button></div>
        <a className="rubric-new-session" href={withCourseQuery("/rubrics", courseId)}>＋ 新建评分表</a>
        {assignments.length > 0 && <input type="search" className="grading-session-search" aria-label="搜索评分会话" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索评分标准名称…" />}
        {assignments.length === 0 ? <p className="rubric-empty">当前课程尚未创建评分会话。</p> : (() => { const q = sessionQuery.trim().toLowerCase(); const filtered = assignments.filter((item) => !q || item.title.toLowerCase().includes(q)); return filtered.length === 0 ? <div className="sidebar-empty-hint"><p className="muted">没有匹配的评分会话</p><button type="button" className="sidebar-clear-filter" onClick={() => setSessionQuery("")}>清除搜索</button></div> : <nav>{filtered.map((item) => <div className={`rubric-session-row ${item.id === selectedAssignmentId ? "active" : ""}`} key={item.id}><a href={withCourseQuery(`/rubrics?assignment=${encodeURIComponent(item.id)}`, courseId)} title={item.title}><strong>{item.title}</strong><small>{item.totalScore} 分 · {item.sources.length} 份参考资料</small></a><button type="button" aria-label={`删除评分会话：${item.title}`} title="删除评分会话" disabled={submitting || deleting} onClick={() => { setAssignmentToDelete(item); setDeleteError(""); }}>删除</button></div>)}</nav>; })()}
      </aside>
      <section className={`rubric-design-split ${!assignment ? "is-creating" : ""}`} ref={splitRef}>
        <section className="rubric-start-panel">{chatContent}</section>
        {assignment && <button className={`rubric-resizer ${dragging ? "dragging" : ""}`} type="button" aria-label="拖动调整会话与预览宽度" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }} />}
        {assignment && previewPanel}
      </section>
    </section>
    <ConfirmDialog
      open={Boolean(assignmentToDelete)}
      title="删除评分会话？"
      description={assignmentToDelete ? rubricDeleteWarning(assignmentToDelete.title) : ""}
      confirmLabel={deleting ? "正在删除…" : "永久删除"}
      tone="danger"
      busy={deleting}
      error={deleteError}
      onConfirm={() => void deleteAssignment()}
      onCancel={() => { setAssignmentToDelete(undefined); setDeleteError(""); }}
    />
  </div>;
}
