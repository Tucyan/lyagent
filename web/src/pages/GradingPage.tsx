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
import { ApiError, apiErrorFromResponse, withJsonHeaders } from "../lib/api";
import type { RubricValue } from "../components/RubricPreviewEditor";
import {
  applyGradingEvent,
  buildAssetManifest,
  clampGradingPreviewPercent,
  conversionPresentation,
  gradingSessionStatusLabel,
  initialLiveMessage,
  normalizeGradingExportOptions,
  parseGradingExportOptions,
  resolveGradingSessionScope,
  resolveGradingRubricKey,
  rubricSelectionKey,
  shouldPollSessionPreparation,
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
  submission: { markdown: string; locked: boolean } | null;
  draft: Draft | null;
  confirmed: ({ resultHash: string } & Draft) | null;
  conversation: { messages: ConversationMessage[] };
};
type FrozenRubric = {
  assignmentId: string;
  title: string;
  version: number;
  hash: string;
  rubric: RubricValue;
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function GradingPage() {
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const query = new URLSearchParams(locationSearch);
  const selectedId = query.get("session") ?? undefined;
  const [sessions, setSessions] = useState<GradingSession[]>([]),
    [detail, setDetail] = useState<SessionDetail>(),
    [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const [creating, setCreating] = useState(!selectedId),
    [selectedRubricKey, setSelectedRubricKey] = useState(
      query.get("rubric") ?? localStorage.getItem("grading-rubric") ?? "",
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
    [sessionActionError, setSessionActionError] = useState("");
  const [exportOptions, setExportOptions] = useState<GradingExportOptions>(() =>
    parseGradingExportOptions(localStorage.getItem("grading-csv-columns")),
  );
  const splitRef = useRef<HTMLElement>(null);
  const navigateWithinGrading = (search: URLSearchParams) => {
    const suffix = search.toString();
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
  const refreshList = async (currentSession?: GradingSession) => {
    const rubric = resolveGradingSessionScope(
      currentSession,
      rubrics,
      selectedRubricKey,
    );
    setSessions(
      rubric
        ? await api<GradingSession[]>(
            `/api/grading/sessions?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`,
          )
        : [],
    );
  };
  const refreshDetail = async (id = selectedId) => {
    if (!id) {
      setDetail(undefined);
      return;
    }
    const next = await api<SessionDetail>(`/api/grading/sessions/${id}`);
    setDetail(next);
    setMarkdown(next.submission?.markdown ?? "");
    if (next.draft || next.confirmed) setPreviewMode("result");
    return next;
  };

  useEffect(() => {
    const updateLocation = () => setLocationSearch(window.location.search);
    window.addEventListener("popstate", updateLocation);
    return () => window.removeEventListener("popstate", updateLocation);
  }, []);
  useEffect(() => {
    setCreating(!selectedId && !query.has("rubric"));
  }, [locationSearch]);
  useEffect(() => {
    void (async () => {
      try {
        const [nextRubrics, nextDetail] = await Promise.all([
          api<FrozenRubric[]>("/api/grading/rubrics"),
          refreshDetail(),
        ]);
        setRubrics(nextRubrics);
        const key = resolveGradingRubricKey(
          nextRubrics,
          nextDetail
            ? `${nextDetail.assignmentId}:${nextDetail.rubricVersion}`
            : selectedRubricKey,
        );
        setSelectedRubricKey(key);
        if (key) localStorage.setItem("grading-rubric", key);
        const rubric = nextRubrics.find(
          (item) => rubricSelectionKey(item) === key,
        );
        setSessions(
          rubric
            ? await api<GradingSession[]>(
                `/api/grading/sessions?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`,
              )
            : [],
        );
        setNotice("会话状态已恢复；不会自动重新调用模型。");
      } catch (error) {
        setNotice((error as Error).message);
      }
    })();
  }, [selectedId]);
  useEffect(() => {
    localStorage.setItem("grading-csv-columns", JSON.stringify(exportOptions));
  }, [exportOptions]);
  useEffect(() => {
    setAcknowledgedReasons([]);
  }, [detail?.draft?.version]);
  useEffect(() => {
    if (!detail || !shouldPollSessionPreparation(detail)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await refreshDetail(detail.id);
        await refreshList(next);
        if (!cancelled && next && shouldPollSessionPreparation(next))
          timer = window.setTimeout(() => void poll(), 1_000);
      } catch (error) {
        if (!cancelled) setNotice((error as Error).message);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
    setLive((current) =>
      current?.runId === runId ? current : initialLiveMessage(runId),
    );
    let after = 0;
    let terminal = false;
    while (!terminal) {
      const response = await fetch(
        `/api/grading/sessions/${sessionId}/runs/${runId}/events?after=${after}&follow=true`,
      );
      if (!response.ok) throw new Error("无法连接批改事件流");
      await consumeSse(response, (type, value) => {
        const event = value as Record<string, unknown>;
        if (typeof event.sequence === "number")
          after = Math.max(after, event.sequence);
        terminal = ["final", "error", "cancelled"].includes(type);
        setLive((current) =>
          applyGradingEvent(current ?? initialLiveMessage(runId), type, event),
        );
      });
    }
    await Promise.all([refreshDetail(sessionId), refreshList()]);
  };
  const startRun = async (kind: "grade" | "chat", text: string) => {
    if (!detail) return;
    const run = await api<{ id: string }>(
      kind === "grade"
        ? `/api/grading/sessions/${detail.id}/runs`
        : `/api/grading/sessions/${detail.id}/messages`,
      { method: "POST", body: JSON.stringify({ message: text }) },
    );
    setMessage("");
    await followRun(detail.id, run.id);
  };
  const cancelRun = async () => {
    if (!live || live.complete) return;
    await api(`/api/agent-runs/${live.runId}/cancel`, { method: "POST" });
    setNotice("本次运行已停止。");
  };
  const retryConversion = async () => {
    if (!detail) return;
    await api(`/api/grading/sessions/${detail.id}/conversion/retry`, {
      method: "POST",
    });
    await Promise.all([refreshDetail(detail.id), refreshList()]);
  };
  const retrySubmissionTitle = async () => {
    if (!detail) return;
    await api(`/api/grading/sessions/${detail.id}/title/retry`, {
      method: "POST",
    });
    await Promise.all([refreshDetail(detail.id), refreshList()]);
  };
  const createRevision = async () => {
    if (!detail) return;
    const revision = await api<{ id: string }>(
      `/api/grading/sessions/${detail.id}/revisions`,
      { method: "POST" },
    );
    navigateToSession(revision.id);
  };
  const saveSubmission = async () => {
    if (!detail?.submissionVersion) return;
    await api(`/api/grading/sessions/${detail.id}/submission`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: detail.submissionVersion,
        markdown,
      }),
    });
    setEditing(false);
    await refreshDetail(detail.id);
    await refreshList();
  };
  const confirm = async () => {
    if (!detail?.draft) return;
    await api(`/api/grading/sessions/${detail.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: detail.draft.version,
        reviewNote,
        acknowledgedReasons,
      }),
    });
    await refreshDetail(detail.id);
    await refreshList();
  };
  const chooseRubric = (key: string) => {
    setSelectedRubricKey(key);
    localStorage.setItem("grading-rubric", key);
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
    } catch (error) {
      setSessionActionError((error as Error).message);
    }
  };
  const deleteSession = async () => {
    if (!sessionToDelete) return;
    try {
      const response = await fetch(
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
    const response = await fetch(
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

  return (
    <div className="grading-page">
      <header className="grading-header">
        <button
          type="button"
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          {sidebarCollapsed ? "显示会话" : "收起会话"}
        </button>
        <div>
          <p className="eyebrow">单份作业批改</p>
          <h1>{detail ? detail.title : "批改工作台"}</h1>
          <p>{notice}</p>
        </div>
        <button type="button" onClick={() => setCreating(true)}>
          新建会话
        </button>
      </header>
      <div
        className={`grading-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      >
        <aside className="grading-sessions">
          <label className="grading-rubric-filter">
            <span>当前评分标准</span>
            <select
              value={selectedRubricKey}
              onChange={(event) => chooseRubric(event.target.value)}
            >
              {rubrics.map((rubric) => (
                <option
                  key={rubricSelectionKey(rubric)}
                  value={rubricSelectionKey(rubric)}
                >
                  {rubric.title} · v{rubric.version}
                </option>
              ))}
            </select>
          </label>
          <div className="grading-sidebar-heading">
            <strong>批改会话</strong>
            <span>{sessions.length}</span>
          </div>
          <button type="button" onClick={() => setCreating(true)}>
            ＋ 上传作业
          </button>
          <nav>
            {sessions.map((session) => (
              <article
                className={session.id === selectedId ? "active" : ""}
                key={session.id}
              >
                <a
                  href={`/grading?session=${session.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    setCreating(false);
                    navigateToSession(session.id);
                  }}
                >
                  <strong>{session.title}</strong>
                  <span>{session.submissionTitle ?? gradingSessionStatusLabel(session)}</span>
                  <small>
                    {session.studentName} · {session.studentNumber}
                  </small>
                  <small>
                    {session.conversionStatus} · {session.gradingStatus}
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
            ))}
          </nav>
          <ExportPanel
            options={exportOptions}
            setOption={updateExportOption}
            canExportStudent={Boolean(detail)}
            canExportRubric={Boolean(selectedRubric)}
            exportStudent={() =>
              void downloadCsv("student").catch((error: Error) =>
                setNotice(error.message),
              )
            }
            exportRubric={() =>
              void downloadCsv("rubric").catch((error: Error) =>
                setNotice(error.message),
              )
            }
          />
        </aside>
        <section
          className="grading-split"
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
                      {detail.gradingStatus}
                    </p>
                    <p>
                      作业名称：
                      {detail.submissionTitle ??
                        (detail.submissionTitleStatus === "failed"
                          ? "识别失败"
                          : "正在识别…")}
                    </p>
                    {detail.submissionTitleError && (
                      <p className="modal-error">
                        [{detail.submissionTitleError.code}] {detail.submissionTitleError.message}
                      </p>
                    )}
                  </div>
                  {detail.submissionTitleStatus === "failed" && (
                    <button
                      type="button"
                      onClick={() => void retrySubmissionTitle()}
                    >
                      重试名称识别
                    </button>
                  )}
                  {detail.conversionStatus === "ready" &&
                    ["not_started", "queued", "failed", "cancelled"].includes(
                      detail.gradingStatus,
                    ) &&
                    !detail.activeRunId && (
                      <button
                        type="button"
                        onClick={() =>
                          void startRun("grade", "请开始批改当前作业。")
                        }
                      >
                        {["failed", "cancelled"].includes(detail.gradingStatus)
                          ? "重试批改"
                          : "开始批改"}
                      </button>
                    )}
                </div>
                <div className="grading-message-list">
                  {detail.conversation.messages.map((item, index) => (
                    <ConversationBubble
                      message={item}
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
                <form
                  className="grading-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim()) void startRun("chat", message);
                  }}
                >
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="询问评分依据，或明确要求 Agent 修改草稿"
                    disabled={Boolean(live && !live.complete)}
                  />
                  {live && !live.complete ? (
                    <button type="button" onClick={() => void cancelRun()}>
                      停止
                    </button>
                  ) : (
                    <button type="submit" disabled={!message.trim()}>
                      发送
                    </button>
                  )}
                </form>
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
                  className={previewMode === "submission" ? "active" : ""}
                  onClick={() => setPreviewMode("submission")}
                >
                  学生作业
                </button>
                <button
                  className={previewMode === "result" ? "active" : ""}
                  onClick={() => setPreviewMode("result")}
                >
                  评分结果
                </button>
              </div>
              <button onClick={() => setFullscreen((value) => !value)}>
                {fullscreen ? "退出全屏" : "全屏"}
              </button>
            </div>
            <div className="grading-preview-body">
              {!detail ? (
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
                />
              )}
            </div>
          </aside>
        </section>
      </div>
      {sessionToRename && (
        <div className="modal-backdrop">
          <section className="session-modal" role="dialog" aria-modal="true">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void renameSession();
              }}
            >
              <h2>重命名批改会话</h2>
              <label>
                会话名称
                <input
                  value={renameTitle}
                  maxLength={80}
                  autoFocus
                  onChange={(event) => setRenameTitle(event.target.value)}
                />
              </label>
              {sessionActionError && (
                <p className="modal-error">{sessionActionError}</p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => setSessionToRename(undefined)}
                >
                  取消
                </button>
                <button type="submit">保存</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {sessionToDelete && (
        <div className="modal-backdrop">
          <section className="session-modal" role="dialog" aria-modal="true">
            <h2>删除批改会话？</h2>
            <p>
              “{sessionToDelete.title}
              ”的作业文件、批改过程和结果将从本机永久删除。
            </p>
            {sessionActionError && (
              <p className="modal-error">{sessionActionError}</p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setSessionToDelete(undefined)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void deleteSession()}
              >
                删除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ConversationBubble({
  message,
  onOption,
}: {
  message: ConversationMessage;
  onOption(option: string): void;
}) {
  return (
    <article className={`grading-message ${message.role}`}>
      <div>
        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
        {message.options && message.options.length > 0 && (
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
        )}
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
            <button type="button" onClick={() => void retry()}>
              立即重试
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
          <button type="button" onClick={() => void createRevision()}>
            创建提交修订
          </button>
        ) : editing ? (
          <>
            <button onClick={() => setEditing(false)}>取消</button>
            <button onClick={() => void save()}>保存修订</button>
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
}: {
  detail: SessionDetail;
  reviewNote: string;
  setReviewNote(value: string): void;
  acknowledgedReasons: string[];
  setAcknowledgedReasons(value: string[]): void;
  confirm(): Promise<void>;
  createRevision(): Promise<void>;
  refresh(): Promise<void>;
}) {
  const draft = detail.confirmed ?? detail.draft;
  const [manual, setManual] = useState(false);
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
    if (!detail.draft || !editNote.trim()) return;
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
      {result.review.requiresReview && (
        <section className="review-alert">
          <strong>需要教师复核并逐项确认</strong>
          {result.review.reasons.map((reason) => (
            <label key={reason}>
              <input
                type="checkbox"
                checked={acknowledgedReasons.includes(reason)}
                onChange={(event) =>
                  setAcknowledgedReasons(
                    event.target.checked
                      ? [...acknowledgedReasons, reason]
                      : acknowledgedReasons.filter((item) => item !== reason),
                  )
                }
              />
              {reason}
            </label>
          ))}
        </section>
      )}
      {manual && !detail.confirmed ? (
        <DecisionEditor decisions={edited} onChange={setEdited} />
      ) : (
        <DecisionCards decisions={result.decisions} sessionId={detail.id} />
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
            <button type="button" onClick={() => void createRevision()}>
              创建结果修订
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
                  onClick={() => void saveManual()}
                  disabled={!editNote.trim()}
                >
                  保存结构化修订
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
                onClick={() => void confirm()}
                disabled={
                  result.review.requiresReview &&
                  (!reviewNote.trim() || !allAcknowledged)
                }
              >
                确认并发布正式结果
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
function decisionEntries(decisions: Record<string, unknown>) {
  return ["criteria", "deductions", "bonuses"].flatMap((key) =>
    Array.isArray(decisions[key])
      ? (decisions[key] as Array<Record<string, unknown>>).map(
          (item, index) => ({ key, index, item }),
        )
      : [],
  );
}
export function DecisionCards({
  decisions,
  sessionId,
}: {
  decisions: Record<string, unknown>;
  sessionId: string;
}) {
  return (
    <section className="decision-list">
      {decisionEntries(decisions).map(({ item }, index) => {
        const evidence = Array.isArray(item.evidence)
          ? (item.evidence as Array<Record<string, unknown>>)
          : [];
        return (
          <article key={String(item.criterionId ?? item.ruleId ?? index)}>
            <div>
              <strong>
                {String(item.criterionId ?? item.ruleId ?? `项目 ${index + 1}`)}
              </strong>
              <span>
                {item.score !== undefined
                  ? `${item.score} 分`
                  : item.deduction !== undefined
                    ? `扣 ${item.deduction} 分`
                    : item.bonus !== undefined
                      ? `加 ${item.bonus} 分`
                      : ""}
              </span>
            </div>
            <p>{String(item.reason ?? "")}</p>
            <small>
              置信度 {Math.round(Number(item.confidence ?? 0) * 100)}% ·
              分析依据 {evidence.length} 条
            </small>
            {evidence.length > 0 && (
              <details>
                <summary>查看评分分析依据</summary>
                {evidence.map((entry, evidenceIndex) => (
                  <div
                    className="grading-evidence"
                    key={`${String(entry.path ?? entry.kind)}-${evidenceIndex}`}
                  >
                    {entry.kind === "analysis" ? (
                      <>
                        <strong>模型分析论据</strong>
                        <p>
                          <b>作业表现：</b>
                          {String(entry.observation ?? "")}
                        </p>
                        <p>
                          <b>标准对应：</b>
                          {String(entry.rubricBasis ?? "")}
                        </p>
                        <p>
                          <b>分值理由：</b>
                          {String(entry.scoreJustification ?? "")}
                        </p>
                      </>
                    ) : entry.kind === "image" ? (
                      <>
                        <img
                          src={`/api/grading/sessions/${sessionId}/assets/${encodeURIComponent(String(entry.path).replace(/^assets\//, ""))}`}
                          alt="评分佐证"
                        />
                        <p>{String(entry.explanation ?? "")}</p>
                      </>
                    ) : (
                      <>
                        <code>
                          {String(entry.path)}:{String(entry.startLine)}-
                          {String(entry.endLine)}
                        </code>
                        <blockquote>{String(entry.quote ?? "")}</blockquote>
                      </>
                    )}
                  </div>
                ))}
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}
export function DecisionEditor({
  decisions,
  onChange,
}: {
  decisions: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
}) {
  const update = (
    key: string,
    index: number,
    field: string,
    value: unknown,
  ) => {
    const next = structuredClone(decisions);
    const items = next[key] as Array<Record<string, unknown>>;
    items[index] = { ...items[index], [field]: value };
    onChange(next);
  };
  return (
    <section className="decision-list decision-editor">
      {decisionEntries(decisions).map(({ key, index, item }) => (
        <article key={`${key}-${index}`}>
          <strong>{String(item.criterionId ?? item.ruleId)}</strong>
          {item.triggered !== undefined && (
            <label>
              <input
                type="checkbox"
                checked={Boolean(item.triggered)}
                onChange={(event) =>
                  update(key, index, "triggered", event.target.checked)
                }
              />
              触发规则
            </label>
          )}
          {["score", "deduction", "bonus"]
            .filter((field) => item[field] !== undefined)
            .map((field) => (
              <label key={field}>
                {field}
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={Number(item[field])}
                  onChange={(event) =>
                    update(key, index, field, Number(event.target.value))
                  }
                />
              </label>
            ))}
          <label>
            理由
            <textarea
              value={String(item.reason ?? "")}
              onChange={(event) =>
                update(key, index, "reason", event.target.value)
              }
            />
          </label>
          <label>
            置信度
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={Number(item.confidence ?? 0)}
              onChange={(event) =>
                update(key, index, "confidence", Number(event.target.value))
              }
            />
          </label>
        </article>
      ))}
    </section>
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
      form.set("assignmentId", rubric.assignmentId);
      form.set("rubricVersion", String(rubric.version));
      form.delete("assetDirectory");
      const assetManifest = buildAssetManifest(assetFiles);
      for (const asset of assetFiles) form.append("asset", asset);
      form.set("assetManifest", JSON.stringify(assetManifest));
      if (!form.has("autoStartAfterConversion"))
        form.set("autoStartAfterConversion", "false");
      const response = await fetch("/api/grading/sessions", {
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
        onSubmit={(event) => void submit(event)}
      >
        <h2>新建批改会话</h2>
        <p className="grading-selected-rubric">
          评分标准：
          {rubric ? `${rubric.title} · v${rubric.version}` : "请先在左侧选择"}
        </p>
        <label>
          学生姓名
          <input
            name="studentName"
            placeholder="两项都留空时从文件名识别"
            aria-invalid={errorFields.includes("studentName") || undefined}
          />
        </label>
        <label>
          学号
          <input
            name="studentNumber"
            placeholder="姓名与学号必须同时填写"
            aria-invalid={errorFields.includes("studentNumber") || undefined}
          />
        </label>
        <label>
          作业名称（可选）
          <input
            name="submissionTitle"
            maxLength={200}
            placeholder="留空时 Agent 会检索正文和文件名，冲突时以正文为准"
          />
        </label>
        <label>
          学生报告
          <input
            name="file"
            type="file"
            required
            accept=".md,.pdf,.docx,.pptx,.png,.jpg,.jpeg"
            aria-invalid={errorFields.includes("file") || undefined}
          />
        </label>
        <label>
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
          <small>{assetFiles.length ? `已选择 ${assetFiles.length} 个附件` : "请选择名为 assets 的目录"}</small>
        </label>
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
          <button type="submit" disabled={submitting || !rubric}>
            {submitting ? "正在创建…" : "创建会话"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ExportPanel({
  options,
  setOption,
  canExportStudent,
  canExportRubric,
  exportStudent,
  exportRubric,
}: {
  options: GradingExportOptions;
  setOption(key: keyof GradingExportOptions, value: boolean): void;
  canExportStudent: boolean;
  canExportRubric: boolean;
  exportStudent(): void;
  exportRubric(): void;
}) {
  const fields: Array<[keyof GradingExportOptions, string]> = [
    ["studentName", "学生姓名"],
    ["studentNumber", "学号"],
    ["submissionTitle", "作业名称"],
    ["itemDetails", "详细得分点 / 扣分点"],
    ["totalScore", "总分"],
    ["overallConfidence", "总置信度"],
  ];
  return (
    <details className="grading-export-panel">
      <summary>导出成绩表 CSV</summary>
      <div>
        {fields.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={options[key]}
              onChange={(event) => setOption(key, event.target.checked)}
            />
            {label}
          </label>
        ))}
        <label className="grading-export-child">
          <input
            type="checkbox"
            checked={options.itemConfidence}
            disabled={!options.itemDetails}
            onChange={(event) =>
              setOption("itemConfidence", event.target.checked)
            }
          />
          子项置信度
        </label>
        <button
          type="button"
          disabled={!canExportStudent}
          onClick={exportStudent}
        >
          导出当前学生全部作业
        </button>
        <button
          type="button"
          disabled={!canExportRubric}
          onClick={exportRubric}
        >
          导出当前评分标准全部学生
        </button>
      </div>
    </details>
  );
}
