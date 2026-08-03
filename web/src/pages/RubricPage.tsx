import { type FormEvent, useEffect, useState } from "react";
import { withJsonHeaders } from "../lib/api";
import { consumeSse } from "../lib/consume-sse";
import { assignmentIdFromSearch, loadRubricSession } from "./rubric-page-model";

type RubricMode = "additive" | "deductive" | "hybrid";
type RubricAssignment = { id: string; title: string; totalScore: number; requirements: string; sources: Array<{ id: string; role: "rubric_draft" | "note"; name: string; size: number }> };
type Recommendation = { mode: RubricMode; recommended: boolean; reason?: string; benefit?: string };
type RubricDraft = { version: number; updatedAt: string; rubric: unknown };
type ChatMessage = { role: "user" | "assistant"; content: string };

const modeLabel: Record<RubricMode, string> = { additive: "加分制", deductive: "减分制", hybrid: "混合制" };

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "请求失败");
  return response.json() as Promise<T>;
}

export function RubricPage() {
  const selectedAssignmentId = assignmentIdFromSearch(window.location.search);
  const [assignments, setAssignments] = useState<RubricAssignment[]>([]);
  const [assignment, setAssignment] = useState<RubricAssignment>();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [selectedMode, setSelectedMode] = useState<RubricMode>();
  const [draft, setDraft] = useState<RubricDraft>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [title, setTitle] = useState("");
  const [totalScore, setTotalScore] = useState("100");
  const [requirements, setRequirements] = useState("");
  const [source, setSource] = useState("");
  const [sourceRole, setSourceRole] = useState<"rubric_draft" | "note">("rubric_draft");
  const [notice, setNotice] = useState("正在加载评分会话…");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api<RubricAssignment[]>("/api/rubrics/assignments").then((next) => {
      setAssignments(next);
      if (!selectedAssignmentId) setNotice(next.length === 0 ? "创建第一个评分会话，开始设计量表。" : "选择一个会话继续设计，或创建新的评分表。");
    }).catch((error: Error) => setNotice(error.message));
  }, [selectedAssignmentId]);

  useEffect(() => {
    if (!selectedAssignmentId) {
      setAssignment(undefined);
      return;
    }
    setNotice("正在加载所选评分会话…");
    setSelectedMode(undefined);
    setDraft(undefined);
    setMessages([]);
    setRecommendations([]);
    void loadRubricSession({
      assignment: () => api<RubricAssignment>(`/api/rubrics/assignments/${selectedAssignmentId}`),
      draft: () => api<RubricDraft | null>(`/api/rubrics/assignments/${selectedAssignmentId}/draft`),
      recommendations: () => api<{ options: Recommendation[] }>(`/api/rubrics/assignments/${selectedAssignmentId}/recommendations`),
      onCore: (nextAssignment, nextDraft) => {
        setAssignment(nextAssignment);
        setDraft(nextDraft ?? undefined);
        setNotice(nextDraft ? "已打开会话草稿，可继续让 Agent 调整评分标准。" : "正在加载评分制度建议…");
      },
      onRecommendations: (recommendation) => {
        setRecommendations(recommendation.options);
        setNotice("请选择评分制度后，再开始与 Agent 设计评分表。");
      },
    }).catch((error: Error) => setNotice(error.message));
  }, [selectedAssignmentId]);

  const createAssignment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const sourceContent = source.trim();
      const created = await api<RubricAssignment>("/api/rubrics/assignments", {
        method: "POST",
        body: JSON.stringify({ title, totalScore: Number(totalScore), requirements, sources: sourceContent ? [{ role: sourceRole, name: sourceRole === "rubric_draft" ? "评分标准草稿.txt" : "设计备注.txt", content: sourceContent }] : [] }),
      });
      window.location.assign(`/rubrics?assignment=${encodeURIComponent(created.id)}`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const chooseMode = async (mode: RubricMode) => {
    if (!selectedAssignmentId) return;
    setSubmitting(true);
    try {
      await api(`/api/rubrics/assignments/${selectedAssignmentId}/mode`, { method: "PUT", body: JSON.stringify({ mode }) });
      setSelectedMode(mode);
      setNotice(`已选择${modeLabel[mode]}。现在可以告诉 Agent 你希望评分表如何设计。`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAssignmentId || !selectedMode || !chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/rubrics/assignments/${selectedAssignmentId}/messages/stream`, withJsonHeaders({ method: "POST", body: JSON.stringify({ message: text }) }));
      if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "设计请求失败");
      await consumeSse(response, (eventName, value) => {
        const event = value as { message?: string };
        if (eventName === "draft") void api<RubricDraft | null>(`/api/rubrics/assignments/${selectedAssignmentId}/draft`).then((nextDraft) => setDraft(nextDraft ?? undefined));
        if (eventName === "question" || eventName === "final" || eventName === "error") {
          const content = eventName === "question" ? "Agent 需要补充信息后才能更新评分表。" : event.message ?? "评分表草稿已更新。";
          setMessages((current) => [...current, { role: "assistant", content }]);
          setNotice(content);
        }
      });
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const activeContent = assignment ? <>
    <div className="rubric-session-heading"><div><p className="eyebrow">当前评分会话</p><h2>{assignment.title}</h2><p>{assignment.totalScore} 分 · {assignment.sources.length} 份参考资料</p></div><a href="/rubrics">新建评分表</a></div>
    <details className="rubric-context"><summary>查看作业要求与参考资料</summary><p>{assignment.requirements}</p>{assignment.sources.length > 0 && <ul>{assignment.sources.map((item) => <li key={item.id}>{item.role === "rubric_draft" ? "评分草稿" : "设计备注"}：{item.name}</li>)}</ul>}</details>
    {!selectedMode ? <section className="rubric-mode-gate"><h3>先选择评分制度</h3><p>选择后才会启用正式对话；带有参考内容的会话会展示 Agent 的推荐。</p><div className="rubric-mode-grid">{recommendations.length === 0 ? <p>正在生成评分制度建议…</p> : recommendations.map((item) => <article key={item.mode} className={item.recommended ? "recommended" : ""}><div><strong>{modeLabel[item.mode]}{item.recommended ? "（推荐）" : ""}</strong><p>{item.reason ?? item.benefit ?? "适用于当前评分场景。"}</p></div><button type="button" className={item.recommended ? "primary-button" : ""} disabled={submitting} onClick={() => void chooseMode(item.mode)}>选择{modeLabel[item.mode]}</button></article>)}</div></section> : <section className="rubric-chat"><div><h3>与评分表 Agent 对话</h3><span>{modeLabel[selectedMode]}</span></div><div className="rubric-message-list">{messages.length === 0 ? <p>请描述你希望的评分维度、权重、扣分规则或等级锚点。</p> : messages.map((message, index) => <p key={`${message.role}-${index}`} className={message.role}>{message.content}</p>)}</div><form onSubmit={(event) => void sendMessage(event)}><textarea value={chatInput} disabled={submitting} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：按论证质量、案例分析和表达规范设计 100 分评分表。" /><button className="primary-button" disabled={submitting || !chatInput.trim()} type="submit">发送</button></form></section>}
  </> : <>
    <div><h2>新建评分会话</h2><p>先记录作业要求和可选的评分草稿或备注；创建后即可选择评分制度。</p></div>
    <form onSubmit={(event) => void createAssignment(event)} className="rubric-create-form"><label>会话名称<input required value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：AI 与生活的融合及挑战 - 作业报告评分表" /></label><label>总分<input required type="number" min="0.01" step="0.01" value={totalScore} onChange={(event) => setTotalScore(event.target.value)} /></label><label>作业要求<textarea required value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="说明作业目标、提交要求和评分重点。" /></label><label>参考内容（可选）<textarea value={source} onChange={(event) => setSource(event.target.value)} placeholder="粘贴评分标准草稿或备注；有内容时会用于生成评分制度建议。" /></label>{source.trim() && <label>参考内容类型<select value={sourceRole} onChange={(event) => setSourceRole(event.target.value as "rubric_draft" | "note")}><option value="rubric_draft">评分标准草稿</option><option value="note">设计备注</option></select></label>}<div className="rubric-form-actions"><button className="primary-button" type="submit" disabled={submitting}>创建并选择评分制度</button></div></form>
  </>;

  return <div className="rubric-page"><header className="workspace-header rubric-header"><div><p className="eyebrow">评分量表 Agent</p><h1>设计评分量表</h1><p>{notice}</p></div></header><section className="rubric-workspace"><aside className="rubric-session-list" aria-label="评分会话列表"><div className="rubric-pane-heading"><h2>评分会话</h2><span>{assignments.length}</span></div>{assignments.length === 0 ? <p className="rubric-empty">尚未创建评分会话。</p> : <nav>{assignments.map((item) => <a key={item.id} className={item.id === selectedAssignmentId ? "active" : ""} href={`/rubrics?assignment=${encodeURIComponent(item.id)}`}><strong>{item.title}</strong><small>{item.totalScore} 分 · {item.sources.length} 份参考资料</small></a>)}</nav>}</aside><main className="rubric-start-panel">{activeContent}</main><aside className="rubric-preview-placeholder" aria-label="评分表预览"><div className="rubric-pane-heading"><h2>评分表预览</h2><span>{draft ? `草稿 v${draft.version}` : "草稿"}</span></div>{draft ? <pre className="rubric-draft-preview">{JSON.stringify(draft.rubric, null, 2)}</pre> : <div><strong>{assignment ? "等待评分表草稿" : "尚未开始设计"}</strong><p>{assignment ? "选择评分制度并开始对话后，Agent 生成的评分表会显示在这里。" : "选定评分制度并与 Agent 对话后，这里会显示可编辑的评分表及历史冻结版本。"}</p></div>}</aside></section></div>;
}
