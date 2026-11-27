import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StudentApiError, studentFetch, studentJson } from "../lib/api";
import { consumeStudentQaStream } from "../lib/qa-stream.js";

type Citation =
  | { type: "knowledge"; path: string; title?: string; startLine: number; endLine: number }
  | { type: "web"; sourceId: string; title: string; url: string; startLine: number; endLine: number };

interface ToolStep {
  id: string;
  label: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

interface QaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  insufficient?: boolean;
  steps?: ToolStep[];
  process?: string;
  stopped?: boolean;
}

interface SessionSummary {
  id: string;
  releaseId: string;
  updatedAt: string;
  summary: string;
}

interface QuotaSummary {
  emergencyQaPaused: boolean;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  totalLimit: number | null;
  totalUsed: number;
  totalRemaining: number | null;
  perMinuteLimit: number;
}

export function StudentQaPage({ courseId, courseName }: { courseId: string; courseName: string }) {
  const [damagedSessionCount, setDamagedSessionCount] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [documents, setDocuments] = useState<Array<{ path: string; title: string }>>([]);
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [quota, setQuota] = useState<QuotaSummary | null>(null);
  const [role, setRole] = useState<"teacher" | "student">("student");
  const [modelConfigured, setModelConfigured] = useState(true);
  const [webSearchAvailable, setWebSearchAvailable] = useState(true);
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [input, setInput] = useState("");
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [source, setSource] = useState<{ citation: Extract<Citation, { type: "knowledge" }>; content: string }>();
  const activeCourse = useRef(courseId);
  activeCourse.current = courseId;
  const selectionRevision = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  const streaming = Boolean(streamingMessageId);

  useEffect(() => {
    const el = messageListRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 180;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input, courseId]);

  const loadCourseState = async (cid: string) => {
    if (!cid) return;
    setError("");
    const [quotaRes, sessionsRes, treeRes] = await Promise.all([
      studentJson<{
        role: "teacher" | "student";
        modelConfigured: boolean;
        webSearchAvailable: boolean;
        quota: QuotaSummary;
      }>(`/api/student/courses/${encodeURIComponent(cid)}/quota`),
      studentJson<{ sessions: SessionSummary[]; damagedCount?: number }>(`/api/student/courses/${encodeURIComponent(cid)}/sessions`),
      studentJson<{ documents: Array<{ path: string; title: string }> }>(
        `/api/student/courses/${encodeURIComponent(cid)}/tree`,
      ),
    ]);
    if (activeCourse.current !== cid) return;
    setQuota(quotaRes.quota);
    setRole(quotaRes.role);
    setModelConfigured(quotaRes.modelConfigured);
    setWebSearchAvailable(quotaRes.webSearchAvailable);
    if (!quotaRes.webSearchAvailable) setAllowWebSearch(false);
    setSessions(sessionsRes.sessions);
    setDamagedSessionCount(sessionsRes.damagedCount ?? 0);
    setDocuments(treeRes.documents);
    if (sessionsRes.sessions.length > 0) {
      await openSession(cid, sessionsRes.sessions[0]!.id);
    } else {
      setSessionId("");
      setMessages([]);
    }
  };

  const openSession = async (cid: string, sid: string, stillSelected?: () => boolean) => {
    const revision = stillSelected ? selectionRevision.current : ++selectionRevision.current;
    const detail = await studentJson<{
      id: string;
      releaseId: string;
      messages: Array<{ role: "user" | "assistant"; content: string; citations?: Citation[]; insufficient?: boolean }>;
    }>(`/api/student/courses/${encodeURIComponent(cid)}/sessions/${encodeURIComponent(sid)}`);
    if (activeCourse.current !== cid || selectionRevision.current !== revision || (stillSelected && !stillSelected())) return;
    setSessionId(detail.id);
    setMessages(detail.messages.map((m, idx) => ({ ...m, id: `${detail.id}-${idx}` })));
    setSource(undefined);
    setSidebarOpen(false);
  };

  useEffect(() => {
    controllerRef.current?.abort();
    setStreamingMessageId(undefined);
    setSource(undefined);
    if (courseId) {
      void loadCourseState(courseId).catch((err) => {
        if (activeCourse.current !== courseId) return;
        setError(err instanceof StudentApiError ? err.message : "加载答疑状态失败");
      });
    }
    return () => {
      controllerRef.current?.abort();
    };
  }, [courseId]);

  const examples = useMemo(
    () => documents.slice(0, 3).map((doc) => `请解释“${doc.title}”中的核心概念`),
    [documents],
  );

  const beginNewChat = () => {
    if (streaming) return;
    setSessionId("");
    setMessages([]);
    setSource(undefined);
    setSidebarOpen(false);
  };

  const renameSession = async (s: SessionSummary) => {
    if (!courseId || streaming) return;
    const nextTitle = window.prompt("重命名会话", s.summary);
    if (!nextTitle?.trim()) return;
    await studentJson(`/api/student/courses/${encodeURIComponent(courseId)}/sessions/${encodeURIComponent(s.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: nextTitle.trim() }),
    });
    const list = await studentJson<{ sessions: SessionSummary[]; damagedCount?: number }>(
      `/api/student/courses/${encodeURIComponent(courseId)}/sessions`,
    );
    if (activeCourse.current !== courseId) return;
    setSessions(list.sessions);
    setDamagedSessionCount(list.damagedCount ?? 0);
  };

  const deleteSession = async (sid: string) => {
    if (!courseId || streaming) return;
    if (!window.confirm("确定永久删除该会话及其历史消息吗？")) return;
    await studentJson(`/api/student/courses/${encodeURIComponent(courseId)}/sessions/${encodeURIComponent(sid)}`, {
      method: "DELETE",
    });
    await loadCourseState(courseId);
  };

  const openCitation = async (citation: Citation) => {
    if (citation.type === "web") {
      window.open(citation.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!courseId) return;
    try {
      const res = await studentJson<{ content: string }>(
        `/api/student/courses/${encodeURIComponent(courseId)}/qa/content?path=${encodeURIComponent(citation.path)}&startLine=${citation.startLine}&endLine=${citation.endLine}`,
      );
      setSource({ citation, content: res.content });
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "无法读取引用资料");
    }
  };

  const stopCurrentRun = async () => {
    const runId = runIdRef.current;
    const controller = controllerRef.current;
    try {
      if (runId) await studentFetch(`/api/student/agent-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    } finally {
      controller?.abort();
    }
  };

  const sendQuestion = async () => {
    const question = input.trim();
    if (!question || !courseId || streaming) return;
    setError("");
    const assistantMsgId = `a-${Date.now()}`;
    const userMsgId = `u-${Date.now()}`;
    setStreamingMessageId(assistantMsgId);

    const controller = new AbortController();
    controllerRef.current = controller;
    const selectedRevision = selectionRevision.current;
    const ownsSelection = () => activeCourse.current === courseId && selectionRevision.current === selectedRevision && controllerRef.current === controller;
    let targetSessionId = sessionId;
    try {
      if (!targetSessionId) {
        const created = await studentJson<{ id: string }>(
          `/api/student/courses/${encodeURIComponent(courseId)}/sessions`,
          { method: "POST" },
        );
        if (!ownsSelection()) return;
        targetSessionId = created.id;
        setSessionId(created.id);
      }

      setInput("");
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", content: question },
        { id: assistantMsgId, role: "assistant", content: "", steps: [] },
      ]);

      const response = await studentFetch(
        `/api/student/courses/${encodeURIComponent(courseId)}/sessions/${encodeURIComponent(targetSessionId)}/ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, allowWebSearch: webSearchAvailable && allowWebSearch }),
          signal: controller.signal,
        },
      );

      if (!ownsSelection()) { await response.body?.cancel(); return; }
      if (!response.ok) {
        let msg = `提问失败 (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          // ignore
        }
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId && m.id !== userMsgId));
        setInput(question);
        setError(msg);
        return;
      }

      runIdRef.current = response.headers.get("x-agent-run-id") ?? undefined;
      await consumeStudentQaStream(response, (event, raw) => {
        if (!ownsSelection()) return;
        const data = raw as {
          id?: string;
          label?: string;
          summary?: string;
          status?: "completed" | "failed";
          delta?: string;
          message?: string;
          answer?: { answer: string; citations?: Citation[]; insufficient?: boolean };
          quota?: QuotaSummary;
        };
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsgId) return m;
            if (event === "tool_start" && data.id && data.label && data.summary) {
              return {
                ...m,
                steps: [...(m.steps ?? []), { id: data.id, label: data.label, summary: data.summary, status: "running" }],
              };
            }
            if (event === "tool_end" && data.id) {
              return {
                ...m,
                steps: (m.steps ?? []).map((step) =>
                  step.id === data.id ? { ...step, status: data.status === "failed" ? "failed" : "completed" } : step,
                ),
              };
            }
            if (event === "answer_delta" && data.delta) {
              return { ...m, process: `${m.process ?? ""}${data.delta}` };
            }
            if (event === "final" && data.answer) {
              return {
                ...m,
                content: data.answer.answer,
                ...(data.answer.citations ? { citations: data.answer.citations } : {}),
                ...(data.answer.insufficient ? { insufficient: true } : {}),
              };
            }
            if (event === "error") {
              setError(data.message ?? "答疑失败，本次不扣减额度");
              return { ...m, content: data.message ?? "答疑未能完成" };
            }
            return m;
          }),
        );
        if (event === "final" && data.quota) {
          setQuota(data.quota);
        }
      }, async () => {
        if (!ownsSelection()) return;
        const quotaPath = `/api/student/courses/${encodeURIComponent(courseId)}/quota`;
        const [detail, quotaResult] = await Promise.allSettled([
          openSession(courseId, targetSessionId, ownsSelection),
          studentJson<{ quota: QuotaSummary }>(quotaPath),
        ]);
        if (!ownsSelection()) return;
        if (quotaResult.status === "fulfilled") setQuota(quotaResult.value.quota);
        if (detail.status === "rejected") {
          setMessages((prev) => prev.filter((message) => message.id !== assistantMsgId && message.id !== userMsgId));
        }
        setInput((current) => current || question);
        setError("答疑连接已中断，请先查看会话中的已保存回复。");
      });

      const list = await studentJson<{ sessions: SessionSummary[]; damagedCount?: number }>(
        `/api/student/courses/${encodeURIComponent(courseId)}/sessions`,
      );
      if (!ownsSelection()) return;
      setSessions(list.sessions);
      setDamagedSessionCount(list.damagedCount ?? 0);
    } catch (err) {
      if (!ownsSelection()) return;
      if ((err as Error).name === "AbortError") {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, stopped: true } : m)));
      } else {
        setError(err instanceof Error ? err.message : "请求中断，未扣减额度");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        runIdRef.current = undefined;
        setStreamingMessageId(undefined);
      }
    }
  };

  if (!courseId) {
    return (
      <div style={{ padding: 24 }}>
        <div className="st-card st-empty-state">
          <h2>暂无可提问的课程</h2>
          <p>请联系授课教师为您分配课程访问权限。</p>
        </div>
      </div>
    );
  }

  const quotaBlocked =
    role === "student" &&
    quota !== null &&
    (quota.emergencyQaPaused ||
      quota.dailyRemaining <= 0 ||
      (quota.totalRemaining !== null && quota.totalRemaining <= 0));

  const composerDisabled = !modelConfigured || quotaBlocked;
  const composerPlaceholder = !modelConfigured
    ? "管理员尚未配置答疑模型，可先查看左侧“课程资料”"
    : quotaBlocked
      ? "当前不可发起答疑，您仍可查看课程资料"
      : "输入你的课程问题";

  return (
    <div className={`qa-shell ${sidebarCollapsed ? "chat-sidebar-collapsed" : ""}`}>
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="打开会话侧栏">
        ☰
      </button>

      <aside className={`chat-sidebar ${sidebarOpen ? "open" : ""}`} aria-label="答疑会话" aria-hidden={sidebarCollapsed}>
        <div className="sidebar-heading">
            <strong>课程答疑</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                className="st-icon-btn"
                onClick={() => setSidebarCollapsed(true)}
                title="收起会话侧栏"
                aria-label="收起会话侧栏"
              >
                «
              </button>
              <button className="mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭会话侧栏">
                ×
              </button>
            </div>
          </div>
        <div className="admin-course-badge" title={courseName}>
          {courseName || "当前课程"}
        </div>
        <button className="new-chat" onClick={beginNewChat} disabled={!courseId || streaming}>
          ＋ 新建对话
        </button>
        <p className="sidebar-label">最近对话</p>
        <nav>
          {sessions.length === 0 ? (
            <p className="muted">尚无对话</p>
          ) : (
            sessions.map((session) => (
              <div className={`session-row ${sessionId === session.id ? "active" : ""}`} key={session.id}>
                <button className="session-link" onClick={() => void openSession(courseId, session.id)}>
                  {session.summary}
                </button>
                <div className="session-actions">
                  <button
                    className="session-action"
                    type="button"
                    onClick={() => void renameSession(session)}
                    aria-label={`重命名会话：${session.summary}`}
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    className="session-action delete"
                    type="button"
                    onClick={() => void deleteSession(session.id)}
                    aria-label={`删除会话：${session.summary}`}
                    title="删除"
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))
          )}
        </nav>
      </aside>

      <main className="qa-main">
        <header className="qa-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {sidebarCollapsed && (
              <button
                type="button"
                className="st-icon-btn"
                onClick={() => setSidebarCollapsed(false)}
                title="展开会话侧栏"
                aria-label="展开会话侧栏"
              >
                »
              </button>
            )}
            <span>{courseName || "课程答疑"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <small>
              {webSearchAvailable && allowWebSearch ? "课程资料优先；可使用网络补充当前信息" : "仅依据已发布课程资料回答"}
            </small>
            {role === "teacher" ? (
              <span className="student-quota-pill">教师预览（不限额度）</span>
            ) : quota ? (
              <span className={`student-quota-pill ${quotaBlocked ? "exhausted" : ""}`}>
                {quota.emergencyQaPaused
                  ? "答疑已暂停"
                  : `今日剩余 ${quota.dailyRemaining}/${quota.dailyLimit} 次${
                      quota.totalRemaining !== null ? ` · 累计余 ${quota.totalRemaining} 次` : ""
                    }`}
              </span>
            ) : null}
          </div>
        </header>

        {(!modelConfigured || error || damagedSessionCount > 0) && (
          <div className="qa-banners">
            {!modelConfigured && (
              <div className="student-info-banner">
                当前服务尚未配置答疑大模型（需通过环境变量 <code>STUDENT_MODEL_*</code> 配置），您目前仍可正常浏览与搜索全部课程资料。
              </div>
            )}
            {damagedSessionCount > 0 && <p role="status">有 {damagedSessionCount} 条会话记录无法读取，其余会话可正常使用。</p>}
            {error && <div className="student-error-banner">{error}</div>}
          </div>
        )}

        <section
          ref={messageListRef}
          className="message-list"
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
          }}
        >
          {messages.length === 0 ? (
            <div className="qa-welcome">
              <h1>{courseName ? `你好，准备学习 ${courseName}` : "选择一门课程开始答疑"}</h1>
              <p>我会优先依据当前已发布的课程资料作答，并附上可核查的引用。</p>
              {examples.map((example) => (
                <button key={example} type="button" onClick={() => setInput(example)}>
                  {example}
                </button>
              ))}
            </div>
          ) : (
            messages.map((message) => {
              const isCurrent = streaming && message.id === streamingMessageId;
              return (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  {message.role === "assistant" && (
                    <>
                      {message.steps && message.steps.length > 0 && (
                        <div className="tool-activity" style={{ marginBottom: 8 }}>
                          {message.steps.map((step) => (
                            <div key={step.id} className={`tool-step ${step.status}`}>
                              <span>{step.label}</span>
                              <small style={{ marginLeft: 6, color: "var(--text-muted)" }}>{step.summary}</small>
                            </div>
                          ))}
                        </div>
                      )}
                      {message.process && (
                        <details className="assistant-process" open={isCurrent}>
                          <summary>
                            模型处理过程 <small>非最终回答</small>
                          </summary>
                          <p>{message.process}</p>
                        </details>
                      )}
                    </>
                  )}
                  {message.content &&
                    (message.role === "assistant" ? (
                      <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
                    ) : (
                      <p>{message.content}</p>
                    ))}
                  {message.insufficient && (
                    <p className="insufficient">资料不足：当前可用资料无法支持这个问题。</p>
                  )}
                  {message.citations?.map((citation) => (
                    <button
                      type="button"
                      className="citation"
                      key={
                        citation.type === "knowledge"
                          ? `${citation.path}-${citation.startLine}`
                          : `${citation.sourceId}-${citation.startLine}`
                      }
                      onClick={() => void openCitation(citation)}
                    >
                      {citation.type === "knowledge"
                        ? `${citation.path.split("/").at(-1)} · L${citation.startLine}–L${citation.endLine}`
                        : `${citation.title || new URL(citation.url).hostname} · 网络来源`}
                    </button>
                  ))}
                  {message.stopped && <p className="stopped">已停止，未保存本轮回答，本次不扣减额度。</p>}
                </article>
              );
            })
          )}
        </section>

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendQuestion();
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={composerDisabled || streaming}
            placeholder={composerPlaceholder}
            aria-label="课程问题"
            rows={1}
            style={{ overflowY: "hidden" }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                return;
              }
              event.preventDefault();
              if (!composerDisabled && !streaming && input.trim()) void sendQuestion();
            }}
          />
          <label className="web-search-toggle" title={webSearchAvailable ? "开启后可联网检索补充最新资料" : "管理员未启用联网搜索"}>
            <input
              type="checkbox"
              checked={webSearchAvailable && allowWebSearch}
              onChange={(event) => setAllowWebSearch(event.target.checked)}
              disabled={composerDisabled || streaming || !webSearchAvailable}
            />
            联网搜索
          </label>
          {streaming ? (
            <button type="button" className="stop-button" onClick={() => void stopCurrentRun()}>
              停止生成
            </button>
          ) : (
            <button type="submit" disabled={composerDisabled || !input.trim()}>
              发送
            </button>
          )}
        </form>
      </main>

      {source?.citation.type === "knowledge" && (
        <aside className="source-drawer">
          <button onClick={() => setSource(undefined)} aria-label="关闭原文">
            ×
          </button>
          <h2>{source.citation.path.split("/").at(-1)}</h2>
          <p>
            L{source.citation.startLine}–L{source.citation.endLine}
          </p>
          <pre>{source.content}</pre>
        </aside>
      )}
    </div>
  );
}
