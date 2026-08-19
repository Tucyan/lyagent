import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiErrorFromResponse, withJsonHeaders } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";
import { DecisionCards, DecisionEditor } from "./GradingPage";
import {
  batchReviewHref,
  batchStatusLabel,
  canConfirmBatchJob,
  canRetryBatchJob,
  formatBatchConfidence,
  formatBatchScore,
  type BatchJobCounts,
} from "./grading-batch-page-model";
import { clampBatchReviewReportPercent, parseBatchReviewLocation, selectBatchReviewSession } from "./grading-batch-review-page-model";

type BatchJob = {
  id: string;
  sessionId: string;
  studentName: string;
  studentNumber: string;
  submissionTitle: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  resultVersion?: number;
  score?: { earned: number; possible: number };
  confidence?: { overall: number; minimum: number; lowCount: number };
  reviewStatus?: "needs_review" | "confirmed";
  reviewReasons?: string[];
};
type Batch = {
  id: string;
  title: string;
  status: string;
  counts: BatchJobCounts;
  jobs: BatchJob[];
};
type Draft = {
  version: number;
  result: {
    score: { earned: number; possible: number };
    confidence: { overall: number; minimum: number; lowConfidenceCount: number };
    review: { requiresReview: boolean; reasons: string[] };
    decisions: Record<string, unknown>;
  };
};
type SessionDetail = {
  id: string;
  studentName: string;
  studentNumber: string;
  submissionTitle?: string;
  submission: { markdown: string; locked: boolean } | null;
  draft: Draft | null;
  confirmed: ({ resultHash: string } & Draft) | null;
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function GradingBatchReviewPage() {
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const [{ batchId, sessionId }, setRoute] = useState(() => parseBatchReviewLocation(window.location.search));
  const [batch, setBatch] = useState<Batch>();
  const [detail, setDetail] = useState<SessionDetail>();
  const [notice, setNotice] = useState("正在加载批次复核工作台…");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [editNote, setEditNote] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [acknowledgedReasons, setAcknowledgedReasons] = useState<string[]>([]);
  const [reportPercent, setReportPercent] = useState(52);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateRoute = () => {
      setLocationSearch(window.location.search);
      setRoute(parseBatchReviewLocation(window.location.search));
    };
    window.addEventListener("popstate", updateRoute);
    return () => window.removeEventListener("popstate", updateRoute);
  }, []);

  const refreshBatch = async (id = batchId) => {
    if (!id) return undefined;
    const next = await api<Batch>(`/api/grading/batches/${encodeURIComponent(id)}`);
    setBatch(next);
    return next;
  };
  const refreshSession = async (id = sessionId) => {
    if (!id) { setDetail(undefined); return undefined; }
    const next = await api<SessionDetail>(`/api/grading/sessions/${encodeURIComponent(id)}`);
    setDetail(next);
    return next;
  };

  useEffect(() => {
    if (!batchId) { setNotice("缺少批次参数，请从批量批改页进入 Review。"); return; }
    void refreshBatch(batchId).catch((error) => setNotice((error as Error).message));
  }, [batchId]);

  const selectedJob = useMemo(
    () => selectBatchReviewSession(batch?.jobs ?? [], sessionId),
    [batch, sessionId, locationSearch],
  );

  useEffect(() => {
    if (!batch || !selectedJob) return;
    if (selectedJob.sessionId !== sessionId) {
      navigateWithinApp(batchReviewHref(batch.id, selectedJob.sessionId), true);
      return;
    }
    void refreshSession(selectedJob.sessionId)
      .then(() => setNotice("可逐份核对报告与评分结果；修改后需填写修订备注。"))
      .catch((error) => setNotice((error as Error).message));
  }, [batch?.id, selectedJob?.sessionId, sessionId]);

  useEffect(() => {
    const current = detail?.draft ?? detail?.confirmed;
    if (current) setEdited(structuredClone(current.result.decisions));
    setEditing(false);
    setEditNote("");
    setReviewNote("");
    setAcknowledgedReasons([]);
  }, [detail?.id, detail?.draft?.version, detail?.confirmed?.version]);

  useEffect(() => {
    if (!batch || !batch.jobs.some(({ status }) => ["pending", "running"].includes(status))) return;
    const timer = window.setInterval(() => void refreshBatch(batch.id), 900);
    return () => window.clearInterval(timer);
  }, [batch?.id, batch?.jobs.map(({ status }) => status).join(",")]);

  const chooseSession = (nextSessionId: string) => {
    if (!batch || nextSessionId === selectedJob?.sessionId) return;
    navigateWithinApp(batchReviewHref(batch.id, nextSessionId));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !splitRef.current) return;
    const bounds = splitRef.current.getBoundingClientRect();
    setReportPercent(clampBatchReviewReportPercent((event.clientX - bounds.left) / bounds.width * 100));
  };
  const saveEdit = async () => {
    if (!detail?.draft || !editNote.trim()) return;
    setBusy(true);
    try {
      await api(`/api/grading/sessions/${detail.id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: detail.draft.version, draft: edited, note: editNote }),
      });
      await Promise.all([refreshSession(detail.id), batch && refreshBatch(batch.id)]);
      setNotice("评分修改已保存并重新计算总分与置信度。正式成绩尚未确认。 ");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (!batch || !selectedJob || !canRetryBatchJob(selectedJob)) return;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batch.id}/jobs/${selectedJob.id}/retry`, { method: "POST", body: "{}" });
      await refreshBatch(batch.id);
      setNotice(`${selectedJob.studentName} 已重新进入批改队列。`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!batch || !selectedJob || !detail?.draft || !canConfirmBatchJob(selectedJob)) return;
    const reasons = detail.draft.result.review.reasons;
    const allAcknowledged = reasons.every((reason) => acknowledgedReasons.includes(reason));
    if (detail.draft.result.review.requiresReview && (!reviewNote.trim() || !allAcknowledged)) return;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batch.id}/jobs/${selectedJob.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: detail.draft.version, reviewNote, acknowledgedReasons }),
      });
      await Promise.all([refreshSession(detail.id), refreshBatch(batch.id)]);
      setNotice(`${selectedJob.studentName} 的成绩已正式确认。`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };

  const result = detail?.confirmed ?? detail?.draft;
  const reasons = result?.result.review.reasons ?? [];
  const allAcknowledged = reasons.every((reason) => acknowledgedReasons.includes(reason));
  const confirmDisabled = busy || !selectedJob || !detail?.draft || !canConfirmBatchJob(selectedJob)
    || (detail.draft.result.review.requiresReview && (!reviewNote.trim() || !allAcknowledged));

  return <div className="batch-review-page">
    <header className="batch-review-header">
      <div><p className="eyebrow">批次 Review</p><h1>{batch?.title ?? "批次复核"}</h1><p>{notice}</p></div>
      <a href="/grading/batches">返回批量批改</a>
    </header>
    <div className="batch-review-layout">
      <aside className="batch-review-sidebar">
        <h2>本批次会话</h2>
        <nav>{batch?.jobs.map((job) => <button className={job.sessionId === selectedJob?.sessionId ? "active" : ""} key={job.id} type="button" onClick={() => chooseSession(job.sessionId)}>
          <span><strong>{job.studentName}</strong><small>{job.studentNumber}</small></span>
          <span><b>{formatBatchScore(job)}</b><small>置信度 {formatBatchConfidence(job)}</small></span>
          <em>{batchStatusLabel(job.status)}</em>
        </button>)}</nav>
      </aside>
      <main className="batch-review-main">
        {!selectedJob ? <section className="batch-empty"><h2>本批次暂无会话</h2></section> : <>
          <div className="batch-review-student"><div><h2>{selectedJob.studentName} · {selectedJob.submissionTitle}</h2><p>{selectedJob.studentNumber}</p></div><span>{formatBatchScore(selectedJob)} · 置信度 {formatBatchConfidence(selectedJob)}</span></div>
          <div className="batch-review-split" ref={splitRef} style={{ gridTemplateColumns: `${reportPercent}fr 8px ${100 - reportPercent}fr` }}>
            <section className="batch-review-report"><header><h3>学生报告</h3></header>{detail?.submission ? <Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ src = "", ...props }) => <img {...props} src={src.startsWith("assets/") ? `/api/grading/sessions/${detail.id}/assets/${encodeURIComponent(src.slice("assets/".length))}` : src} /> }}>{detail.submission.markdown}</Markdown> : <p>报告尚未准备完成。</p>}</section>
            <div className="batch-review-resizer" role="separator" aria-label="调整报告与评分结果宽度" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(reportPercent)} tabIndex={0} onPointerDown={startResize} onPointerMove={resize} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setReportPercent((value) => clampBatchReviewReportPercent(value + (event.key === "ArrowLeft" ? -2 : 2))); } }} />
            <section className="batch-review-result"><header><div><h3>评分结果</h3>{result && <strong>{result.result.score.earned}/{result.result.score.possible}</strong>}</div>{result && <span>整体置信度 {Math.round(result.result.confidence.overall * 100)}%</span>}</header>
              {!result ? <p>尚无评分结果。</p> : <>
                {result.result.review.requiresReview && <section className="review-alert"><strong>请确认全部复核原因</strong>{reasons.map((reason) => <label key={reason}><input type="checkbox" checked={acknowledgedReasons.includes(reason)} onChange={(event) => setAcknowledgedReasons(event.target.checked ? [...acknowledgedReasons, reason] : acknowledgedReasons.filter((item) => item !== reason))} />{reason}</label>)}</section>}
                {editing && detail?.draft ? <DecisionEditor decisions={edited} onChange={setEdited} /> : <DecisionCards decisions={result.result.decisions} sessionId={detail?.id ?? selectedJob.sessionId} />}
                {editing && <section className="batch-review-edit-actions"><label>修改备注<textarea value={editNote} onChange={(event) => setEditNote(event.target.value)} /></label><div><button type="button" onClick={() => setEditing(false)}>取消修改</button><button type="button" disabled={busy || !editNote.trim()} onClick={() => void saveEdit()}>保存修改</button></div></section>}
                {!editing && detail?.draft && <button type="button" onClick={() => setEditing(true)}>修改评分结果</button>}
                {detail?.draft && <label className="batch-review-note">复核备注<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>}
              </>}
              <footer><button type="button" disabled={busy || !selectedJob || !canRetryBatchJob(selectedJob)} onClick={() => void retry()}>重试</button><button className="primary-button" type="button" disabled={confirmDisabled} onClick={() => void confirm()}>确认</button></footer>
            </section>
          </div>
        </>}
      </main>
    </div>
  </div>;
}
