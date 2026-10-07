import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatComposer } from "../components/ChatComposer";
import { ChatSidebar, type QaCourse, type QaSessionSummary } from "../components/ChatSidebar";
import { ToolActivity, type ToolStep } from "../components/ToolActivity";
import { ApiError, apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";
import { LatestRequestGate } from "../lib/async-state";
import { consumeSse } from "../lib/consume-sse";
import { appendProcessText, shouldOpenProcess } from "../lib/qa-presentation";
import { courseQaComposerState, type KnowledgeStatus } from "./course-qa-page-model";

type Citation = { type: "knowledge"; path: string; startLine: number; endLine: number } | { type: "web"; sourceId: string; title: string; url: string; startLine: number; endLine: number };
type QaMessage = { id: string; role: "user" | "assistant"; content: string; citations?: Citation[]; insufficient?: boolean; steps?: ToolStep[]; process?: string; stopped?: boolean };
type Session = { id: string; releaseId: string; messages: Array<{ role: "user" | "assistant"; content: string; citations?: Citation[]; insufficient?: boolean }> };
type ActiveKnowledge = { releaseId: string; documents: Array<{ path: string; title: string }> };
type StreamEvent = { code?: string; type: string; id?: string; name?: string; label?: string; summary?: string; status?: "completed" | "failed"; delta?: string; answer?: string; citations?: Citation[]; insufficient?: boolean; message?: string };
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function CourseQaPage() {
  const query = new URLSearchParams(location.search);
  const [courses, setCourses] = useState<QaCourse[]>([]);
  const [courseId, setCourseId] = useState(query.get("course") ?? "");
  const [active, setActive] = useState<ActiveKnowledge>();
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus>(courseId ? "loading" : "idle");
  const [sessions, setSessions] = useState<QaSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(query.get("session") ?? "");
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [input, setInput] = useState("");
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [notice, setNotice] = useState("正在加载课程…");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [source, setSource] = useState<{ citation: Citation; content: string }>();
  const [sessionToRename, setSessionToRename] = useState<QaSessionSummary>();
  const [renameTitle, setRenameTitle] = useState("");
  const [sessionToDelete, setSessionToDelete] = useState<QaSessionSummary>();
  const [sessionActionError, setSessionActionError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const agentRunId = useRef<string | undefined>(undefined);
  const courseGate = useRef(new LatestRequestGate());
  const sessionGate = useRef(new LatestRequestGate());
  const sourceGate = useRef(new LatestRequestGate());
  const streamGate = useRef(new LatestRequestGate());
  const courseIdRef = useRef(courseId);
  const sessionIdRef = useRef(sessionId);
  courseIdRef.current = courseId;
  sessionIdRef.current = sessionId;
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const streaming = Boolean(streamingMessageId);
  const currentCourse = courses.find((course) => course.id === courseId);

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
    const [nextActive, nextSessions] = await Promise.all([api<ActiveKnowledge>(`/api/courses/${id}/qa/active`), api<QaSessionSummary[]>(`/api/courses/${id}/qa/sessions`)]);
    if (!lease.isCurrent() || id !== courseIdRef.current) return undefined;
    setActive(nextActive); setSessions(nextSessions); setKnowledgeStatus("ready"); setNotice(allowWebSearch ? "课程资料优先；可使用网络补充当前信息" : "仅依据已发布课程资料回答");
    return { nextActive, nextSessions };
  };

  useEffect(() => { Promise.all([api<QaCourse[]>("/api/courses"), api<{ configured: boolean }>("/api/system/model")]).then(([nextCourses, model]) => { setCourses(nextCourses); setModelReady(model.configured); const first = courseIdRef.current || nextCourses[0]?.id || ""; if (first && !courseIdRef.current) navigateWithinApp(`/qa?course=${encodeURIComponent(first)}`, true); }).catch((error: Error) => setNotice(error.message)); }, []);
  useEffect(() => {
    const syncLocation = () => {
      const nextQuery = new URLSearchParams(window.location.search);
      const nextCourseId = nextQuery.get("course") ?? "";
      const nextSessionId = nextQuery.get("session") ?? "";
      controller.current?.abort();
      controller.current = undefined;
      agentRunId.current = undefined;
      streamGate.current.invalidate();
      sourceGate.current.invalidate();
      courseIdRef.current = nextCourseId;
      sessionIdRef.current = nextSessionId;
      setCourseId(nextCourseId);
      setSessionId(nextSessionId);
      setStreamingMessageId(undefined);
      setMessages([]);
      setSource(undefined);
      setSidebarOpen(false);
    };
    window.addEventListener("popstate", syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      controller.current?.abort();
      streamGate.current.invalidate();
    };
  }, []);
  useEffect(() => { refreshCourse(courseId).catch((error: Error) => {
    if (courseId !== courseIdRef.current) return;
    setActive(undefined);
    setSessions([]);
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
    void api<Session>(`/api/courses/${courseId}/qa/sessions/${sessionId}`)
      .then((session) => {
        if (!lease.isCurrent() || courseId !== courseIdRef.current || sessionId !== sessionIdRef.current) return;
        setMessages(session.messages.map((message, index) => ({ ...message, id: `${session.id}-${index}` })));
      })
      .catch((error: Error) => {
        if (lease.isCurrent()) setNotice(error.message);
      });
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
      if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "删除会话失败");
      if (sessionId === sessionToDelete.id) {
        navigateWithinApp(`/qa?course=${encodeURIComponent(courseId)}`, true);
      }
      await refreshCourse(courseId);
      setSessionToDelete(undefined);
      setSessionActionError("");
    } catch (error) { setSessionActionError((error as Error).message); }
  };
  const send = async () => {
    const question = input.trim();
    if (!question || !courseId || !active || !modelReady || controller.current) return;
    const requestCourseId = courseId;
    setInput("");
    let nextSessionId = sessionId;
    const assistantId = crypto.randomUUID();
    let receivedFinal = false;
    let streamFailure: string | undefined;
    setStreamingMessageId(assistantId);
    try {
      if (!nextSessionId) {
        nextSessionId = (await api<{ id: string }>(`/api/courses/${requestCourseId}/qa/sessions`, { method: "POST" })).id;
        if (courseIdRef.current !== requestCourseId) return;
        navigateWithinApp(`/qa?course=${encodeURIComponent(requestCourseId)}&session=${encodeURIComponent(nextSessionId)}`, true);
      }
      const requestSessionId = nextSessionId;
      const lease = streamGate.current.begin();
      setStreamingMessageId(assistantId);
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", content: question }, { id: assistantId, role: "assistant", content: "", steps: [] }]);
      const aborter = new AbortController();
      controller.current = aborter;
      const response = await apiFetch(`/api/courses/${requestCourseId}/qa/sessions/${requestSessionId}/messages/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, allowWebSearch }), signal: aborter.signal });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "答疑请求失败");
      agentRunId.current = response.headers.get("x-agent-run-id") ?? undefined;
      const result = await consumeSse(response, (_event, raw) => {
        if (!lease.isCurrent() || requestCourseId !== courseIdRef.current || requestSessionId !== sessionIdRef.current) return;
        const event = raw as StreamEvent;
        if (event.type === "final") receivedFinal = true;
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
      if (!result.terminalEvent) throw new Error("答疑连接已中断，请重试");
      if (streamFailure) throw new Error(streamFailure);
      const nextSessions = await api<QaSessionSummary[]>(`/api/courses/${requestCourseId}/qa/sessions`);
      if (lease.isCurrent() && requestCourseId === courseIdRef.current) setSessions(nextSessions);
    } catch (error) {
      if (requestCourseId === courseIdRef.current && nextSessionId === sessionIdRef.current) {
        setMessages((items) => items.map((message) => message.id === assistantId ? { ...message, stopped: error instanceof DOMException && error.name === "AbortError" } : message));
        if (!(error instanceof DOMException && error.name === "AbortError") && !receivedFinal) setNotice((error as Error).message);
      }
    } finally {
      if (requestCourseId === courseIdRef.current && nextSessionId === sessionIdRef.current) {
        controller.current = undefined;
        agentRunId.current = undefined;
        setStreamingMessageId(undefined);
      }
    }
  };
  const stopCurrentRun = async () => {
    const runId = agentRunId.current;
    try {
      if (runId) await apiFetch(`/api/agent-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    } finally {
      controller.current?.abort();
    }
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

  return <div className="qa-shell">
    <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="打开会话侧栏">☰</button>
    <ChatSidebar courses={courses} courseId={courseId} sessions={sessions} activeSessionId={sessionId || undefined} onCourseChange={selectCourse} onNewChat={beginNewChat} onRename={(session) => { setSessionToRename(session); setRenameTitle(session.summary); setSessionActionError(""); }} onDelete={(session) => { setSessionToDelete(session); setSessionActionError(""); }} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    <main className="qa-main">
      <header className="qa-header"><span>{currentCourse?.name ?? "课程答疑"}</span><small>{notice}</small></header>
      <section className="message-list" aria-live="polite">
        {messages.length === 0 ? <div className="qa-welcome"><h1>{currentCourse ? `你好，准备学习 ${currentCourse.name}` : "选择一门课程开始答疑"}</h1><p>我会优先依据当前已发布的课程资料作答，并附上可核查的引用。</p>{examples.map((example) => <button key={example} onClick={() => setInput(example)}>{example}</button>)}</div> : messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>{message.role === "assistant" && <><ToolActivity steps={message.steps ?? []} streaming={isCurrentAssistantMessage(message)} />{message.process && <details className="assistant-process" open={shouldOpenProcess(isCurrentAssistantMessage(message))}><summary>模型处理过程 <small>非最终回答</small></summary><p>{message.process}</p></details>}</>}{message.content && (message.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown> : <p>{message.content}</p>)}{message.insufficient && <p className="insufficient">资料不足：当前可用资料无法支持这个问题。</p>}{message.citations?.map((citation) => <button className="citation" key={citation.type === "knowledge" ? `${citation.path}-${citation.startLine}` : `${citation.sourceId}-${citation.startLine}`} onClick={() => void openCitation(citation)}>{citation.type === "knowledge" ? `${citation.path.split("/").at(-1)} · L${citation.startLine}–L${citation.endLine}` : `${citation.title || new URL(citation.url).hostname} · 网络来源`}</button>)}{message.stopped && <p className="stopped">已停止，未保存本轮回答。</p>}</article>)}</section>
      <ChatComposer value={input} onChange={setInput} onSend={() => void send()} onStop={() => void stopCurrentRun()} allowWebSearch={allowWebSearch} onAllowWebSearchChange={setAllowWebSearch} disabled={composerState.disabled} placeholder={composerState.placeholder} streaming={streaming} />
    </main>
    {sessionToRename && <div className="modal-backdrop"><section className="session-modal" role="dialog" aria-modal="true" aria-labelledby="rename-session-title"><form onSubmit={(event) => { event.preventDefault(); void renameSession(); }}><h2 id="rename-session-title">重命名会话</h2><label>会话名称<input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} maxLength={80} autoFocus /></label>{sessionActionError && <p className="modal-error">{sessionActionError}</p>}<div className="modal-actions"><button type="button" onClick={() => { setSessionToRename(undefined); setSessionActionError(""); }}>取消</button><button type="submit">保存</button></div></form></section></div>}
    {sessionToDelete && <div className="modal-backdrop"><section className="session-modal" role="dialog" aria-modal="true" aria-labelledby="delete-session-title"><h2 id="delete-session-title">删除会话？</h2><p>“{sessionToDelete.summary}”及其历史消息将从本机删除，无法恢复。</p>{sessionActionError && <p className="modal-error">{sessionActionError}</p>}<div className="modal-actions"><button type="button" onClick={() => { setSessionToDelete(undefined); setSessionActionError(""); }}>取消</button><button className="danger-button" type="button" onClick={() => void deleteSession()}>删除</button></div></section></div>}
    {source?.citation.type === "knowledge" && <aside className="source-drawer"><button onClick={() => setSource(undefined)} aria-label="关闭原文">×</button><h2>{source.citation.path.split("/").at(-1)}</h2><p>L{source.citation.startLine}–L{source.citation.endLine}</p><pre>{source.content}</pre></aside>}
  </div>;
}
