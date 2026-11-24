import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog, PromptDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { apiErrorFromResponse, withJsonHeaders, apiFetch, userErrorMessage } from "../lib/api";
import { LatestRequestGate, startSerialPolling } from "../lib/async-state";
import { COURSE_CHANGED_EVENT, readCourseFromUrl, resolveActiveCourseId, withCourseQuery } from "../lib/course-context";
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
  filterBatchDetailJobs,
  formatBatchConfidence,
  formatBatchScore,
  shouldPollBatch,
  shouldPollBatchUpload,
  UploadDraftRequestTracker,
  type BatchDetailJobFilter,
  type BatchJobCounts,
} from "./grading-batch-page-model";
import { buildAssetManifest } from "./grading-page-model";

type FrozenRubric = { assignmentId: string; courseId?: string; title: string; version: number };
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
const reportAccept = ".md,.txt,.docx,.pdf,.pptx,.png,.jpg,.jpeg";

function batchRubricStorageKey(courseId: string): string {
  return courseId ? `batch-grading-rubric:${courseId}` : "batch-grading-rubric";
}

function batchDraftStorageKey(courseId: string): string {
  return courseId ? `${DRAFT_STORAGE_KEY}:${courseId}` : DRAFT_STORAGE_KEY;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}

export function GradingBatchPage() {
  const toast = useToast();
  const [rubrics, setRubrics] = useState<FrozenRubric[]>([]);
  const [activeCourseId, setActiveCourseId] = useState(() => readCourseFromUrl());
  const [rubricKey, setRubricKey] = useState(
    localStorage.getItem(batchRubricStorageKey(readCourseFromUrl())) ?? "",
  );
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [detail, setDetail] = useState<Batch>();
  const [uploadDraft, setUploadDraft] = useState<BatchUpload>();
  const [files, setFiles] = useState<File[]>([]);
  const [assetFiles, setAssetFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("班级批量批改");
  const [titleManuallyEdited, setTitleManuallyEdited] = useState(false);
  const [batchToRename, setBatchToRename] = useState<Batch>();
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renamingBatch, setRenamingBatch] = useState(false);
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
  const [jobFilter, setJobFilter] = useState<BatchDetailJobFilter>("all");
  const [jobSearch, setJobSearch] = useState("");
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
  useEffect(() => {
    if (!titleManuallyEdited && selectedRubric) {
      const next = `${selectedRubric.title} · 批量批改`;
      setTitle(next.length <= 120 ? next : `${next.slice(0, 119)}…`);
    }
  }, [selectedRubric?.assignmentId, selectedRubric?.version, titleManuallyEdited]);

  const setItemBusy = (id: string, active: boolean) => {
    setBusyItemIds((current) => active ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id));
  };
  const setJobBusy = (id: string, active: boolean) => {
    setBusyJobIds((current) => active ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id));
  };

  const refreshList = async (rubric = selectedRubric, preferredBatchId = "") => {
    const lease = listGate.current.begin();
    const next = rubric
      ? await api<Batch[]>(`/api/grading/batches?assignmentId=${encodeURIComponent(rubric.assignmentId)}&rubricVersion=${rubric.version}`)
      : [];
    if (!lease.isCurrent()) return undefined;
    setBatches(next);
    const preferred = next.find((batch) => batch.id === preferredBatchId) ?? next[0];
    if (!selectedIdRef.current && preferred) {
      selectedIdRef.current = preferred.id;
      setSelectedId(preferred.id);
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
    const loadForCourse = async () => {
      try {
        const urlCourseId = readCourseFromUrl();
        const courses = urlCourseId
          ? [{ id: urlCourseId }]
          : await api<Array<{ id: string }>>("/api/courses").catch(() => []);
        const nextCourseId = urlCourseId || resolveActiveCourseId(courses, "");
        setActiveCourseId(nextCourseId);
        const rubricStorageKey = batchRubricStorageKey(nextCourseId);
        const draftStorageKey = batchDraftStorageKey(nextCourseId);
        const rawRubrics = await api<FrozenRubric[]>(
          nextCourseId
            ? `/api/grading/rubrics?courseId=${encodeURIComponent(nextCourseId)}`
            : "/api/grading/rubrics",
        );
        const nextRubrics = nextCourseId
          ? rawRubrics.filter((item) => !item.courseId || item.courseId === nextCourseId)
          : rawRubrics;
        setRubrics(nextRubrics);
        const params = new URLSearchParams(window.location.search);
        const requestedRubricKey = params.get("rubric") ?? "";
        const requestedBatchId = params.get("batch") ?? "";
        const storedRubricKey = localStorage.getItem(rubricStorageKey) ?? "";
        const preferredRubricKey = requestedRubricKey || storedRubricKey;
        const savedValid = preferredRubricKey && nextRubrics.some((item) => `${item.assignmentId}:${item.version}` === preferredRubricKey);
        const key = savedValid ? preferredRubricKey : (nextRubrics[0] ? `${nextRubrics[0].assignmentId}:${nextRubrics[0].version}` : "");
        setRubricKey(key);
        if (key) localStorage.setItem(rubricStorageKey, key);
        selectedIdRef.current = "";
        setSelectedId("");
        setDetail(undefined);
        uploadDraftIdRef.current.set(undefined);
        setUploadDraft(undefined);
        const nextBatches = await refreshList(nextRubrics.find((item) => `${item.assignmentId}:${item.version}` === key), requestedBatchId);
        if (nextBatches?.some((batch) => batch.id === requestedBatchId)) {
          setCreatingBatch(false);
          setNotice("已返回当前批次。");
          return;
        }
        const draftId = localStorage.getItem(draftStorageKey);
        if (draftId) {
          try {
            uploadDraftIdRef.current.set(draftId);
            const restored = await refreshDraft(draftId);
            const wasAlreadyCommitted = restored && completeCommittedUploadDraftRestore(restored, uploadDraftIdRef.current, {
              invalidateRequests: () => draftGate.current.invalidate(),
              removeStoredDraft: () => localStorage.removeItem(draftStorageKey),
              clearDraft: () => setUploadDraft(undefined),
              selectBatch: (id) => {
                selectedIdRef.current = id;
                setSelectedId(id);
              },
            });
            if (!wasAlreadyCommitted) setNotice("已恢复上次未完成的批次上传草稿。");
          } catch {
            if (localStorage.getItem(draftStorageKey) === draftId && uploadDraftIdRef.current.matches(draftId)) {
              localStorage.removeItem(draftStorageKey);
            }
          }
        } else setNotice("选择 1–120 份学生报告创建可恢复的上传草稿。");
      } catch (error) {
        setNotice((error as Error).message);
        toast.fromError(error);
      }
    };
    void loadForCourse();
    const onCourseChange = () => void loadForCourse();
    window.addEventListener("popstate", onCourseChange);
    window.addEventListener(COURSE_CHANGED_EVENT, onCourseChange);
    return () => {
      window.removeEventListener("popstate", onCourseChange);
      window.removeEventListener(COURSE_CHANGED_EVENT, onCourseChange);
    };
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
    localStorage.setItem(batchRubricStorageKey(activeCourseId), key);
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
  const renameBatch = async () => {
    if (!batchToRename) return;
    const nextTitle = renameTitle.trim();
    if (!nextTitle) {
      setRenameError("请输入批次名称");
      return;
    }
    setRenamingBatch(true);
    setRenameError("");
    try {
      const updated = await api<Batch>(`/api/grading/batches/${batchToRename.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle }),
      });
      setBatches((current) => current.map((item) => item.id === updated.id ? { ...item, title: updated.title } : item));
      setDetail((current) => current?.id === updated.id ? { ...current, title: updated.title } : current);
      setBatchToRename(undefined);
      toast.success("批次已重命名。");
    } catch (error) {
      setRenameError((error as Error).message);
    } finally {
      setRenamingBatch(false);
    }
  };
  const chooseBatch = (id: string) => {
    setCreatingBatch(false);
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
    const uploaded = await response.json() as BatchUploadItem;
    if (uploaded.status === "failed") {
      setUploadDraft((current) => current?.id === draft.id
        ? { ...current, items: current.items.map((entry) => entry.id === uploaded.id ? uploaded : entry) }
        : current);
      throw new Error(userErrorMessage(uploaded.errorCode ?? "BATCH_UPLOAD_PROCESSING_FAILED"));
    }
    return uploaded;
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
      localStorage.setItem(batchDraftStorageKey(activeCourseId), draft.id);
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
      localStorage.removeItem(batchDraftStorageKey(activeCourseId));
      uploadDraftIdRef.current.set(undefined);
      setUploadDraft(undefined);
      setUploadErrors([]);
      selectedIdRef.current = batch.id;
      setSelectedId(batch.id);
      setCreatingBatch(false);
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
      localStorage.removeItem(batchDraftStorageKey(activeCourseId));
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
  const showGuidedCreate = !uploadDraft && (creatingBatch || !detail);
  const step1Done = Boolean(selectedRubric);
  const step2Done = files.length >= 1 && files.length <= 120;

  return <div className="batch-grading-page">
    <header className="workspace-header batch-grading-header">
      <div className="batch-header-title"><h1>批量作业批改</h1><span className="batch-header-notice">{notice}</span></div>
    </header>
    <div className="batch-grading-layout">
      <aside className="batch-grading-sidebar">
        <button
          type="button"
          className={`batch-new-button ${showGuidedCreate ? "active" : ""}`}
          disabled={Boolean(uploadDraft)}
          onClick={() => setCreatingBatch(true)}
        >
          ＋ 新建批改批次
        </button>
        {!showGuidedCreate && <label>评分标准<select aria-label="批量评分标准" value={rubricKey} onChange={(event) => void chooseRubric(event.target.value)}>
          <option value="">选择冻结评分标准</option>{rubrics.map((rubric) => <option key={`${rubric.assignmentId}:${rubric.version}`} value={`${rubric.assignmentId}:${rubric.version}`}>{rubric.title} · v{rubric.version}</option>)}
        </select></label>}
        <p className="batch-sidebar-heading">历史批次（{batches.length}）</p>
        <nav>{batches.length === 0 ? <p className="muted">尚无历史批次</p> : batches.map((batch) => <div className={`batch-history-card ${!showGuidedCreate && selectedId === batch.id ? "active" : ""}`} key={batch.id}><button className="batch-history-select" type="button" onClick={() => chooseBatch(batch.id)}><strong>{batch.title}</strong><span>{batchStatusLabel(batch.status)} · {batch.totalJobs} 份</span></button><div className="grading-session-actions"><button type="button" onClick={() => { setBatchToRename(batch); setRenameTitle(batch.title); setRenameError(""); }}>重命名</button></div></div>)}</nav>
      </aside>
      <main className="batch-grading-main">
        {showGuidedCreate && <form className="batch-create-card batch-guided-card" onSubmit={create}>
          <div className="batch-guided-header">
            <h2>开始批量批改</h2>
            <p>选择评分标准，上传并核对报告，然后创建批次并启动批改。</p>
          </div>
          <ol className="batch-stepper" aria-label="批量批改步骤">
            <li className={step1Done ? "done" : "current"}><span>{step1Done ? "✓" : "1"}</span>选择评分标准</li>
            <li className={step2Done ? "done" : step1Done ? "current" : ""}><span>{step2Done ? "✓" : "2"}</span>上传学生报告</li>
            <li className={step1Done && step2Done ? "current" : ""}><span>3</span>确认并开始批改</li>
          </ol>

          <section className={`batch-step-block ${step1Done ? "completed" : "active"}`}>
            <div className="batch-step-title"><strong>1. 选择冻结评分标准</strong>{step1Done && <span className="batch-step-badge">已就绪</span>}</div>
            {rubrics.length === 0 ? <div className="batch-no-rubric">
              <p>还没有已冻结的评分量表，请先设计并冻结一份评分标准后再开展批量批改。</p>
              <a className="secondary-link-button" href="/rubrics">前往设计评分量表</a>
            </div> : <select aria-label="批量评分标准" value={rubricKey} onChange={(event) => void chooseRubric(event.target.value)}>
              <option value="">请选择一份已冻结的评分标准…</option>
              {rubrics.map((rubric) => <option key={`${rubric.assignmentId}:${rubric.version}`} value={`${rubric.assignmentId}:${rubric.version}`}>{rubric.title} · v{rubric.version}</option>)}
            </select>}
          </section>

          <section className={`batch-step-block ${step2Done ? "completed" : step1Done ? "active" : ""}`}>
            <div className="batch-step-title"><strong>2. 上传学生报告（1–120 份）</strong>{step2Done && <span className="batch-step-badge">已选 {files.length} 份</span>}</div>
            <label className="batch-dropzone">
              <input aria-label="选择学生报告" type="file" multiple accept={reportAccept} onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
              <strong>{files.length ? `已选择 ${files.length} 份学生报告（点击可重新选择）` : "点击选择学生报告文件"}</strong>
              <span>支持 DOCX、PDF、PPTX、Markdown、TXT 与图片，单批最多 120 份</span>
              {files.length > 0 && <small className="batch-file-preview">{files.slice(0, 3).map((file) => file.name).join("、")}{files.length > 3 ? ` 等 ${files.length} 份` : ""}</small>}
            </label>
          </section>

          <section className="batch-step-block compact">
            <label className="batch-title-field">批次名称<input value={title} maxLength={120} onChange={(event) => { setTitle(event.target.value); setTitleManuallyEdited(true); }} placeholder="例如：2026 春季班第一次作业" /></label>
            <details className="batch-advanced-options">
              <summary>更多设置（并发数：{concurrency}{assetFiles.length ? ` · 已选 ${assetFiles.length} 个图片附件` : ""}）</summary>
              <div className="batch-advanced-grid">
                <label>同时批改并发数<select aria-label="并发数" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="batch-file-input">Markdown 共享 assets 目录（可选）<input aria-label="选择共享 assets 目录" type="file" multiple {...({ webkitdirectory: "" } as object)} onChange={(event) => setAssetFiles(Array.from(event.target.files ?? []))} /><span>{assetFiles.length ? `已选择 ${assetFiles.length} 个附件` : "仅 Markdown 引用本地图片时需要选择"}</span></label>
              </div>
            </details>
          </section>

          <footer className="batch-guided-footer">
            {(!selectedRubric || files.length < 1 || files.length > 120) ? <span className="inline-requirement-hint">{!selectedRubric ? "请先在第 1 步选择冻结评分标准" : files.length > 120 ? "单批次最多支持 120 份报告，请减少文件数" : "请在第 2 步选择至少 1 份学生报告"}</span> : <span className="batch-ready-hint">已就绪，点击后将上传并逐份识别学生姓名与学号</span>}
            <button className="primary-button" disabled={busy || !selectedRubric || files.length < 1 || files.length > 120} type="submit">{busy ? "正在上传报告…" : "下一步：上传并准备批次"}</button>
          </footer>
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
            return <tr key={item.id}><td>{item.filename}{item.sessionId && <small>会话已保留</small>}</td><td>{item.status === "identity_required" ? <div className="batch-answer"><input aria-label={`${item.filename} 姓名`} placeholder="姓名" value={identity.studentName} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentName: event.target.value } })} /><input aria-label={`${item.filename} 学号`} placeholder="学号" value={identity.studentNumber} onChange={(event) => setIdentities({ ...identities, [item.id]: { ...identity, studentNumber: event.target.value } })} /><button disabled={itemBusy || !identity.studentName.trim() || !identity.studentNumber.trim()} onClick={() => void patchIdentity(item)}>{busyItemIds.includes(item.id) ? "保存中…" : "保存身份"}</button></div> : <>{item.studentName ?? "—"}<small>{item.studentNumber}</small></>}</td><td><span className={`batch-status ${item.status}`}>{batchUploadItemStatusLabel(item.status)}</span>{(item.errorCode || item.status === "failed") && <small>{userErrorMessage(item.errorCode ?? "GRADING_BATCH_ERROR")}</small>}</td><td><div className="batch-answer">{["failed", "identity_required"].includes(item.status) && <button disabled={itemBusy} onClick={() => draftItemCommand(item, "retry")}>{retryingItemId === item.id ? "重试中…" : "重试"}</button>}<label className="button-link">替换<input hidden type="file" accept={reportAccept} onChange={(event) => { const replacement = event.target.files?.[0]; if (replacement) { setItemBusy(item.id, true); void uploadItem(uploadDraft, item, replacement).then(() => { toast.success(`已替换 ${item.filename}`); return refreshDraft(uploadDraft.id); }).catch((error) => { setNotice((error as Error).message); toast.fromError(error); }).finally(() => setItemBusy(item.id, false)); } }} /></label><button disabled={itemBusy} onClick={() => draftItemCommand(item, "remove")}>移除</button></div></td></tr>;
          })}</tbody></table></div>
        </section>}
        {!uploadDraft && !showGuidedCreate && detail && <section className="batch-detail">
          <header><div><p className="eyebrow">{batchStatusLabel(detail.status)}</p><h2>{detail.title}</h2><p>并发 {detail.concurrency} · {progress?.settled}/{detail.totalJobs} 已结束本轮处理</p></div><strong>{progress?.percent}%</strong></header>
          <div className="batch-progress"><i style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <div className="batch-controls">
            {actions?.canStart && <button className="primary-button" disabled={busy} onClick={() => void command("start")}>启动批改</button>}
            {actions?.canPause && <button disabled={busy} onClick={() => void command("pause")}>暂停领取</button>}
            {actions?.canResume && <button className="primary-button" disabled={busy} onClick={() => void command("resume")}>恢复批改</button>}
            {detail.counts.completed > 0 && <a className="button-link" href={`/api/grading/batches/${detail.id}/export.csv?scope=confirmed`}>导出已确认成绩 CSV</a>}
            {actions?.canExport && <a className="button-link" href={`/api/grading/batches/${detail.id}/export.csv`}>导出处理汇总 CSV（含待复核）</a>}
            {detail.status !== "draft" && <a className="button-link primary-link" href={withCourseQuery(batchReviewHref(detail.id, firstReviewJob?.sessionId), activeCourseId)}>进入复核</a>}
          </div>
          <div className="batch-counts">{Object.entries(detail.counts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{status === "completed" ? "已确认" : batchStatusLabel(status)} <strong>{count}</strong></span>)}</div>
          {detail.status === "completed" && <p className="batch-review-hint">本轮自动处理已结束；待复核成绩仍需进入复核工作台核对并正式确认。</p>}
          {(() => {
            const allJobs = detail.jobs ?? [];
            const visibleJobs = filterBatchDetailJobs(allJobs, jobFilter, jobSearch);
            const hasJobFilter = jobFilter !== "all" || Boolean(jobSearch.trim());
            const filterTabs: Array<[BatchDetailJobFilter, string]> = [
              ["all", "全部"],
              ["needs_review", "待复核"],
              ["waiting_for_teacher", "待回答"],
              ["failed", "失败"],
              ["confirmed", "已确认"],
            ];
            return <>
              <div className="batch-detail-filters" aria-label="筛选批次作业">
                <input
                  type="search"
                  aria-label="搜索批次作业"
                  value={jobSearch}
                  onChange={(event) => setJobSearch(event.target.value)}
                  placeholder="搜索学生姓名、学号或作业…"
                />
                <div className="batch-detail-filter-tabs" role="tablist">
                  {filterTabs.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={jobFilter === key ? "active" : ""}
                      onClick={() => setJobFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="batch-detail-filter-count">显示 {visibleJobs.length}/{allJobs.length}</span>
                {hasJobFilter && (
                  <button
                    type="button"
                    className="sidebar-clear-filter"
                    onClick={() => {
                      setJobFilter("all");
                      setJobSearch("");
                    }}
                  >
                    重置筛选
                  </button>
                )}
              </div>
              <div className="batch-job-table"><table><thead><tr><th>学生</th><th>作业</th><th>状态</th><th>分数</th><th>置信度</th><th>尝试</th><th>操作</th></tr></thead><tbody>{visibleJobs.length === 0 ? <tr><td colSpan={7} className="muted">当前筛选条件下没有匹配的作业</td></tr> : visibleJobs.map((job) => {
            const jobBusy = busy || busyJobIds.includes(job.id);
            return <tr key={job.id}><td>{job.studentName}<small>{job.studentNumber}</small></td><td><a href={withCourseQuery(batchReviewHref(detail.id, job.sessionId), activeCourseId)}>{job.submissionTitle}</a></td><td><span className={`batch-status ${job.status}`}>{batchJobStatusLabel(job)}</span>{job.lastErrorCode && <small>{userErrorMessage(job.lastErrorCode)}</small>}</td><td>{formatBatchScore(job)}</td><td>{formatBatchConfidence(job)}</td><td>{job.attemptCount}/{job.maxAttempts}</td><td><div className="batch-row-actions">{canRetryBatchJob(job) && <button disabled={jobBusy} onClick={() => void jobCommand(job, "retry")}>{retryingJobId === job.id ? "重试中…" : "重试"}</button>}{canConfirmFromBatchList(job) && <button className="primary-button" disabled={jobBusy} onClick={() => confirmJob(job)}>{busyJobIds.includes(job.id) ? "确认中…" : "确认"}</button>}{job.status === "waiting_for_teacher" && <div className="batch-answer"><span>{job.question}</span><input aria-label={`回答 ${job.studentName}`} value={answers[job.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [job.id]: event.target.value })} /><button disabled={jobBusy || !(answers[job.id] ?? "").trim()} onClick={() => void jobCommand(job, "answer")}>回答</button></div>}{!canRetryBatchJob(job) && !canConfirmFromBatchList(job) && job.status !== "waiting_for_teacher" && "—"}</div></td></tr>;
          })}</tbody></table></div>
            </>;
          })()}
        </section>}
      </main>
    </div>
    <PromptDialog
      open={Boolean(batchToRename)}
      title="重命名批改批次"
      label="批次名称"
      value={renameTitle}
      maxLength={120}
      busy={renamingBatch}
      error={renameError}
      onChange={setRenameTitle}
      onConfirm={() => void renameBatch()}
      onCancel={() => { setBatchToRename(undefined); setRenameError(""); }}
    />
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
