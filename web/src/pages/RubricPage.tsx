import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RubricDocument, RubricEditor, type RubricMode, type RubricValue } from "../components/RubricPreviewEditor";
import { ToolActivity, type ToolStep } from "../components/ToolActivity";
import { withJsonHeaders } from "../lib/api";
import { consumeSse } from "../lib/consume-sse";
import { appendRubricProcess, appendRubricReply, assertRubricStreamSucceeded, assignmentIdFromSearch, clampPreviewPercent, loadRubricSession, rubricCompletionNotice, rubricDeleteWarning, shouldFollowRubricStream } from "./rubric-page-model";

type RubricAssignment = { id: string; title: string; totalScore: number; requirements: string; sources: Array<{ id: string; role: "rubric_draft" | "note"; name: string; size: number }> };
type Recommendation = { mode: RubricMode; recommended: boolean; reason?: string; benefit?: string };
type RubricDraft = { version: number; updatedAt: string; baseRubricVersion?: number; rubric: RubricValue };
type FrozenRubric = { version: number; hash: string; frozenAt: string; rubric: RubricValue };
type RubricMessage = { id: string; role: "user" | "assistant"; content: string; process?: string; tools?: ToolStep[]; options?: string[] };
type RubricSession = { assignmentId: string; selectedMode: RubricMode; updatedAt: string; messages: Array<{ role: "user" | "assistant"; content: string; process?: string; tools?: Array<{ id: string; label: string; summary: string; status: "completed" | "failed" }>; options?: string[] }> };
type RubricValidation = { errors: Array<{ code: string; message: string; path?: string }>; warnings: Array<{ code: string; message: string; path?: string }> };
type StreamEvent = { type?: string; id?: string; label?: string; summary?: string; status?: "completed" | "failed"; delta?: string; kind?: "question" | "reply" | "draft"; message?: string; reply?: string; question?: { question: string; options?: string[] } };

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };
const firstDraftRequest = "请根据当前作业要求和参考资料生成第一版评分表。";

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "请求失败");
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
  const selectedAssignmentId = assignmentIdFromSearch(window.location.search);
  const [assignments, setAssignments] = useState<RubricAssignment[]>([]);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [previewPercent, setPreviewPercent] = useState(38);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followStreamRef = useRef(true);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<"draft" | number>("draft");
  const [editing, setEditing] = useState(false);
  const [editedRubric, setEditedRubric] = useState<RubricValue>();
  const [validation, setValidation] = useState<RubricValidation>();
  const [freezeReady, setFreezeReady] = useState(false);
  const [assignmentToDelete, setAssignmentToDelete] = useState<RubricAssignment>();
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const refreshAssignments = async () => setAssignments(await api<RubricAssignment[]>("/api/rubrics/assignments"));
  const refreshVersions = async (assignmentId: string) => {
    const next = await api<FrozenRubric[]>(`/api/rubrics/assignments/${assignmentId}/versions`);
    setVersions(next);
    return next;
  };
  const refreshSessionState = async (assignmentId: string) => {
    const [nextDraft, nextSession, nextVersions] = await Promise.all([
      api<RubricDraft | null>(`/api/rubrics/assignments/${assignmentId}/draft`),
      api<RubricSession | null>(`/api/rubrics/assignments/${assignmentId}/session`),
      api<FrozenRubric[]>(`/api/rubrics/assignments/${assignmentId}/versions`),
    ]);
    setDraft(nextDraft ?? undefined);
    setSelectedMode(nextSession?.selectedMode);
    setMessages(storedMessages(nextSession));
    setVersions(nextVersions);
    if (nextDraft) setPreviewVersion("draft");
    else if (nextVersions[0]) setPreviewVersion(nextVersions[0].version);
    return { nextDraft, nextSession, nextVersions };
  };

  useEffect(() => {
    void refreshAssignments().then(() => {
      if (!selectedAssignmentId) setNotice("创建新的评分会话，或从左侧继续已有设计。");
    }).catch((error: Error) => setNotice(error.message));
  }, [selectedAssignmentId]);

  useEffect(() => {
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
          setRecommendations(recommendation.options);
          setNotice("请选择评分制度；选择后会直接生成第一版草稿，无需填写备注。");
        },
      }),
      refreshVersions(selectedAssignmentId),
    ]).then(([, nextVersions]) => {
      if (!loadedDraft && nextVersions[0]) setPreviewVersion(nextVersions[0].version);
    }).catch((error: Error) => setNotice(error.message));
  }, [selectedAssignmentId]);

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
    if (!requirements.trim() && !source.trim()) { setNotice("请填写作业要求，或提供一份参考资料。"); return; }
    setSubmitting(true);
    try {
      const sourceContent = source.trim();
      const created = await api<RubricAssignment>("/api/rubrics/assignments", {
        method: "POST",
        body: JSON.stringify({ title, totalScore: Number(totalScore), requirements, sources: sourceContent ? [{ role: sourceRole, name: sourceName || (sourceRole === "rubric_draft" ? "评分标准草稿.txt" : "设计备注.txt"), content: sourceContent }] : [] }),
      });
      window.location.assign(`/rubrics?assignment=${encodeURIComponent(created.id)}`);
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
    const assistantId = crypto.randomUUID();
    followStreamRef.current = true;
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", content: teacherMessage }, { id: assistantId, role: "assistant", content: "", tools: [] }]);
    setStreamingMessageId(assistantId);
    const response = await fetch(url, withJsonHeaders(init));
    if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "设计请求失败");
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const manual = await response.json() as { selectedMode?: RubricMode; message?: string; draft?: RubricDraft };
      if (manual.selectedMode) setSelectedMode(manual.selectedMode);
      if (manual.draft) { setDraft(manual.draft); setPreviewVersion("draft"); }
      setMessages((items) => items.filter((message) => message.id !== assistantId));
      setNotice(manual.message ?? "评分制度已保存；当前可使用右侧人工编辑器创建草稿。");
      return;
    }
    let streamFailure: string | undefined;
    let completedKind: StreamEvent["kind"];
    await consumeSse(response, (eventName, raw) => {
      const event = raw as StreamEvent;
      if (eventName === "process_delta" && event.delta) updateStreamingAssistant(assistantId, (message) => ({ ...message, process: appendRubricProcess(message.process ?? "", event.delta!) }));
      if (eventName === "reply_delta" && event.delta) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: appendRubricReply(message.content, event.delta!) }));
      if (eventName === "tool_start" && event.id && event.label && event.summary) updateStreamingAssistant(assistantId, (message) => ({ ...message, tools: [...(message.tools ?? []), { id: event.id!, label: event.label!, summary: event.summary!, status: "running" }] }));
      if (eventName === "tool_end" && event.id) updateStreamingAssistant(assistantId, (message) => ({ ...message, tools: (message.tools ?? []).map((tool) => tool.id === event.id ? { ...tool, status: event.status === "failed" ? "failed" : "completed" } : tool) }));
      if (eventName === "question" && event.question) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: event.question!.question, options: event.question!.options }));
      if (eventName === "reply" && event.reply) updateStreamingAssistant(assistantId, (message) => ({ ...message, content: event.reply! }));
      if (eventName === "draft") void api<RubricDraft | null>(`/api/rubrics/assignments/${selectedAssignmentId}/draft`).then((nextDraft) => setDraft(nextDraft ?? undefined));
      if (eventName === "final") {
        completedKind = event.kind;
        updateStreamingAssistant(assistantId, (message) => ({ ...message, content: message.content || (event.kind === "draft" ? "评分表草稿已更新，可以在右侧预览并继续修改。" : event.message ?? "本轮处理已完成。") }));
      }
      if (eventName === "error") {
        streamFailure = event.message ?? "评分表设计未能完成。";
        updateStreamingAssistant(assistantId, (message) => ({ ...message, content: streamFailure! }));
      }
    });
    assertRubricStreamSucceeded(streamFailure);
    await refreshSessionState(selectedAssignmentId);
    await refreshAssignments();
    setNotice(rubricCompletionNotice(completedKind));
  };

  const chooseMode = async (mode: RubricMode) => {
    if (!selectedAssignmentId) return;
    setSubmitting(true);
    setSelectedMode(mode);
    setNotice(`已选择${modeLabel[mode]}，Agent 正在生成第一版草稿…`);
    try { await runAgentRequest(`/api/rubrics/assignments/${selectedAssignmentId}/mode/stream`, { method: "PUT", body: JSON.stringify({ mode }) }, firstDraftRequest); }
    catch (error) { setNotice((error as Error).message); await refreshSessionState(selectedAssignmentId).catch(() => undefined); }
    finally { setSubmitting(false); setStreamingMessageId(undefined); }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!selectedAssignmentId || !selectedMode || !text) return;
    setChatInput("");
    setSubmitting(true);
    try { await runAgentRequest(`/api/rubrics/assignments/${selectedAssignmentId}/messages/stream`, { method: "POST", body: JSON.stringify({ message: text }) }, text); }
    catch (error) { setNotice((error as Error).message); await refreshSessionState(selectedAssignmentId).catch(() => undefined); }
    finally { setSubmitting(false); setStreamingMessageId(undefined); }
  };

  const saveManualDraft = async () => {
    if (!selectedAssignmentId || !draft || !editedRubric) return;
    setSubmitting(true);
    try {
      const saved = await api<RubricDraft>(`/api/rubrics/assignments/${selectedAssignmentId}/draft`, { method: "PUT", body: JSON.stringify({ expectedVersion: draft.version, rubric: editedRubric }) });
      setDraft(saved); setEditing(false); setValidation(undefined); setFreezeReady(false); setNotice(`人工修改已保存为草稿 v${saved.version}。`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const validateForFreeze = async () => {
    if (!selectedAssignmentId || !draft) return;
    setSubmitting(true);
    try {
      const result = await api<RubricValidation>(`/api/rubrics/assignments/${selectedAssignmentId}/validate`, { method: "POST", body: JSON.stringify({ rubric: draft.rubric }) });
      setValidation(result); setFreezeReady(result.errors.length === 0); setNotice(result.errors.length ? "评分表仍有错误，修正后才能冻结。" : "校验通过，请确认冻结为正式版本。");
    } catch (error) { setFreezeReady(false); setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const freezeDraft = async () => {
    if (!selectedAssignmentId || !draft || !validation || validation.errors.length > 0) return;
    setSubmitting(true);
    try {
      const frozen = await api<FrozenRubric>(`/api/rubrics/assignments/${selectedAssignmentId}/freeze`, { method: "POST", body: JSON.stringify({ expectedVersion: draft.version, acknowledgedWarningCodes: validation.warnings.map((warning) => warning.code) }) });
      setDraft(undefined); setEditing(false); setFreezeReady(false); setValidation(undefined); setPreviewVersion(frozen.version); await refreshVersions(selectedAssignmentId); await refreshAssignments(); setNotice(`评分表 v${frozen.version} 已冻结，可正式应用。`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const createRevision = async (version: number) => {
    if (!selectedAssignmentId) return;
    setSubmitting(true);
    try {
      const revision = await api<RubricDraft>(`/api/rubrics/assignments/${selectedAssignmentId}/versions/${version}/revisions`, { method: "POST" });
      setDraft(revision); setPreviewVersion("draft"); setEditing(false); setValidation(undefined); setNotice(`已从冻结版本 v${version} 创建新的可编辑修订草稿。`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setSubmitting(false); }
  };

  const deleteAssignment = async () => {
    if (!assignmentToDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/rubrics/assignments/${assignmentToDelete.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "删除评分会话失败");
      const deletedSelectedAssignment = assignmentToDelete.id === selectedAssignmentId;
      setAssignmentToDelete(undefined);
      if (deletedSelectedAssignment) {
        window.location.assign("/rubrics");
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

  const chatContent = assignment && selectedMode ? <section className="rubric-chat">
    <div className="rubric-chat-heading"><div><h2>{assignment.title}</h2><p>{assignment.totalScore} 分 · {modeLabel[selectedMode]}</p></div><a href="/rubrics">新建评分表</a></div>
    <details className="rubric-context"><summary>作业要求与参考资料</summary>{assignment.requirements ? <p>{assignment.requirements}</p> : <p>未单独填写作业要求，将以参考资料为设计依据。</p>}{assignment.sources.length > 0 && <ul>{assignment.sources.map((item) => <li key={item.id}>{item.role === "rubric_draft" ? "评分草稿" : "设计备注"}：{item.name}</li>)}</ul>}</details>
    <div className="rubric-message-list" ref={messageListRef} aria-live="polite" onScroll={(event) => { const list = event.currentTarget; followStreamRef.current = shouldFollowRubricStream(list.scrollHeight - list.scrollTop - list.clientHeight); }}>{messages.length === 0 ? <div className="rubric-chat-welcome"><h3>{frozenWithoutDraft ? "当前评分表已冻结" : "继续设计评分表"}</h3><p>{frozenWithoutDraft ? "请从右侧历史版本创建修订后继续对话。" : "可以直接生成第一版，也可以先补充希望采用的评分维度。"}</p>{!frozenWithoutDraft && <button className="primary-button" type="button" disabled={submitting} onClick={() => void chooseMode(selectedMode)}>直接生成第一版评分表</button>}</div> : messages.map((message) => <article className={`rubric-chat-message ${message.role}`} key={message.id}>{message.role === "assistant" && <><ToolActivity steps={message.tools ?? []} streaming={streamingMessageId === message.id} title="评分表处理步骤" streamingTitle="正在设计评分表" />{message.process && <details className="assistant-process" open={streamingMessageId === message.id}><summary>模型处理过程 <small>安全摘要，完成后自动折叠</small></summary><p>{message.process}</p></details>}</>}<div className="rubric-message-content">{message.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown> : <p>{message.content}</p>}</div>{message.options && <div className="rubric-question-options">{message.options.map((option) => <button type="button" key={option} onClick={() => setChatInput(option)}>{option}</button>)}</div>}</article>)}</div>
    <form className="rubric-composer" onSubmit={(event) => void sendMessage(event)}><textarea value={chatInput} disabled={submitting || frozenWithoutDraft} onChange={(event) => setChatInput(event.target.value)} placeholder={frozenWithoutDraft ? "评分表已冻结，请先创建修订草稿。" : "告诉 Agent 需要调整的评分项目、分值、等级或扣分规则…"} /><button className="primary-button" disabled={submitting || frozenWithoutDraft || !chatInput.trim()} type="submit">发送</button></form>
  </section> : assignment ? <section className="rubric-mode-gate"><div className="rubric-session-heading"><div><p className="eyebrow">当前评分会话</p><h2>{assignment.title}</h2><p>{assignment.totalScore} 分 · {assignment.sources.length} 份参考资料</p></div><a href="/rubrics">新建评分表</a></div><details className="rubric-context"><summary>查看作业要求与参考资料</summary>{assignment.requirements ? <p>{assignment.requirements}</p> : <p>未单独填写作业要求，将以参考资料为设计依据。</p>}{assignment.sources.length > 0 && <ul>{assignment.sources.map((item) => <li key={item.id}>{item.name}</li>)}</ul>}</details><h3>先选择评分制度</h3><p>选择后会直接调用 Agent 生成第一版草稿，无需填写额外备注。</p><div className="rubric-mode-grid">{recommendations.length === 0 ? <p>正在生成评分制度建议…</p> : recommendations.map((item) => <article key={item.mode} className={item.recommended ? "recommended" : ""}><div><strong>{modeLabel[item.mode]}{item.recommended ? "（推荐）" : ""}</strong><p>{item.reason ?? item.benefit ?? "适用于当前评分场景。"}</p></div><button type="button" className={item.recommended ? "primary-button" : ""} disabled={submitting} onClick={() => void chooseMode(item.mode)}>选择并开始</button></article>)}</div></section> : <section className="rubric-create-panel"><div><p className="eyebrow">新评分会话</p><h2>创建评分表设计会话</h2><p>作业要求与参考资料至少填写一项；含参考资料时会由 AI 推荐评分制度。</p></div><form onSubmit={(event) => void createAssignment(event)} className="rubric-create-form"><label>会话名称<input required value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：AI 与生活的融合及挑战－作业报告评分表" /></label><label>总分<input required type="number" min="0.01" step="0.01" value={totalScore} onChange={(event) => setTotalScore(event.target.value)} /></label><label>作业要求（与参考资料至少填写一项）<textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="说明作业目标、提交要求和评分重点；如参考资料中已包含，可留空。" /></label><fieldset className="rubric-source-fieldset"><legend>参考资料（可选）</legend><label className="rubric-file-input">导入文件<input type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown" onChange={(event) => void readSourceFile(event.target.files?.[0])} /></label><span>{sourceName || "也可以直接粘贴文本"}</span><textarea value={source} onChange={(event) => { setSource(event.target.value); if (!event.target.value) setSourceName(""); }} placeholder="粘贴评分标准草稿或设计备注…" />{source.trim() && <label>资料类型<select value={sourceRole} onChange={(event) => setSourceRole(event.target.value as "rubric_draft" | "note")}><option value="rubric_draft">评分标准草稿</option><option value="note">设计备注</option></select></label>}</fieldset><div className="rubric-form-actions"><button className="primary-button" type="submit" disabled={submitting || !title.trim() || (!requirements.trim() && !source.trim())}>创建并选择评分制度</button></div></form></section>;

  const previewPanel = <aside className={`rubric-preview-panel ${previewFullscreen ? "fullscreen" : ""}`} aria-label="评分表预览"><div className="rubric-preview-toolbar"><div><h2>评分表预览</h2><span>{previewVersion === "draft" && draft ? `可编辑草稿 v${draft.version}` : selectedFrozen ? `冻结版本 v${selectedFrozen.version}` : "尚无草稿"}</span></div><div>{(draft || versions.length > 0) && <select aria-label="选择预览版本" value={previewVersion} onChange={(event) => { const value = event.target.value; setPreviewVersion(value === "draft" ? "draft" : Number(value)); setEditing(false); setValidation(undefined); }}><option value="draft" disabled={!draft}>当前草稿{draft ? ` v${draft.version}` : "（无）"}</option>{versions.map((version) => <option value={version.version} key={version.version}>冻结版本 v{version.version}</option>)}</select>}{draft && previewVersion === "draft" && <button type="button" onClick={() => { setEditing((value) => !value); setEditedRubric(structuredClone(draft.rubric)); }}>{editing ? "查看预览" : "人工编辑"}</button>}<button type="button" onClick={() => setPreviewFullscreen((value) => !value)}>{previewFullscreen ? "退出全屏" : "全屏预览"}</button></div></div><div className="rubric-preview-body">{previewRubric ? editing && draft && previewVersion === "draft" && editedRubric ? <RubricEditor rubric={editedRubric} onChange={setEditedRubric} /> : <RubricDocument rubric={previewRubric} /> : <div className="rubric-preview-empty"><strong>{assignment ? "等待评分表草稿" : "尚未开始设计"}</strong><p>{assignment ? "选择评分制度后，Agent 生成的草稿会显示在这里。" : "创建会话后，可在这里预览、编辑和冻结评分表。"}</p></div>}</div>{draft && previewVersion === "draft" && <footer className="rubric-preview-actions">{editing ? <><button type="button" onClick={() => { setEditing(false); setEditedRubric(structuredClone(draft.rubric)); }}>取消修改</button><button className="primary-button" type="button" disabled={submitting} onClick={() => void saveManualDraft()}>保存人工修改</button></> : <><button type="button" disabled={submitting} onClick={() => void validateForFreeze()}>校验并准备冻结</button>{freezeReady && <button className="primary-button" type="button" disabled={submitting} onClick={() => void freezeDraft()}>确认冻结为正式版本</button>}</>}{validation && <div className={`rubric-validation ${validation.errors.length ? "error" : "success"}`}><strong>{validation.errors.length ? `${validation.errors.length} 个错误` : "校验通过"}</strong>{[...validation.errors, ...validation.warnings].map((problem, index) => <p key={`${problem.code}-${index}`}>{problem.message}{problem.path ? `（${problem.path}）` : ""}</p>)}</div>}</footer>}{selectedFrozen && <footer className="rubric-preview-actions"><button type="button" disabled={submitting || Boolean(draft)} onClick={() => void createRevision(selectedFrozen.version)}>基于 v{selectedFrozen.version} 创建修订</button><a href={`/api/rubrics/assignments/${selectedAssignmentId}/versions/${selectedFrozen.version}/export.md`} download>导出 Markdown</a><a href={`/api/rubrics/assignments/${selectedAssignmentId}/versions/${selectedFrozen.version}/export.json`} download>导出 JSON</a><small>只有冻结版本才允许被正式应用。</small></footer>}</aside>;

  return <div className="rubric-page">
    <header className="rubric-page-header">
      <button className="rubric-session-toggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? "展开会话" : "收起会话"}</button>
      <div><p className="eyebrow">评分量表 Agent</p><h1>设计评分量表</h1><p>{notice}</p></div>
    </header>
    <section className={`rubric-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={workspaceStyle}>
      <aside className="rubric-session-list" aria-label="评分会话列表">
        <div className="rubric-pane-heading"><h2>评分会话</h2><span>{assignments.length}</span></div>
        <a className="rubric-new-session" href="/rubrics">＋ 新建评分表</a>
        {assignments.length === 0 ? <p className="rubric-empty">尚未创建评分会话。</p> : <nav>{assignments.map((item) => <div className={`rubric-session-row ${item.id === selectedAssignmentId ? "active" : ""}`} key={item.id}><a href={`/rubrics?assignment=${encodeURIComponent(item.id)}`}><strong>{item.title}</strong><small>{item.totalScore} 分 · {item.sources.length} 份参考资料</small></a><button type="button" aria-label={`删除评分会话：${item.title}`} title="删除评分会话" disabled={submitting || deleting} onClick={() => { setAssignmentToDelete(item); setDeleteError(""); }}>删除</button></div>)}</nav>}
      </aside>
      <section className="rubric-design-split" ref={splitRef}>
        <main className="rubric-start-panel">{chatContent}</main>
        <button className={`rubric-resizer ${dragging ? "dragging" : ""}`} type="button" aria-label="拖动调整会话与预览宽度" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }} />
        {previewPanel}
      </section>
    </section>
    {assignmentToDelete && <div className="modal-backdrop"><section className="session-modal" role="dialog" aria-modal="true" aria-labelledby="delete-rubric-session-title"><h2 id="delete-rubric-session-title">删除评分会话？</h2><p>{rubricDeleteWarning(assignmentToDelete.title)}</p>{deleteError && <p className="modal-error">{deleteError}</p>}<div className="modal-actions"><button type="button" disabled={deleting} onClick={() => { setAssignmentToDelete(undefined); setDeleteError(""); }}>取消</button><button className="danger-button" type="button" disabled={deleting} onClick={() => void deleteAssignment()}>{deleting ? "正在删除…" : "永久删除"}</button></div></section></div>}
  </div>;
}
