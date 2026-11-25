import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatComposer } from "../components/ChatComposer";
import { ChatSidebar, type QaCourse, type QaSessionSummary } from "../components/ChatSidebar";
import { ConfirmDialog, PromptDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { ToolActivity, type ToolStep } from "../components/ToolActivity";
import { ApiError, apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";
import { COURSE_CHANGED_EVENT, readCourseFromUrl, resolveActiveCourseId } from "../lib/course-context";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import { consumeSse } from "../lib/consume-sse";
import { appendProcessText, shouldOpenProcess } from "../lib/qa-presentation";
import { courseQaComposerState, type KnowledgeStatus } from "./course-qa-page-model";

type Citation = { type: "knowledge"; path: string; startLine: number; endLine: number } | { type: "web"; sourceId: string; title: string; url: string; startLine: number; endLine: number };
type QaMessage = { id: string; role: "user" | "assistant"; content: string; citations?: Citation[]; insufficient?: boolean; steps?: ToolStep[]; process?: string };
type Session = { id: string; releaseId: string; answerInProgress?: boolean; messages: Array<{ role: "user" | "assistant"; content: string; citations?: Citation[]; insufficient?: boolean }> };
type ActiveKnowledge = { releaseId: string; documents: Array<{ path: string; title: string }> };
type StreamEvent = { code?: string; type: string; id?: string; name?: string; label?: string; summary?: string; status?: "completed" | "failed"; delta?: string; answer?: string; citations?: Citation[]; insufficient?: boolean; message?: string };
type QaRequest = { courseId: string; sessionId: string; controller: AbortController; runId?: string | null; stopRequested: boolean; terminal?: "final" | "error" | "cancelled" };
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function CourseQaPage() {
  const toast = useToast();
  const query = new URLSearchParams(location.search);
  const [courses, setCourses] = useState<QaCourse[]>([]);
  const [courseId, setCourseId] = useState(query.get("course") ?? "");
  const [active, setActive] = useState<ActiveKnowledge>();
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus>(courseId ? "loading" : "idle");
  const [sessions, setSessions] = useState<QaSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(query.get("session") ?? "");
  const [sessionTurnStatus, setSessionTurnStatus] = useState<"loading" | "pending" | "idle">(sessionId ? "loading" : "idle");
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [input, setInput] = useState("");
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [notice, setNotice] = useState("正在加载课程…");
  const [runNotice, setRunNotice] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [source, setSource] = useState<{ citation: Citation; content: string }>();
  const [sessionToRename, setSessionToRename] = useState<QaSessionSummary>();
  const [renameTitle, setRenameTitle] = useState("");
  const [sessionToDelete, setSessionToDelete] = useState<QaSessionSummary>();
  const [sessionActionError, setSessionActionError] = useState("");
  const currentRequest = useRef<QaRequest | undefined>(undefined);
  const inputRevision = useRef(0);
  const courseGate = useRef(new LatestRequestGate());
  const sessionGate = useRef(new LatestRequestGate());
  const sourceGate = useRef(new LatestRequestGate());
  const streamGate = useRef(new LatestRequestGate());
  const courseIdRef = useRef(courseId);
  const sessionIdRef = useRef(sessionId);
  const messageListRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  courseIdRef.current = courseId;
  sessionIdRef.current = sessionId;
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const streaming = Boolean(streamingMessageId);
  const currentCourse = courses.find((course) => course.id === courseId);

  useEffect(() => {
    const el = messageListRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [messages, streaming]);

  const refreshCourse = async (id: string) => {
    const lease = courseGate.current.begin();
    if (!id) {
      if (lease.isCurrent()) {
        setActive(undefined);
        setSessions([]);
        setKnowledgeStatus("idle");
      }
      return undefined;
    }
    setKnowledgeStatus("loading");
    const [activeResult, sessionsResult] = await Promise.allSettled([
      api<ActiveKnowledge>(`/api/courses/${id}/qa/active`),
      api<QaSessionSummary[]>(`/api/courses/${id}/qa/sessions`),
    ]);
    if (!lease.isCurrent() || id !== courseIdRef.current) return undefined;
    const nextSessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
    setSessions(nextSessions);
    if (activeResult.status === "rejected") {
      setActive(undefined);
      throw activeResult.reason;
    }
    const nextActive = activeResult.value;
    setActive(nextActive);
    setKnowledgeStatus("ready");
    setNotice(allowWebSearch ? "课程资料优先；可使用网络补充当前信息" : "仅依据已发布课程资料回答");
    return { nextActive, nextSessions };
  };

  useEffect(() => { Promise.all([api<QaCourse[]>("/api/courses"), api<{ configured: boolean }>("/api/system/model")]).then(([nextCourses, model]) => { setCourses(nextCourses); setModelReady(model.configured); const selected = resolveActiveCourseId(nextCourses, courseIdRef.current || readCourseFromUrl()); if (selected && selected !== courseIdRef.current) navigateWithinApp(`/qa?course=${encodeURIComponent(selected)}`, true); }).catch((error: Error) => setNotice(error.message)); }, []);
  useEffect(() => {
    const syncLocation = () => {
      const nextQuery = new URLSearchParams(window.location.search);
      const nextCourseId = nextQuery.get("course") ?? "";
      const nextSessionId = nextQuery.get("session") ?? "";
      if (nextCourseId === courseIdRef.current && nextSessionId === sessionIdRef.current) {
        setSidebarOpen(false);
        return;
      }
      const request = currentRequest.current;
      const openingCreatedSession = request && !sessionIdRef.current && nextSessionId &&
        request.courseId === nextCourseId && request.sessionId === nextSessionId;
      if (!openingCreatedSession) {
        currentRequest.current?.controller.abort();
        currentRequest.current = undefined;
        streamGate.current.invalidate();
        setStreamingMessageId(undefined);
        setRunNotice(undefined);
      }
      sourceGate.current.invalidate();
      sessionGate.current.invalidate();
      courseIdRef.current = nextCourseId;
      sessionIdRef.current = nextSessionId;
      setCourseId(nextCourseId);
      setSessionId(nextSessionId);
      setSessionTurnStatus(nextCourseId && nextSessionId ? "loading" : "idle");
      setMessages([]);
      setSource(undefined);
      setSidebarOpen(false);
    };
    window.addEventListener("popstate", syncLocation);
    window.addEventListener(COURSE_CHANGED_EVENT, syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener(COURSE_CHANGED_EVENT, syncLocation);
      currentRequest.current?.controller.abort();
      currentRequest.current = undefined;
      streamGate.current.invalidate();
    };
  }, []);
  useEffect(() => { refreshCourse(courseId).catch((error: Error) => {
    if (courseId !== courseIdRef.current) return;
    setActive(undefined);
    if (error instanceof ApiError && error.code === "ACTIVE_RELEASE_NOT_FOUND") {
      setKnowledgeStatus("missing");
      setNotice("当前课程尚未发布资料，请先到课程资料库发布后再开始答疑");
    } else {
      setKnowledgeStatus("error");
      setNotice(error.message);
    }
  }); }, [courseId]);
  useEffect(() => {
    const lease = sessionGate.current.begin();
    if (!courseId || !sessionId) {
      if (lease.isCurrent()) setMessages([]);
      return;
    }
    if (streaming) return;
    const ownsSession = () => lease.isCurrent() && courseId === courseIdRef.current && sessionId === sessionIdRef.current;
    let stopPolling: (() => void) | undefined;
    const leaveMissingSession = (error: unknown) => {
      if (!ownsSession() || !(error instanceof ApiError) || error.code !== "SESSION_NOT_FOUND") return false;
      stopPolling?.();
      setSessions((items) => items.filter((item) => item.id !== sessionId));
      navigateWithinApp(`/qa?course=${encodeURIComponent(courseId)}`, true);
      setNotice("该答疑会话已不存在。可以开始新的对话。");
      return true;
    };
    const readSession = async () => {
      const session = await api<Session>(`/api/courses/${courseId}/qa/sessions/${sessionId}`);
      if (!ownsSession()) return;
      setMessages(session.messages.map((message, index) => ({ ...message, id: `${session.id}-${index}` })));
      setSessionTurnStatus(session.answerInProgress ? "pending" : "idle");
      if (session.answerInProgress) {
        stopPolling ??= startSerialPolling(readSession, {
          intervalMs: 1_000,
          onError: leaveMissingSession,
        });
      } else {
        stopPolling?.();
      }
    };
    void readSession().catch((error: Error) => {
      if (!ownsSession() || leaveMissingSession(error)) return;
      setSessionTurnStatus("idle");
      setNotice(error.message);
    });
    return () => {
      stopPolling?.();
      if (lease.isCurrent()) sessionGate.current.invalidate();
    };
  }, [courseId, sessionId, streaming]);

  const examples = useMemo(() => active?.documents.slice(0, 3).map((document) => `请解释“${document.title}”中的核心概念`) ?? [], [active]);
  const beginNewChat = () => {
    navigateWithinApp(courseId ? `/qa?course=${encodeURIComponent(courseId)}` : "/qa");
    setNotice(active ? "可以开始新的课程答疑" : "请先选择已发布课程");
  };
  const selectCourse = (id: string) => {
    navigateWithinApp(id ? `/qa?course=${encodeURIComponent(id)}` : "/qa");
  };
  const renameSession = async () => {
    if (!courseId || !sessionToRename) return;
    const title = renameTitle.trim();
    if (!title) { setSessionActionError("请输入会话名称"); return; }
    try {
      await api(`/api/courses/${courseId}/qa/sessions/${sessionToRename.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      await refreshCourse(courseId);
      setSessionToRename(undefined);
      setSessionActionError("");
    } catch (error) { setSessionActionError((error as Error).message); }
  };
  const deleteSession = async () => {
    if (!courseId || !sessionToDelete) return;
    try {
      const response = await apiFetch(`/api/courses/${courseId}/qa/sessions/${sessionToDelete.id}`, { method: "DELETE" });
      if (!response.ok) throw await apiErrorFromResponse(response, "删除会话失败");
      if (sessionId === sessionToDelete.id) {
        navigateWithinApp(`/qa?course=${encodeURIComponent(courseId)}`, true);
      }
      await refreshCourse(courseId);
      setSessionToDelete(undefined);
      setSessionActionError("");
    } catch (error) { setSessionActionError((error as Error).message); }
  };
  const editInput = (value: string) => {
    inputRevision.current += 1;
    setInput(value);
  };
  const ownsRequest = (request: QaRequest) => currentRequest.current === request &&
    request.courseId === courseIdRef.current && request.sessionId === sessionIdRef.current;
  const cancelRequest = async (request: QaRequest) => {
    if (!ownsRequest(request) || request.terminal || request.runId === undefined) return;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5_000);
    try {
      if (!request.runId) throw new Error("暂时无法停止本轮生成，请等待结果。");
      const response = await apiFetch(`/api/agent-runs/${encodeURIComponent(request.runId)}/cancel`, { method: "POST", signal: timeout.signal });
      if (response.status === 404) {
        if (ownsRequest(request) && !request.terminal) setRunNotice("本轮已无法取消，请等待结果。");
        return;
      }
      if (!response.ok) throw await apiErrorFromResponse(response, "停止生成失败");
      const result = await response.json() as { cancelled: boolean };
      if (!result.cancelled) throw new Error("未能停止本轮生成，请重试。");
    } catch (error) {
      if (!ownsRequest(request) || request.terminal) return;
      request.stopRequested = false;
      const failure = timeout.signal.aborted ? new Error("停止请求超时，可再次点击“停止生成”。") : error;
      setRunNotice((failure as Error).message);
      toast.fromError(failure);
    } finally {
      clearTimeout(timer);
    }
  };
  const send = async () => {
    const submittedInput = input;
    const question = submittedInput.trim();
    if (!question || !courseId || !active || !modelReady || sessionTurnStatus !== "idle" || currentRequest.current) return;
    const request: QaRequest = { courseId, sessionId, controller: new AbortController(), stopRequested: false };
    const submittedInputRevision = inputRevision.current;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    currentRequest.current = request;
    sessionGate.current.invalidate();
    setInput("");
    setRunNotice(undefined);
    let streamFailure: string | undefined;
    setStreamingMessageId(assistantId);
    const preserveUnsubmittedQuestion = (message: string) => {
      setMessages((items) => items.filter((item) => item.id !== userId && item.id !== assistantId));
      if (inputRevision.current === submittedInputRevision) setInput(submittedInput);
      setRunNotice(message);
    };
    const stoppedNotice = "已停止，未保存本轮回答。可修改问题后重新发送。";
    try {
      if (!request.sessionId) {
        const created = await api<{ id: string }>(`/api/courses/${request.courseId}/qa/sessions`, { method: "POST", signal: request.controller.signal });
        if (!ownsRequest(request)) return;
        request.sessionId = created.id;
        navigateWithinApp(`/qa?course=${encodeURIComponent(request.courseId)}&session=${encodeURIComponent(request.sessionId)}`, true);
        if (request.stopRequested) {
          preserveUnsubmittedQuestion(stoppedNotice);
          return;
        }
      }
      const lease = streamGate.current.begin();
      setMessages((items) => [...items, { id: userId, role: "user", content: question }, { id: assistantId, role: "assistant", content: "", steps: [] }]);
      const response = await apiFetch(`/api/courses/${request.courseId}/qa/sessions/${request.sessionId}/messages/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, allowWebSearch }), signal: request.controller.signal });
      if (!ownsRequest(request)) return;
      if (!response.ok) throw await apiErrorFromResponse(response, "答疑请求失败");
      request.runId = response.headers.get("x-agent-run-id");
      if (request.stopRequested) void cancelRequest(request);
      const result = await consumeSse(response, (_event, raw) => {
        if (!lease.isCurrent() || !ownsRequest(request)) return;
        const event = raw as StreamEvent;
        if (event.type === "final" || event.type === "error" || event.type === "cancelled") request.terminal = event.type;
        if (event.type === "final") {
          setRunNotice(undefined);
        }
        if (event.type === "error") streamFailure = userErrorMessage(event.code ?? "QA_FAILED");
        setMessages((items) => items.map((message) => {
          if (message.id !== assistantId) return message;
          if (event.type === "tool_start" && event.id && event.label && event.summary) return { ...message, steps: [...(message.steps ?? []), { id: event.id, label: event.label, summary: event.summary, status: "running" }] };
          if (event.type === "tool_end" && event.id) return { ...message, steps: (message.steps ?? []).map((step) => step.id === event.id ? { ...step, status: event.status === "failed" ? "failed" : "completed" } : step) };
          if (event.type === "answer_delta" && event.delta) return { ...message, process: appendProcessText(message.process, event.delta) };
          if (event.type === "final") return { ...message, content: event.answer ?? message.content, citations: event.citations, insufficient: event.insufficient };
          if (event.type === "error") return { ...message, content: streamFailure ?? "答疑未能完成" };
          return message;
        }));
      });
      if (!ownsRequest(request)) return;
      if (!result.terminalEvent) throw new Error("答疑连接已中断，请重试");
      if (result.terminalEvent === "cancelled") {
        preserveUnsubmittedQuestion(stoppedNotice);
        return;
      }
      if (streamFailure) throw new Error(streamFailure);
      const nextSessions = await api<QaSessionSummary[]>(`/api/courses/${request.courseId}/qa/sessions`);
      if (lease.isCurrent() && ownsRequest(request)) setSessions(nextSessions);
    } catch (error) {
      if (ownsRequest(request) && request.terminal !== "final") {
        preserveUnsubmittedQuestion((error as Error).message);
        toast.fromError(error);
      }
    } finally {
      if (ownsRequest(request)) {
        currentRequest.current = undefined;
        if (request.sessionId) setSessionTurnStatus("loading");
        setStreamingMessageId(undefined);
      }
    }
  };
  const stopCurrentRun = () => {
    const request = currentRequest.current;
    if (!request || request.stopRequested || request.terminal) return;
    request.stopRequested = true;
    setRunNotice("正在停止生成…");
    void cancelRequest(request);
  };
  const openCitation = async (citation: Citation) => {
    if (citation.type === "web") { window.open(citation.url, "_blank", "noopener,noreferrer"); return; }
    if (!courseId) return;
    const requestCourseId = courseId;
    const lease = sourceGate.current.begin();
    try {
      const result = await api<{ content: string }>(`/api/courses/${requestCourseId}/qa/active/content?path=${encodeURIComponent(citation.path)}&startLine=${citation.startLine}&endLine=${citation.endLine}`);
      if (lease.isCurrent() && requestCourseId === courseIdRef.current) setSource({ citation, content: result.content });
    } catch (error) {
      if (lease.isCurrent()) setNotice((error as Error).message);
    }
  };

  const isCurrentAssistantMessage = (message: QaMessage) => streaming && message.id === streamingMessageId;
  const composerState = courseQaComposerState({ courseId, knowledgeStatus, modelReady });
  const waitingNotice = "后台仍在生成回答，完成后会自动显示。";
  const composerPlaceholder = composerState.disabled ? composerState.placeholder :
    sessionTurnStatus === "pending" ? waitingNotice :
    sessionTurnStatus === "loading" ? "正在加载当前会话…" : composerState.placeholder;

  return <div className="qa-shell">
    <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="打开会话侧栏">☰</button>
    <ChatSidebar courses={courses} courseId={courseId} sessions={sessions} activeSessionId={sessionId || undefined} onCourseChange={selectCourse} onNewChat={beginNewChat} onRename={(session) => { setSessionToRename(session); setRenameTitle(session.summary); setSessionActionError(""); }} onDelete={(session) => { setSessionToDelete(session); setSessionActionError(""); }} open={sidebarOpen} onClose={() => setSidebarOpen(false)} hideCourseSelect />
    <main className="qa-main">
      <header className="qa-header"><span>{currentCourse?.name ?? "课程答疑"}</span><small role="status">{runNotice ?? (sessionTurnStatus === "pending" ? waitingNotice : notice)}</small></header>
      <section
        ref={messageListRef}
        className="message-list"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
        }}
      >
        {messages.length === 0 ? <div className="qa-welcome"><h1>{currentCourse ? `你好，准备学习 ${currentCourse.name}` : "选择一门课程开始答疑"}</h1><p>{knowledgeStatus === "missing" || knowledgeStatus === "error" ? notice : "我会优先依据当前已发布的课程资料作答，并附上可核查的引用。"}</p>{courseId && (knowledgeStatus === "missing" || knowledgeStatus === "error") && <a className="primary-button qa-recovery-link" href={`/knowledge?course=${encodeURIComponent(courseId)}`}>前往整理课程资料</a>}{examples.map((example) => <button key={example} onClick={() => editInput(example)}>{example}</button>)}</div> : messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>{message.role === "assistant" && <><ToolActivity steps={message.steps ?? []} streaming={isCurrentAssistantMessage(message)} />{message.process && <details className="assistant-process" open={shouldOpenProcess(isCurrentAssistantMessage(message))}><summary>模型处理过程 <small>非最终回答</small></summary><p>{message.process}</p></details>}</>}{message.content && (message.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown> : <p>{message.content}</p>)}{message.insufficient && <p className="insufficient">资料不足：当前可用资料无法支持这个问题。</p>}{message.citations?.map((citation) => <button className="citation" key={citation.type === "knowledge" ? `${citation.path}-${citation.startLine}` : `${citation.sourceId}-${citation.startLine}`} onClick={() => void openCitation(citation)}>{citation.type === "knowledge" ? `${citation.path.split("/").at(-1)} · L${citation.startLine}–L${citation.endLine}` : `${citation.title || new URL(citation.url).hostname} · 网络来源`}</button>)}</article>)}</section>
      <ChatComposer value={input} onChange={editInput} onSend={() => void send()} onStop={stopCurrentRun} allowWebSearch={allowWebSearch} onAllowWebSearchChange={setAllowWebSearch} disabled={composerState.disabled || sessionTurnStatus !== "idle"} placeholder={composerPlaceholder} streaming={streaming} />
    </main>
    <PromptDialog
      open={Boolean(sessionToRename)}
      title="重命名会话"
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
      title="删除会话？"
      description={sessionToDelete ? `“${sessionToDelete.summary}”及其历史消息将从本机永久删除，无法恢复。` : ""}
      confirmLabel="永久删除"
      tone="danger"
      error={sessionActionError}
      onConfirm={() => void deleteSession()}
      onCancel={() => { setSessionToDelete(undefined); setSessionActionError(""); }}
    />
    {source?.citation.type === "knowledge" && <aside className="source-drawer"><button onClick={() => setSource(undefined)} aria-label="关闭原文">×</button><h2>{source.citation.path.split("/").at(-1)}</h2><p>L{source.citation.startLine}–L{source.citation.endLine}</p><pre>{source.content}</pre></aside>}
  </div>;
}
