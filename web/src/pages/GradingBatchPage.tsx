import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage } from "../lib/api";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import {
  batchActions,
  batchProgress,
  batchReviewHref,
  batchStatusLabel,
  batchJobStatusLabel,
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
  const toast = useToast();
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
  const [busyItemIds, setBusyItemIds] = useState<string[]>([]);
  const [busyJobIds, setBusyJobIds] = useState<string[]>([]);
  const [retryingItemId, setRetryingItemId] = useState<string>();
  const [retryingJobId, setRetryingJobId] = useState<string>();
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [identities, setIdentities] = useState<Record<string, { studentName: string; studentNumber: string }>>({});
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description: string;
    details?: string[];
    confirmLabel?: string;
    tone?: "default" | "danger";
    onConfirm: () => Promise<void> | void;
  }>();
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

  const setItemBusy = (id: string, active: boolean) => {
    setBusyItemIds((current) => active ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id));
  };
  const setJobBusy = (id: string, active: boolean) => {
    setBusyJobIds((current) => active ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id));
  };

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
        } else setNotice("选择 1–120 份学生报告创建可恢复的上传草稿。");
      } catch (error) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
    })();
  }, []);
  useEffect(() => {
    const id = selectedId;
    void refreshDetail(id).catch((error) => {
      if (id === selectedIdRef.current) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
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
      toast.fromError(error);
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
    setUploadErrors([]);
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
      const errors: string[] = [];
      const queue = draft.items.map((item, index) => ({ item, file: files[index]! }));
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const next = queue.shift();
          if (!next) return;
          try { await uploadItem(draft, next.item, next.file); }
          catch (error) {
            const msg = `${next.file.name}：${(error as Error).message}`;
            errors.push(msg);
            setUploadErrors([...errors]);
          }
          finally {
            completed += 1;
            setNotice(`已上传 ${completed}/${files.length} 份报告${errors.length ? `（${errors.length} 份需要处理）` : ""}。`);
          }
        }
      });
      await Promise.allSettled(workers);
      await refreshDraft(draft.id);
      setFiles([]);
      if (errors.length > 0) {
        toast.warning(`${errors.length} 份报告上传或解析需要处理，可在下方列表中单独补填身份、替换或移除。`);
      } else {
        toast.success(`已上传全部 ${files.length} 份报告，待全部就绪后即可创建正式批次。`);
      }
    } catch (error) {
      setNotice((error as Error).message);
      toast.fromError(error);
    }
    finally { setBusy(false); }
  };
  const patchIdentity = async (item: BatchUploadItem) => {
    if (!uploadDraft) return;
    const identity = identities[item.id] ?? { studentName: item.studentName ?? "", studentNumber: item.studentNumber ?? "" };
    setItemBusy(item.id, true);
    try {
      await api(`/api/grading/batch-uploads/${uploadDraft.id}/items/${item.id}/identity`, { method: "PATCH", body: JSON.stringify(identity) });
      await refreshDraft(uploadDraft.id);
      toast.success(`已保存 ${item.filename} 的学生身份。`);
    } catch (error) {
      setNotice((error as Error).message);
      toast.fromError(error);
    }
    finally { setItemBusy(item.id, false); }
  };
  const performDraftItemCommand = async (item: BatchUploadItem, action: "retry" | "remove") => {
    if (!uploadDraft) return;
    if (action === "retry") setRetryingItemId(item.id);
    setItemBusy(item.id, true);
    try {
      await api(`/api/grading/batch-uploads/${uploadDraft.id}/items/${item.id}${action === "retry" ? "/retry" : ""}`, { method: action === "retry" ? "POST" : "DELETE", ...(action === "retry" ? { body: "{}" } : {}) });
      await refreshDraft(uploadDraft.id);
      if (action === "remove") toast.info(`已从上传草稿中移除 ${item.filename}。`);
    } catch (error) {
      setNotice((error as Error).message);
      toast.fromError(error);
    }
    finally {
      if (action === "retry") setRetryingItemId(undefined);
      setItemBusy(item.id, false);
    }
  };
  const draftItemCommand = (item: BatchUploadItem, action: "retry" | "remove") => {
    if (action === "remove") {
      setConfirmState({
        title: "从上传草稿中移除该报告？",
        description: `移除“${item.filename}”后，该文件不会进入本次正式批次。`,
        details: item.sessionId ? ["该文件对应的单份会话已保留，可在单份批改页继续查看。"] : undefined,
        confirmLabel: "确认移除",
        tone: "danger",
        onConfirm: () => performDraftItemCommand(item, "remove"),
      });
      return;
    }
    void performDraftItemCommand(item, action);
  };
  const commitDraft = async () => {
    if (!uploadDraft) return;
    setBusy(true);
    try {
      const batch = await api<Batch>(`/api/grading/batch-uploads/${uploadDraft.id}/commit`, { method: "POST", body: "{}" });
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      uploadDraftIdRef.current.set(undefined);
      setUploadDraft(undefined);
      setUploadErrors([]);
      selectedIdRef.current = batch.id;
      setSelectedId(batch.id);
      await refreshList();
      setNotice("正式批次已创建，点击“启动批改”开始并发评分。");
      toast.success("正式批次已创建，点击“启动批改”即可开始。");
    } catch (error) {
      setNotice((error as Error).message);
      toast.fromError(error);
    }
    finally { setBusy(false); }
  };
  const performCancelDraft = async () => {
    if (!uploadDraft) return;
    setBusy(true);
    try {
      const result = await api<{ preservedSessionIds: string[] }>(`/api/grading/batch-uploads/${uploadDraft.id}`, { method: "DELETE" });
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      uploadDraftIdRef.current.set(undefined);
      setUploadDraft(undefined);
      setUploadErrors([]);
      const msg = result.preservedSessionIds.length
        ? `草稿已取消；已创建的 ${result.preservedSessionIds.length} 个会话已安全保留。`
        : "上传草稿和未使用的暂存文件已清理。";
      setNotice(msg);
      toast.info(msg);
    } catch (error) {
      setNotice((error as Error).message);
      toast.fromError(error);
    }
    finally { setBusy(false); }
  };
  const cancelDraft = () => {
    if (!uploadDraft) return;
    const readyCount = uploadDraft.items.filter(({ status }) => status === "ready").length;
    setConfirmState({
      title: "取消当前上传草稿？",
      description: `当前草稿“${uploadDraft.title}”包含 ${uploadDraft.items.length} 份报告（其中 ${readyCount} 份已就绪）。`,
      details: ["已成功转换并建档的会话会保留在单份批改列表中，未使用的暂存文件将被清理。"],
      confirmLabel: "确认取消草稿",
      tone: "danger",
      onConfirm: performCancelDraft,
    });
  };
  const command = async (action: "start" | "pause" | "resume") => {
    if (!detail) return;
    const batchId = detail.id;
    setBusy(true);
    try {
      await api(`/api/grading/batches/${batchId}/${action}`, { method: "POST", body: "{}" });
      if (selectedIdRef.current === batchId) await Promise.all([refreshDetail(batchId), refreshList()]);
      toast.success(action === "start" ? "批量批改已启动。" : action === "pause" ? "已暂停领取新任务，正在运行的任务会自然结束。" : "已恢复批量批改。");
    } catch (error) {
      if (selectedIdRef.current === batchId) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
    }
    finally { setBusy(false); }
  };
  const jobCommand = async (job: BatchJob, action: "retry" | "answer") => {
    if (!detail) return;
    const batchId = detail.id;
    if (action === "retry") setRetryingJobId(job.id);
    setJobBusy(job.id, true);
    try {
      await api(`/api/grading/batches/${batchId}/jobs/${job.id}/${action}`, {
        method: "POST", body: JSON.stringify(action === "answer" ? { answer: answers[job.id] ?? "" } : {}),
      });
      if (selectedIdRef.current === batchId) await refreshDetail(batchId);
      toast.success(action === "retry" ? `${job.studentName} 已重新进入批改队列。` : `已回复 ${job.studentName} 的评分问题，批改将继续。`);
    } catch (error) {
      if (selectedIdRef.current === batchId) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
    }
    finally {
      if (action === "retry") setRetryingJobId(undefined);
      setJobBusy(job.id, false);
    }
  };
  const performConfirmJob = async (job: BatchJob) => {
    if (!detail || !canConfirmFromBatchList(job)) return;
    const batchId = detail.id;
    setJobBusy(job.id, true);
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
        toast.success(`${job.studentName} 的成绩已正式确认。`);
      }
    } catch (error) {
      if (selectedIdRef.current === batchId) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
    }
    finally { setJobBusy(job.id, false); }
  };
  const confirmJob = (job: BatchJob) => {
    if (!detail || !canConfirmFromBatchList(job)) return;
    setConfirmState({
      title: "正式确认该学生成绩？",
      description: `确认将 ${job.studentName}（${job.studentNumber}）的当前得分（${formatBatchScore(job)}）正式入库并纳入班级成绩表？`,
      confirmLabel: "正式确认",
      onConfirm: () => performConfirmJob(job),
    });
  };
  const progress = detail ? batchProgress(detail) : undefined;
  const actions = detail ? batchActions(detail) : undefined;
  const firstReviewJob = detail?.jobs?.find(({ reviewStatus }) => reviewStatus === "needs_review")
    ?? detail?.jobs?.find(({ resultVersion }) => resultVersion !== undefined)
    ?? detail?.jobs?.[0];
  const draftReadyCount = uploadDraft ? uploadDraft.items.filter(({ status }) => status === "ready").length : 0;
  const draftPendingCount = uploadDraft ? uploadDraft.items.length - draftReadyCount : 0;

  return <div className="batch-grading-page">
    <header className="workspace-header batch-grading-header">
      <div><p className="eyebrow">批量批改工作台</p><h1>批量作业批改</h1><p>{notice}</p></div>
      <a className="secondary-link-button" href="/grading">切换到单份批改</a>
    </header>
    <div className="batch-grading-layout">
      <aside className="batch-grading-sidebar">
        <label>评分标准<select aria-label="批量评分标准" value={rubricKey} onChange={(event) => void chooseRubric(event.target.value)}>
          <option value="">选择冻结评分标准</option>{rubrics.map((rubric) => <option key={`${rubric.assignmentId}:${rubric.version}`} value={`${rubric.assignmentId}:${rubric.version}`}>{rubric.title} · v{rubric.version}</option>)}
        </select></label>
        <p className="batch-sidebar-heading">历史批次（{batches.length}）</p>
        <nav>{batches.length === 0 ? <p className="muted">该评分标准下尚无批次</p> : batches.map((batch) => <button className={selectedId === batch.id ? "active" : ""} key={batch.id} type="button" onClick={() => chooseBatch(batch.id)}><strong>{batch.title}</strong><span>{batchStatusLabel(batch.status)} · {batch.totalJobs} 份</span></button>)}</nav>
      </aside>
      <main className="batch-grading-main">
        {!uploadDraft && <form className="batch-create-card" onSubmit={create}>
          <div className="batch-create-heading"><h2>创建新批次</h2><p>先建立可恢复的上传草稿；即使刷新页面或重启应用，已上传成功的报告也不会丢失。</p></div>
          <div className="batch-create-row">
            <label>批次名称<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：2026 春季班第一次作业" /></label>
            <label>并发数<select aria-label="并发数" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}</select></label>
          </div>
          <div className="batch-create-row files-row">
            <label className="batch-file-input">学生报告（1–120 份）<input aria-label="选择学生报告" type="file" multiple accept=".md,.docx,.pdf,.pptx,.png,.jpg,.jpeg" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /><span>{files.length ? `已选择 ${files.length} 份报告` : "支持 Markdown、DOCX、PDF、PPTX 与图片"}</span></label>
            <label className="batch-file-input">共享 assets 目录（可选）<input aria-label="选择共享 assets 目录" type="file" multiple {...({ webkitdirectory: "" } as object)} onChange={(event) => setAssetFiles(Array.from(event.target.files ?? []))} /><span>{assetFiles.length ? `已选择 ${assetFiles.length} 个附件` : "仅 Markdown 引用了本地图片时需要选择"}</span></label>
            <div className="batch-create-submit">
              <button className="primary-button" disabled={busy || !selectedRubric || files.length < 1 || files.length > 120} type="submit">{busy ? "正在上传…" : "创建上传草稿"}</button>
              {(!selectedRubric || files.length < 1 || files.length > 120) && <small className="inline-requirement-hint">{!selectedRubric ? "请先在左侧选择冻结评分标准" : files.length > 120 ? "单批次最多支持 120 份报告" : "请先选择至少 1 份学生报告"}</small>}
            </div>
          </div>
        </form>}
        {uploadDraft && <section className="batch-detail">
          <header><div><p className="eyebrow">可恢复上传草稿</p><h2>{uploadDraft.title}</h2><p>每份文件独立处理；补填身份或替换失败项不会丢失其他已就绪的报告。</p></div><strong>{draftReadyCount}/{uploadDraft.items.length}</strong></header>
          {uploadErrors.length > 0 && <div className="batch-error-summary" role="alert">
            <div><strong>部分文件上传需要处理（{uploadErrors.length}）</strong><button type="button" onClick={() => setUploadErrors([])}>收起</button></div>
            <ul>{uploadErrors.slice(0, 5).map((item, idx) => <li key={idx}>{item}</li>)}</ul>
          </div>}
          <div className="batch-controls">
            <button className="primary-button" disabled={busy || !canCommitBatchUpload(uploadDraft)} onClick={() => void commitDraft()}>{busy ? "正在创建…" : "创建正式批次"}</button>
            <button disabled={busy} onClick={() => cancelDraft()}>取消草稿</button>
            {!canCommitBatchUpload(uploadDraft) && <span className="inline-requirement-hint">{draftPendingCount > 0 ? `还有 ${draftPendingCount} 份报告未就绪，请等待转换或处理异常项` : "至少需要保留 1 份已就绪的报告"}</span>}
          </div>
          <div className="batch-job-table"><table><thead><tr><th>文件</th><th>身份</th><th>状态</th><th>操作</th></tr></thead><tbody>{uploadDraft.items.map((item) => {
            const identity = identities[item.id] ?? { studentName: item.studentName ?? "", studentNumber: item.studentNumber ?? "" };
            const itemBusy = busy || busyItemIds.includes(item.id);
            return <tr key={item.id}><td>{item.filename}{item.sessionId && <small>会话已保留</small>}</td><td>{item.status === "identity_required" ? <div className="batch-answer"><input aria-label={`${item.filename} 姓名`} placeholder="姓名" value={identity.studentName} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentName: event.target.value } })} /><input aria-label={`${item.filename} 学号`} placeholder="学号" value={identity.studentNumber} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentNumber: event.target.value } })} /><button disabled={itemBusy || !identity.studentName.trim() || !identity.studentNumber.trim()} onClick={() => void patchIdentity(item)}>{busyItemIds.includes(item.id) ? "保存中…" : "保存身份"}</button></div> : <>{item.studentName ?? "—"}<small>{item.studentNumber}</small></>}</td><td><span className={`batch-status ${item.status}`}>{batchUploadItemStatusLabel(item.status)}</span>{(item.errorCode || item.status === "failed") && <small>{userErrorMessage(item.errorCode ?? "GRADING_BATCH_ERROR")}</small>}</td><td><div className="batch-answer">{["failed", "identity_required"].includes(item.status) && <button disabled={itemBusy} onClick={() => draftItemCommand(item, "retry")}>{retryingItemId === item.id ? "重试中…" : "重试"}</button>}<label className="button-link">替换<input hidden type="file" accept=".md,.docx,.pdf,.pptx,.png,.jpg,.jpeg" onChange={(event) => { const replacement = event.target.files?.[0]; if (replacement) { setItemBusy(item.id, true); void uploadItem(uploadDraft, item, replacement).then(() => { toast.success(`已替换 ${item.filename}`); return refreshDraft(uploadDraft.id); }).catch((error) => { setNotice((error as Error).message); toast.fromError(error); }).finally(() => setItemBusy(item.id, false)); } }} /></label><button disabled={itemBusy} onClick={() => draftItemCommand(item, "remove")}>移除</button></div></td></tr>;
          })}</tbody></table></div>
        </section>}
        {detail ? <section className="batch-detail">
          <header><div><p className="eyebrow">{batchStatusLabel(detail.status)}</p><h2>{detail.title}</h2><p>并发 {detail.concurrency} · {progress?.settled}/{detail.totalJobs} 已结束本轮处理</p></div><strong>{progress?.percent}%</strong></header>
          <div className="batch-progress"><i style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <div className="batch-controls">{actions?.canStart && <button className="primary-button" disabled={busy} onClick={() => void command("start")}>启动批改</button>}{actions?.canPause && <button disabled={busy} onClick={() => void command("pause")}>暂停领取</button>}{actions?.canResume && <button className="primary-button" disabled={busy} onClick={() => void command("resume")}>恢复批改</button>}{actions?.canExport && <a className="button-link" href={`/api/grading/batches/${detail.id}/export.csv`}>导出班级 CSV</a>}<a className="button-link primary-link" href={batchReviewHref(detail.id, firstReviewJob?.sessionId)}>进入复核</a></div>
          <div className="batch-counts">{Object.entries(detail.counts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{batchStatusLabel(status)} <strong>{count}</strong></span>)}</div>
          {detail.status === "completed" && <p className="batch-review-hint">本轮自动处理已结束；待复核成绩仍需进入复核工作台核对并正式确认。</p>}
          <div className="batch-job-table"><table><thead><tr><th>学生</th><th>作业</th><th>状态</th><th>分数</th><th>置信度</th><th>尝试</th><th>操作</th></tr></thead><tbody>{detail.jobs?.map((job) => {
            const jobBusy = busy || busyJobIds.includes(job.id);
            return <tr key={job.id}><td>{job.studentName}<small>{job.studentNumber}</small></td><td><a href={batchReviewHref(detail.id, job.sessionId)}>{job.submissionTitle}</a></td><td><span className={`batch-status ${job.status}`}>{batchJobStatusLabel(job)}</span>{job.lastErrorCode && <small>{userErrorMessage(job.lastErrorCode)}</small>}</td><td>{formatBatchScore(job)}</td><td>{formatBatchConfidence(job)}</td><td>{job.attemptCount}/{job.maxAttempts}</td><td><div className="batch-row-actions">{canRetryBatchJob(job) && <button disabled={jobBusy} onClick={() => void jobCommand(job, "retry")}>{retryingJobId === job.id ? "重试中…" : "重试"}</button>}{canConfirmFromBatchList(job) && <button className="primary-button" disabled={jobBusy} onClick={() => confirmJob(job)}>{busyJobIds.includes(job.id) ? "确认中…" : "确认"}</button>}{job.status === "waiting_for_teacher" && <div className="batch-answer"><span>{job.question}</span><input aria-label={`回答 ${job.studentName}`} value={answers[job.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [job.id]: event.target.value })} /><button disabled={jobBusy || !(answers[job.id] ?? "").trim()} onClick={() => void jobCommand(job, "answer")}>回答</button></div>}{!canRetryBatchJob(job) && !canConfirmFromBatchList(job) && job.status !== "waiting_for_teacher" && "—"}</div></td></tr>;
          })}</tbody></table></div>
        </section> : !uploadDraft && <section className="batch-empty"><h2>选择或创建批次</h2><p>在左侧选择已有批次查看进度，或在上方上传学生报告开始新的批量批改。</p></section>}
      </main>
    </div>
    <ConfirmDialog
      open={Boolean(confirmState)}
      title={confirmState?.title ?? ""}
      description={confirmState?.description ?? ""}
      details={confirmState?.details}
      confirmLabel={confirmState?.confirmLabel}
      tone={confirmState?.tone}
      busy={busy}
      onConfirm={() => {
        const action = confirmState?.onConfirm;
        setConfirmState(undefined);
        if (action) void action();
      }}
      onCancel={() => setConfirmState(undefined)}
    />
  </div>;
}
