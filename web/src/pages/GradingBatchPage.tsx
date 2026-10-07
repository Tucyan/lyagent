import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import {
  batchActions,
  batchProgress,
  batchReviewHref,
  batchStatusLabel,
  batchUploadItemStatusLabel,
  applyUploadDraftResponse,
  canCommitBatchUpload,
  canConfirmFromBatchList,
  canRetryBatchJob,
  completeCommittedUploadDraftRestore,
  formatBatchConfidence,
  formatBatchScore,
  shouldPollBatch,
  shouldPollBatchUpload,
  UploadDraftRequestTracker,
  type BatchJobCounts,
} from "./grading-batch-page-model";
import { buildAssetManifest } from "./grading-page-model";

type FrozenRubric = { assignmentId: string; title: string; version: number };
type BatchJob = {
  id: string; sessionId: string; studentName: string; studentNumber: string;
  submissionTitle: string; status: string; attemptCount: number; maxAttempts: number;
  lastErrorCode?: string; question?: string; resultVersion?: number;
  score?: { earned: number; possible: number };
  confidence?: { overall: number; minimum: number; lowCount: number };
  reviewStatus?: "needs_review" | "confirmed"; requiresReview?: boolean; reviewReasons?: string[];
};
type Batch = {
  id: string; title: string; assignmentId: string; rubricVersion: number; status: string;
  concurrency: number; totalJobs: number; counts: BatchJobCounts; jobs?: BatchJob[];
};
type BatchUploadItem = {
  id: string; filename: string; status: string; studentName?: string; studentNumber?: string;
  sessionId?: string; errorCode?: string; errorMessage?: string;
};
type BatchUpload = {
  id: string; title: string; assignmentId: string; rubricVersion: number; concurrency: number;
  status: string; committedBatchId?: string; items: BatchUploadItem[];
};

