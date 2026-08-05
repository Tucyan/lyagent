import { useEffect, useMemo, useState, type FormEvent } from "react";
import { withJsonHeaders } from "../lib/api";
import { batchActions, batchProgress, batchStatusLabel, shouldPollBatch, waitForBatchSessionsReady, type BatchJobCounts } from "./grading-batch-page-model";

type FrozenRubric = { assignmentId: string; title: string; version: number };
type BatchJob = {
  id: string;
  sessionId: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode?: string;
  question?: string;
};
type Batch = {
  id: string;
  title: string;
  assignmentId: string;
  rubricVersion: number;
  status: string;
  concurrency: number;
  totalJobs: number;
  counts: BatchJobCounts;
  jobs?: BatchJob[];
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(body.message ?? "请求失败");
  }
  return response.json() as Promise<T>;
}

export function GradingBatchPage() {
  const [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const [rubricKey, setRubricKey] = useState(localStorage.getItem("batch-grading-rubric") ?? "");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Batch>();
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("班级批量批改");
  const [concurrency, setConcurrency] = useState(4);
  const [notice, setNotice] = useState("正在加载批次…");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const selectedRubric = useMemo(() => rubrics.find((rubric) => `${rubric.assignmentId}:${rubric.version}` === rubricKey), [rubrics, rubricKey]);

  const refreshList = async (rubric = selectedRubric) => {
    const next = rubric ? await api<Batch[]>(`/api/grading/batches?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`) : [];
    setBatches(next);
    if (!selectedId && next[0]) setSelectedId(next[0].id);
    return next;
  };
  const refreshDetail = async (id = selectedId) => {
    if (!id) { setDetail(undefined); return; }
    const next = await api<Batch>(`/api/grading/batches/${id}`);
    setDetail(next);
    return next;
  };

  useEffect(() => {
    void (async () => {
      try {
        const nextRubrics = await api<FrozenRubric[]>("/api/grading/rubrics");
        setRubrics(nextRubrics);
        const key = rubricKey || (nextRubrics[0] ? `${nextRubrics[0].assignmentId}:${nextRubrics[0].version}` : "");
        setRubricKey(key);
        const rubric = nextRubrics.find((item) => `${item.assignmentId}:${item.version}` === key);
        await refreshList(rubric);
        setNotice("选择 30–120 份报告创建批次；批次运行不会自动确认正式成绩。");
      } catch (error) { setNotice((error as Error).message); }
    })();
  }, []);
  useEffect(() => { void refreshDetail(); }, [selectedId]);
  useEffect(() => {
    if (!detail || !shouldPollBatch(detail)) return;
    const timer = window.setInterval(() => void Promise.all([refreshDetail(detail.id), refreshList()]), 800);
    return () => window.clearInterval(timer);
  }, [detail?.id, detail?.status, rubricKey]);

  const chooseRubric = async (key: string) => {
    setRubricKey(key);
    localStorage.setItem("batch-grading-rubric", key);
    setSelectedId(undefined);
    setDetail(undefined);
    const rubric = rubrics.find((item) => `${item.assignmentId}:${item.version}` === key);
    await refreshList(rubric);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedRubric || files.length < 30 || files.length > 120) return;
    setBusy(true);
    try {
      setNotice(`正在上传 0/${files.length}…`);
      let uploaded = 0;
      const sessionIds: string[] = [];
      const pending = [...files];
      const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
        while (pending.length) {
          const file = pending.shift();
          if (!file) return;
          const form = new FormData();
          form.set("assignmentId", selectedRubric.assignmentId);
          form.set("rubricVersion", String(selectedRubric.version));
          form.set("studentName", "");
          form.set("studentNumber", "");
          form.set("submissionTitle", file.name.replace(/\.[^.]+$/, ""));
          form.set("autoStartAfterConversion", "false");
          form.set("file", file);
          const response = await fetch("/api/grading/sessions", { method: "POST", body: form });
          if (!response.ok) throw new Error((await response.json().catch(() => ({ message: file.name }))).message ?? `${file.name} 上传失败`);
          sessionIds.push((await response.json()).id);
          uploaded += 1;
          setNotice(`正在上传 ${uploaded}/${files.length}…`);
        }
      });
      await Promise.all(workers);
      setNotice(`已上传 ${files.length}/${files.length}，正在等待转换与命名…`);
      await waitForBatchSessionsReady(sessionIds, (id) => api(`/api/grading/sessions/${id}`));
      const batch = await api<Batch>("/api/grading/batches", {
        method: "POST",
        body: JSON.stringify({ title, assignmentId: selectedRubric.assignmentId, rubricVersion: selectedRubric.version, concurrency, sessionIds }),
      });
      setFiles([]);
      setSelectedId(batch.id);
      await refreshList();
      setNotice("批次已创建，确认后可启动并发批改。");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const command = async (action: "start" | "pause" | "resume") => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${detail.id}/${action}`, { method: "POST", body: "{}" });
      await Promise.all([refreshDetail(detail.id), refreshList()]);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const jobCommand = async (job: BatchJob, action: "retry" | "answer") => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${detail.id}/jobs/${job.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "answer" ? { answer: answers[job.id] ?? "" } : {}),
      });
      await refreshDetail(detail.id);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const progress = detail ? batchProgress(detail) : undefined;
  const actions = detail ? batchActions(detail) : undefined;

  return <div className="batch-grading-page">
    <header className="batch-grading-header">
      <div><p className="eyebrow">M5 · 并发工作台</p><h1>批量作业批改</h1><p>{notice}</p></div>
      <a href="/grading">返回单份批改</a>
    </header>
    <div className="batch-grading-layout">
      <aside className="batch-grading-sidebar">
        <label>评分标准<select aria-label="批量评分标准" value={rubricKey} onChange={(event) => void chooseRubric(event.target.value)}>
          <option value="">选择冻结评分标准</option>{rubrics.map((rubric) => <option key={`${rubric.assignmentId}:${rubric.version}`} value={`${rubric.assignmentId}:${rubric.version}`}>{rubric.title} · v{rubric.version}</option>)}
        </select></label>
        <nav>{batches.map((batch) => <button className={selectedId === batch.id ? "active" : ""} key={batch.id} type="button" onClick={() => setSelectedId(batch.id)}><strong>{batch.title}</strong><span>{batchStatusLabel(batch.status)} · {batch.totalJobs} 份</span></button>)}</nav>
      </aside>
      <main className="batch-grading-main">
        <form className="batch-create-card" onSubmit={create}>
          <div><h2>创建新批次</h2><p>上传 30–120 份 Markdown、DOCX 或 PDF；文件名用于识别学生。</p></div>
          <label>批次名称<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>并发数<select aria-label="并发数" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="batch-file-input">学生报告<input aria-label="选择学生报告" type="file" multiple accept=".md,.docx,.pdf" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /><span>{files.length ? `已选择 ${files.length} 份` : "尚未选择文件"}</span></label>
          <button className="primary-button" disabled={busy || !selectedRubric || files.length < 30 || files.length > 120} type="submit">创建批次</button>
        </form>
        {detail ? <section className="batch-detail">
          <header><div><p className="eyebrow">{batchStatusLabel(detail.status)}</p><h2>{detail.title}</h2><p>并发 {detail.concurrency} · {progress?.settled}/{detail.totalJobs} 已结束本轮处理</p></div><strong>{progress?.percent}%</strong></header>
          <div className="batch-progress"><i style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <div className="batch-controls">
            {actions?.canStart && <button disabled={busy} onClick={() => void command("start")}>启动批改</button>}
            {actions?.canPause && <button disabled={busy} onClick={() => void command("pause")}>暂停领取</button>}
            {actions?.canResume && <button disabled={busy} onClick={() => void command("resume")}>恢复批改</button>}
            {actions?.canExport && <a className="button-link" href={`/api/grading/batches/${detail.id}/export.csv`}>导出班级 CSV</a>}
          </div>
          <div className="batch-counts">{Object.entries(detail.counts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{batchStatusLabel(status)} <strong>{count}</strong></span>)}</div>
          <div className="batch-job-table"><table><thead><tr><th>学生</th><th>作业</th><th>状态</th><th>尝试</th><th>操作</th></tr></thead><tbody>
            {detail.jobs?.map((job) => <tr key={job.id}><td>{job.studentName}<small>{job.studentNumber}</small></td><td><a href={`/grading?session=${encodeURIComponent(job.sessionId)}`}>{job.submissionTitle}</a></td><td><span className={`batch-status ${job.status}`}>{batchStatusLabel(job.status)}</span>{job.lastErrorCode && <small>{job.lastErrorCode}</small>}</td><td>{job.attemptCount}/{job.maxAttempts}</td><td>{job.status === "failed" && job.attemptCount < job.maxAttempts ? <button disabled={busy} onClick={() => void jobCommand(job, "retry")}>重试</button> : job.status === "waiting_for_teacher" ? <div className="batch-answer"><span>{job.question}</span><input aria-label={`回答 ${job.studentName}`} value={answers[job.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [job.id]: event.target.value })} /><button disabled={busy || !(answers[job.id] ?? "").trim()} onClick={() => void jobCommand(job, "answer")}>回答</button></div> : "—"}</td></tr>)}
          </tbody></table></div>
        </section> : <section className="batch-empty"><h2>选择或创建批次</h2><p>批量任务拥有独立队列，不会改变单份批改会话的交互。</p></section>}
      </main>
    </div>
  </div>;
}
