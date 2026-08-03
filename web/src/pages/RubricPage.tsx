import { type FormEvent, useEffect, useState } from "react";
import { withJsonHeaders } from "../lib/api";

type RubricAssignment = {
  id: string;
  title: string;
  totalScore: number;
  requirements: string;
  sources: Array<{ id: string; role: "rubric_draft" | "note"; name: string; size: number }>;
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "请求失败");
  return response.json() as Promise<T>;
}

export function RubricPage() {
  const [assignments, setAssignments] = useState<RubricAssignment[]>([]);
  const [title, setTitle] = useState("");
  const [totalScore, setTotalScore] = useState("100");
  const [requirements, setRequirements] = useState("");
  const [source, setSource] = useState("");
  const [sourceRole, setSourceRole] = useState<"rubric_draft" | "note">("rubric_draft");
  const [notice, setNotice] = useState("正在加载评分会话…");
  const [submitting, setSubmitting] = useState(false);

  const loadAssignments = async () => {
    try {
      const next = await api<RubricAssignment[]>("/api/rubrics/assignments");
      setAssignments(next);
      setNotice(next.length === 0 ? "创建第一个评分会话，开始设计量表。" : "选择一个会话继续设计，或创建新的评分表。");
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  useEffect(() => { void loadAssignments(); }, []);

  const createAssignment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const sourceContent = source.trim();
      const assignment = await api<RubricAssignment>("/api/rubrics/assignments", {
        method: "POST",
        body: JSON.stringify({
          title,
          totalScore: Number(totalScore),
          requirements,
          sources: sourceContent.length === 0 ? [] : [{ role: sourceRole, name: sourceRole === "rubric_draft" ? "评分标准草稿.txt" : "设计备注.txt", content: sourceContent }],
        }),
      });
      setAssignments((current) => [assignment, ...current]);
      setTitle("");
      setRequirements("");
      setSource("");
      setNotice(`“${assignment.title}” 已创建。下一步请选择评分制度。`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="rubric-page">
    <header className="workspace-header rubric-header"><div><p className="eyebrow">评分量表 Agent</p><h1>设计评分量表</h1><p>{notice}</p></div></header>
    <section className="rubric-workspace">
      <aside className="rubric-session-list" aria-label="评分会话列表">
        <div className="rubric-pane-heading"><h2>评分会话</h2><span>{assignments.length}</span></div>
        {assignments.length === 0 ? <p className="rubric-empty">尚未创建评分会话。</p> : <nav>{assignments.map((assignment) => <a key={assignment.id} href={`/rubrics?assignment=${encodeURIComponent(assignment.id)}`}><strong>{assignment.title}</strong><small>{assignment.totalScore} 分 · {assignment.sources.length} 份参考资料</small></a>)}</nav>}
      </aside>
      <main className="rubric-start-panel">
        <div><h2>新建评分会话</h2><p>先记录作业要求和可选的评分草稿或备注；创建后即可选择加分制、减分制或混合制。</p></div>
        <form onSubmit={(event) => void createAssignment(event)} className="rubric-create-form">
          <label>会话名称<input required value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：AI 与生活的融合及挑战 - 作业报告评分表" /></label>
          <label>总分<input required type="number" min="0.01" step="0.01" value={totalScore} onChange={(event) => setTotalScore(event.target.value)} /></label>
          <label>作业要求<textarea required value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="说明作业目标、提交要求和评分重点。" /></label>
          <label>参考内容（可选）<textarea value={source} onChange={(event) => setSource(event.target.value)} placeholder="粘贴评分标准草稿或备注；有内容时会用于生成评分制度建议。" /></label>
          {source.trim().length > 0 && <label>参考内容类型<select value={sourceRole} onChange={(event) => setSourceRole(event.target.value as "rubric_draft" | "note")}><option value="rubric_draft">评分标准草稿</option><option value="note">设计备注</option></select></label>}
          <div className="rubric-form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "创建中…" : "创建并选择评分制度"}</button></div>
        </form>
      </main>
      <aside className="rubric-preview-placeholder" aria-label="评分表预览">
        <div className="rubric-pane-heading"><h2>评分表预览</h2><span>草稿</span></div>
        <div><strong>尚未开始设计</strong><p>选定评分制度并与 Agent 对话后，这里会显示可编辑的评分表及历史冻结版本。</p></div>
      </aside>
    </section>
  </div>;
}