const DRAFT_STORAGE_KEY = "batch-grading-upload-draft";

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function GradingBatchPage() {
  const [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const [rubricKey, setRubricKey] = useState(localStorage.getItem("batch-grading-rubric") ?? "");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Batch>();
  const [uploadDraft, setUploadDraft] = useState<BatchUpload>();
  const [files, setFiles] = useState<File[]>([]);
  const [assetFiles, setAssetFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("班级批量批改");
  const [concurrency, setConcurrency] = useState(4);
  const [notice, setNotice] = useState("正在加载批次…");
  const [busy, setBusy] = useState(false);
  const [retryingItemId, setRetryingItemId] = useState<string>();
  const [retryingJobId, setRetryingJobId] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [identities, setIdentities] = useState<Record<string, { studentName: string; studentNumber: string }>>({});
  const listGate = useRef(new LatestRequestGate());
  const detailGate = useRef(new LatestRequestGate());
  const draftGate = useRef(new LatestRequestGate());
  const selectedIdRef = useRef(selectedId);
  const uploadDraftIdRef = useRef(new UploadDraftRequestTracker());
  selectedIdRef.current = selectedId;
  const selectedRubric = useMemo(
    () => rubrics.find((rubric) => `${rubric.assignmentId}:${rubric.version}` === rubricKey),
    [rubrics, rubricKey],
  );

  const refreshList = async (rubric = selectedRubric) => {
    const lease = listGate.current.begin();
    const next = rubric
      ? await api<Batch[]>(`/api/grading/batches?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`)
      : [];
    if (!lease.isCurrent()) return undefined;
    setBatches(next);
    if (!selectedIdRef.current && next[0]) {
      selectedIdRef.current = next[0].id;
      setSelectedId(next[0].id);
    }
    return next;
  };
  const refreshDetail = async (id = selectedId) => {
    const lease = detailGate.current.begin();
    if (!id) {
      if (lease.isCurrent()) setDetail(undefined);
      return undefined;
    }
    const next = await api<Batch>(`/api/grading/batches/${id}`);
    if (!lease.isCurrent() || id !== selectedIdRef.current) return undefined;
    setDetail(next);
    return next;
  };
  const refreshDraft = async (id = uploadDraft?.id) => {
    const lease = draftGate.current.begin();
    if (!id) return undefined;
    const next = await api<BatchUpload>(`/api/grading/batch-uploads/${id}`);
    if (!lease.isCurrent() || !applyUploadDraftResponse(uploadDraftIdRef.current, id, next, setUploadDraft)) return undefined;
    return next;
  };

  useEffect(() => {
    void (async () => {
      try {
        const nextRubrics = await api<FrozenRubric[]>("/api/grading/rubrics");
        setRubrics(nextRubrics);
        const key = rubricKey || (nextRubrics[0] ? `${nextRubrics[0].assignmentId}:${nextRubrics[0].version}` : "");
        setRubricKey(key);
        await refreshList(nextRubrics.find((item) => `${item.assignmentId}:${item.version}` === key));
        const draftId = localStorage.getItem(DRAFT_STORAGE_KEY);
        if (draftId) {
          try {
            uploadDraftIdRef.current.set(draftId);
            const restored = await refreshDraft(draftId);
            const wasAlreadyCommitted = restored && completeCommittedUploadDraftRestore(restored, uploadDraftIdRef.current, {
              invalidateRequests: () => draftGate.current.invalidate(),
              removeStoredDraft: () => localStorage.removeItem(DRAFT_STORAGE_KEY),
              clearDraft: () => setUploadDraft(undefined),
              selectBatch: (id) => {
                selectedIdRef.current = id;
                setSelectedId(id);
              },
            });
            if (!wasAlreadyCommitted) setNotice("已恢复上次未完成的批次上传草稿。");
          } catch {
            if (localStorage.getItem(DRAFT_STORAGE_KEY) === draftId && uploadDraftIdRef.current.matches(draftId)) {
              localStorage.removeItem(DRAFT_STORAGE_KEY);
            }
          }
        } else setNotice("选择 1–120 份报告创建可恢复的上传草稿。");
      } catch (error) { setNotice((error as Error).message); }
    })();
  }, []);
  useEffect(() => {
    const id = selectedId;
    void refreshDetail(id).catch((error) => {
      if (id === selectedIdRef.current) setNotice((error as Error).message);
    });
  }, [selectedId]);
  useEffect(() => {
    if (!detail || !shouldPollBatch(detail)) return;
    return startSerialPolling(
      async () => {
        const next = await refreshDetail(detail.id);
        if (next) await refreshList();
      },
      {
        intervalMs: 800,
        onError: (error) => setNotice((error as Error).message),
      },
    );
  }, [detail?.id, detail?.status, rubricKey]);
  useEffect(() => {
    if (!uploadDraft || !shouldPollBatchUpload(uploadDraft)) return;
    return startSerialPolling(
      async () => {
        await refreshDraft(uploadDraft.id);
      },
      {
        intervalMs: 800,
        onError: (error) => setNotice((error as Error).message),
      },
    );
  }, [uploadDraft?.id, uploadDraft?.status, uploadDraft?.items.map(({ status }) => status).join(",")]);

  const chooseRubric = async (key: string) => {
    setRubricKey(key);
    localStorage.setItem("batch-grading-rubric", key);
    selectedIdRef.current = undefined;
    detailGate.current.invalidate();
    setSelectedId(undefined);
    setDetail(undefined);
    try {
      await refreshList(rubrics.find((item) => `${item.assignmentId}:${item.version}` === key));
    } catch (error) {
      setNotice((error as Error).message);
    }
  };
  const chooseBatch = (id: string) => {
    selectedIdRef.current = id;
    detailGate.current.invalidate();
    setSelectedId(id);
    setDetail((current) => current?.id === id ? current : undefined);
  };
  const uploadItem = async (draft: BatchUpload, item: BatchUploadItem, file: File) => {
    const manifest = buildAssetManifest(assetFiles);
    const form = new FormData();
    form.set("file", file);
    assetFiles.forEach((asset) => form.append("asset", asset));
    form.set("assetManifest", JSON.stringify(manifest));
    const response = await apiFetch(`/api/grading/batch-uploads/${draft.id}/items/${item.id}/file`, { method: "PUT", body: form });
    if (!response.ok) throw await apiErrorFromResponse(response, `${file.name} 上传失败`);
    return response.json() as Promise<BatchUploadItem>;
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedRubric || files.length < 1 || files.length > 120) return;
    setBusy(true);
    try {
      buildAssetManifest(assetFiles);
      const draft = await api<BatchUpload>("/api/grading/batch-uploads", {
        method: "POST",
        body: JSON.stringify({
          title, assignmentId: selectedRubric.assignmentId, rubricVersion: selectedRubric.version,
          concurrency, items: files.map(({ name }) => ({ filename: name })),
        }),
      });
      uploadDraftIdRef.current.set(draft.id);
      setUploadDraft(draft);
      localStorage.setItem(DRAFT_STORAGE_KEY, draft.id);
      let completed = 0;
      const queue = draft.items.map((item, index) => ({ item, file: files[index]! }));
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const next = queue.shift();
          if (!next) return;
          try { await uploadItem(draft, next.item, next.file); }
          catch (error) { setNotice((error as Error).message); }
          finally {
            completed += 1;
            setNotice(`已处理上传 ${completed}/${files.length}；失败项可单独补填或重试。`);
          }
        }
      });
      await Promise.allSettled(workers);
      await refreshDraft(draft.id);
      setFiles([]);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const patchIdentity = async (item: BatchUploadItem) => {
    if (!uploadDraft) return;
    const identity = identities[item.id] ?? { studentName: item.studentName ?? "", studentNumber: item.studentNumber ?? "" };
    setBusy(true);
    try {
      await api(`/api/grading/batch-uploads/${uploadDraft.id}/items/${item.id}/identity`, { method: "PATCH", body: JSON.stringify(identity) });
      await refreshDraft(uploadDraft.id);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const draftItemCommand = async (item: BatchUploadItem, action: "retry" | "remove") => {
    if (!uploadDraft) return;
    if (action === "retry") setRetryingItemId(item.id);
    setBusy(true);
    try {
      await api(`/api/grading/batch-uploads/${uploadDraft.id}/items/${item.id}${action === "retry" ? "/retry" : ""}`, { method: action === "retry" ? "POST" : "DELETE", ...(action === "retry" ? { body: "{}" } : {}) });
      await refreshDraft(uploadDraft.id);
    } catch (error) { setNotice((error as Error).message); }
    finally { if (action === "retry") setRetryingItemId(undefined); setBusy(false); }
  };
  const commitDraft = async () => {
    if (!uploadDraft) return;
    setBusy(true);
    try {
      const batch = await api<Batch>(`/api/grading/batch-uploads/${uploadDraft.id}/commit`, { method: "POST", body: "{}" });
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      uploadDraftIdRef.current.set(undefined);
      setUploadDraft(undefined);
      selectedIdRef.current = batch.id;
      setSelectedId(batch.id);
      await refreshList();
      setNotice("正式批次已创建，上传进度已安全保存。");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const cancelDraft = async () => {
    if (!uploadDraft) return;
    setBusy(true);
    try {
      const result = await api<{ preservedSessionIds: string[] }>(`/api/grading/batch-uploads/${uploadDraft.id}`, { method: "DELETE" });
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      uploadDraftIdRef.current.set(undefined);
      setUploadDraft(undefined);
      setNotice(result.preservedSessionIds.length ? `草稿已取消；已创建的 ${result.preservedSessionIds.length} 个会话已保留。` : "草稿和未使用的暂存文件已删除。");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const command = async (action: "start" | "pause" | "resume") => {
    if (!detail) return;
    const batchId = detail.id;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batchId}/${action}`, { method: "POST", body: "{}" });
      if (selectedIdRef.current === batchId) await Promise.all([refreshDetail(batchId), refreshList()]);
    } catch (error) { if (selectedIdRef.current === batchId) setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const jobCommand = async (job: BatchJob, action: "retry" | "answer") => {
    if (!detail) return;
    const batchId = detail.id;
    if (action === "retry") setRetryingJobId(job.id);
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batchId}/jobs/${job.id}/${action}`, {
        method: "POST", body: JSON.stringify(action === "answer" ? { answer: answers[job.id] ?? "" } : {}),
      });
      if (selectedIdRef.current === batchId) await refreshDetail(batchId);
    } catch (error) { if (selectedIdRef.current === batchId) setNotice((error as Error).message); }
    finally { if (action === "retry") setRetryingJobId(undefined); setBusy(false); }
  };
  const confirmJob = async (job: BatchJob) => {
    if (!detail || !canConfirmFromBatchList(job)) return;
    const batchId = detail.id;
    if (!window.confirm(`确认将 ${job.studentName} 的当前成绩正式入库？`)) return;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batchId}/jobs/${job.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: job.resultVersion,
          reviewNote: "教师在批次列表正式确认成绩",
          acknowledgedReasons: job.reviewReasons ?? [],
        }),
      });
      if (selectedIdRef.current === batchId) {
        await Promise.all([refreshDetail(batchId), refreshList()]);
        setNotice(`${job.studentName} 的成绩已正式确认。`);
      }
    } catch (error) { if (selectedIdRef.current === batchId) setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const progress = detail ? batchProgress(detail) : undefined;
  const actions = detail ? batchActions(detail) : undefined;
  const firstReviewJob = detail?.jobs?.find(({ reviewStatus }) => reviewStatus === "needs_review")
    ?? detail?.jobs?.find(({ resultVersion }) => resultVersion !== undefined)
    ?? detail?.jobs?.[0];

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
        <nav>{batches.map((batch) => <button className={selectedId === batch.id ? "active" : ""} key={batch.id} type="button" onClick={() => chooseBatch(batch.id)}><strong>{batch.title}</strong><span>{batchStatusLabel(batch.status)} · {batch.totalJobs} 份</span></button>)}</nav>
      </aside>
      <main className="batch-grading-main">
        {!uploadDraft && <form className="batch-create-card" onSubmit={create}>
          <div><h2>创建新批次</h2><p>先建立持久化草稿；刷新页面或重启应用后仍可继续。</p></div>
          <label>批次名称<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>并发数<select aria-label="并发数" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="batch-file-input">学生报告<input aria-label="选择学生报告" type="file" multiple accept=".md,.docx,.pdf,.pptx,.png,.jpg,.jpeg" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /><span>{files.length ? `已选择 ${files.length} 份` : "尚未选择文件"}</span></label>
          <label className="batch-file-input">共享 assets 目录（可选）<input aria-label="选择共享 assets 目录" type="file" multiple {...({ webkitdirectory: "" } as object)} onChange={(event) => setAssetFiles(Array.from(event.target.files ?? []))} /><span>{assetFiles.length ? `已选择 ${assetFiles.length} 个附件` : "尚未选择附件目录"}</span></label>
          <button className="primary-button" disabled={busy || !selectedRubric || files.length < 1 || files.length > 120} type="submit">创建上传草稿</button>
        </form>}
        {uploadDraft && <section className="batch-detail">
          <header><div><p className="eyebrow">可恢复上传草稿</p><h2>{uploadDraft.title}</h2><p>每份文件独立处理；修复失败项不会丢失成功项。</p></div><strong>{uploadDraft.items.filter(({ status }) => status === "ready").length}/{uploadDraft.items.length}</strong></header>
          <div className="batch-controls"><button disabled={busy || !canCommitBatchUpload(uploadDraft)} onClick={() => void commitDraft()}>创建正式批次</button><button disabled={busy} onClick={() => void cancelDraft()}>取消草稿</button></div>
          <div className="batch-job-table"><table><thead><tr><th>文件</th><th>身份</th><th>状态</th><th>操作</th></tr></thead><tbody>{uploadDraft.items.map((item) => {
            const identity = identities[item.id] ?? { studentName: item.studentName ?? "", studentNumber: item.studentNumber ?? "" };
            return <tr key={item.id}><td>{item.filename}{item.sessionId && <small>会话已保留</small>}</td><td>{item.status === "identity_required" ? <div className="batch-answer"><input aria-label={`${item.filename} 姓名`} placeholder="姓名" value={identity.studentName} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentName: event.target.value } })} /><input aria-label={`${item.filename} 学号`} placeholder="学号" value={identity.studentNumber} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentNumber: event.target.value } })} /><button disabled={busy || !identity.studentName.trim() || !identity.studentNumber.trim()} onClick={() => void patchIdentity(item)}>保存身份</button></div> : <>{item.studentName ?? "—"}<small>{item.studentNumber}</small></>}</td><td><span className={`batch-status ${item.status}`}>{batchUploadItemStatusLabel(item.status)}</span>{item.errorCode && <small>{userErrorMessage(item.errorCode)}</small>}</td><td><div className="batch-answer">{["failed", "identity_required"].includes(item.status) && <button disabled={busy} onClick={() => void draftItemCommand(item, "retry")}>{retryingItemId === item.id ? "重试中…" : "重试"}</button>}<label className="button-link">替换<input hidden type="file" accept=".md,.docx,.pdf,.pptx,.png,.jpg,.jpeg" onChange={(event) => { const replacement = event.target.files?.[0]; if (replacement) void uploadItem(uploadDraft, item, replacement).then(() => refreshDraft(uploadDraft.id)).catch((error) => setNotice((error as Error).message)); }} /></label><button disabled={busy} onClick={() => void draftItemCommand(item, "remove")}>移除</button></div></td></tr>;
          })}</tbody></table></div>
        </section>}
        {detail ? <section className="batch-detail">
          <header><div><p className="eyebrow">{batchStatusLabel(detail.status)}</p><h2>{detail.title}</h2><p>并发 {detail.concurrency} · {progress?.settled}/{detail.totalJobs} 已结束本轮处理</p></div><strong>{progress?.percent}%</strong></header>
          <div className="batch-progress"><i style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <div className="batch-controls">{actions?.canStart && <button disabled={busy} onClick={() => void command("start")}>启动批改</button>}{actions?.canPause && <button disabled={busy} onClick={() => void command("pause")}>暂停领取</button>}{actions?.canResume && <button disabled={busy} onClick={() => void command("resume")}>恢复批改</button>}{actions?.canExport && <a className="button-link" href={`/api/grading/batches/${detail.id}/export.csv`}>导出班级 CSV</a>}</div>
          <div className="batch-counts">{Object.entries(detail.counts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{batchStatusLabel(status)} <strong>{count}</strong></span>)}</div>
          <div className="batch-review-entry">{detail.status === "completed" && <p>本轮处理已结束；待复核成绩仍需进入 Review 核对并正式确认。</p>}<a className="button-link" href={batchReviewHref(detail.id, firstReviewJob?.sessionId)}>Review</a></div>
          <div className="batch-job-table"><table><thead><tr><th>学生</th><th>作业</th><th>状态</th><th>分数</th><th>置信度</th><th>尝试</th><th>操作</th></tr></thead><tbody>{detail.jobs?.map((job) => <tr key={job.id}><td>{job.studentName}<small>{job.studentNumber}</small></td><td><a href={batchReviewHref(detail.id, job.sessionId)}>{job.submissionTitle}</a></td><td><span className={`batch-status ${job.status}`}>{batchStatusLabel(job.status)}</span>{job.lastErrorCode && <small>{userErrorMessage(job.lastErrorCode)}</small>}</td><td>{formatBatchScore(job)}</td><td>{formatBatchConfidence(job)}</td><td>{job.attemptCount}/{job.maxAttempts}</td><td><div className="batch-row-actions">{canRetryBatchJob(job) && <button disabled={busy} onClick={() => void jobCommand(job, "retry")}>{retryingJobId === job.id ? "重试中…" : "重试"}</button>}{canConfirmFromBatchList(job) && <button className="primary-button" disabled={busy} onClick={() => void confirmJob(job)}>确认</button>}{job.status === "waiting_for_teacher" && <div className="batch-answer"><span>{job.question}</span><input aria-label={`回答 ${job.studentName}`} value={answers[job.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [job.id]: event.target.value })} /><button disabled={busy || !(answers[job.id] ?? "").trim()} onClick={() => void jobCommand(job, "answer")}>回答</button></div>}{!canRetryBatchJob(job) && !canConfirmFromBatchList(job) && job.status !== "waiting_for_teacher" && "—"}</div></td></tr>)}</tbody></table></div>
        </section> : !uploadDraft && <section className="batch-empty"><h2>选择或创建批次</h2><p>批量任务拥有独立队列，不会改变单份批改会话的交互。</p></section>}
      </main>
    </div>
  </div>;
}
