import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { withJsonHeaders, apiFetch, apiErrorFromResponse, userErrorMessage, reviewReasonLabel, rubricProblemMessage } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";
import { LatestRequestGate } from "../lib/async-state";
import { numberReleases } from "./knowledge-library-model";

type Course = { id: string; name: string };
type TreeEntry = { path: string; title: string };
type ImportSummary = {
  id: string;
  draftVersion: number;
  manifestHash: string;
  status: string;
  updatedAt?: string;
  baseReleaseId?: string;
};
type Draft = { version: number; manifestHash: string; tree: TreeEntry[] };
type Release = { id: string; createdAt: string; manifestHash: string };
type NumberedRelease = Release & { versionNumber: number; versionLabel: string };
type ViewTab = "current" | "draft" | "history";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders(init));
  if (!response.ok) throw await apiErrorFromResponse(response);
  const body = await response.text();
  return (body ? JSON.parse(body) : null) as T;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function KnowledgeLibraryPage() {
  const queryCourseId = new URLSearchParams(location.search).get("course") ?? "";
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState(queryCourseId);
  const [courseName, setCourseName] = useState("");
  const [releases, setReleases] = useState<NumberedRelease[]>([]);
  const [activeReleaseId, setActiveReleaseId] = useState("");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [releaseTree, setReleaseTree] = useState<TreeEntry[]>([]);
  const [releasePath, setReleasePath] = useState("");
  const [releaseContent, setReleaseContent] = useState("");
  const [drafts, setDrafts] = useState<ImportSummary[]>([]);
  const [currentImport, setCurrentImport] = useState<ImportSummary>();
  const [draft, setDraft] = useState<Draft>();
  const [draftPath, setDraftPath] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [savedDraftContent, setSavedDraftContent] = useState("");
  const [tab, setTab] = useState<ViewTab>("current");
  const [treeQuery, setTreeQuery] = useState("");
  const [notice, setNotice] = useState("正在加载课程…");
  const [noticeKind, setNoticeKind] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const directoryInput = useRef<HTMLInputElement>(null);
  const workspaceGate = useRef(new LatestRequestGate());
  const releaseGate = useRef(new LatestRequestGate());
  const releaseContentGate = useRef(new LatestRequestGate());
  const draftGate = useRef(new LatestRequestGate());
  const draftContentGate = useRef(new LatestRequestGate());
  const courseIdRef = useRef(courseId);
  const selectedReleaseIdRef = useRef(selectedReleaseId);
  const releasePathRef = useRef(releasePath);
  const currentImportIdRef = useRef(currentImport?.id);
  const draftPathRef = useRef(draftPath);
  courseIdRef.current = courseId;
  selectedReleaseIdRef.current = selectedReleaseId;
  releasePathRef.current = releasePath;
  currentImportIdRef.current = currentImport?.id;
  draftPathRef.current = draftPath;

  const currentCourse = courses.find((course) => course.id === courseId);
  const activeRelease = releases.find((release) => release.id === activeReleaseId);
  const selectedRelease = releases.find((release) => release.id === selectedReleaseId);
  const dirty = Boolean(draft && draftPath && draftContent !== savedDraftContent);
  const filteredReleaseTree = useMemo(() => releaseTree.filter((entry) => `${entry.title} ${entry.path}`.toLowerCase().includes(treeQuery.trim().toLowerCase())), [releaseTree, treeQuery]);
  const filteredDraftTree = useMemo(() => (draft?.tree ?? []).filter((entry) => `${entry.title} ${entry.path}`.toLowerCase().includes(treeQuery.trim().toLowerCase())), [draft, treeQuery]);

  const showNotice = (message: string, kind: "info" | "error" = "info") => {
    setNotice(message);
    setNoticeKind(kind);
  };

  const resetCourseState = (nextCourseId: string) => {
    courseIdRef.current = nextCourseId;
    workspaceGate.current.invalidate();
    releaseGate.current.invalidate();
    releaseContentGate.current.invalidate();
    draftGate.current.invalidate();
    draftContentGate.current.invalidate();
    setCourseId(nextCourseId);
    selectedReleaseIdRef.current = "";
    releasePathRef.current = "";
    currentImportIdRef.current = undefined;
    draftPathRef.current = "";
    setReleases([]);
    setActiveReleaseId("");
    setSelectedReleaseId("");
    setReleaseTree([]);
    setReleasePath("");
    setReleaseContent("");
    setDrafts([]);
    setCurrentImport(undefined);
    setDraft(undefined);
    setDraftPath("");
    setDraftContent("");
    setSavedDraftContent("");
    setBusy(false);
  };

  const refreshCourses = async (preferredCourseId = courseId) => {
    const next = await api<Course[]>("/api/courses");
    setCourses(next);
    const selected = next.some((course) => course.id === preferredCourseId) ? preferredCourseId : next[0]?.id ?? "";
    courseIdRef.current = selected;
    setCourseId(selected);
    const currentQuery = new URLSearchParams(window.location.search).get("course") ?? "";
    if (selected !== currentQuery) navigateWithinApp(selected ? `/knowledge?course=${encodeURIComponent(selected)}` : "/knowledge", true);
    return selected;
  };

  const readReleaseFile = async (targetCourseId: string, releaseId: string, targetPath: string) => {
    const lease = releaseContentGate.current.begin();
    releasePathRef.current = targetPath;
    setReleasePath(targetPath);
    setReleaseContent("");
    if (!targetPath) {
      if (lease.isCurrent()) setReleaseContent("");
      return;
    }
    const result = await api<{ content: string }>(`/api/courses/${targetCourseId}/releases/${releaseId}/content?path=${encodeURIComponent(targetPath)}`);
    if (!lease.isCurrent() || targetCourseId !== courseIdRef.current || releaseId !== selectedReleaseIdRef.current || targetPath !== releasePathRef.current) return;
    setReleaseContent(result.content);
  };

  const loadRelease = async (targetCourseId: string, releaseId: string, preferredPath = "") => {
    const lease = releaseGate.current.begin();
    if (!releaseId) {
      if (!lease.isCurrent() || targetCourseId !== courseIdRef.current) return;
      selectedReleaseIdRef.current = "";
      releasePathRef.current = "";
      setSelectedReleaseId("");
      setReleaseTree([]);
      setReleasePath("");
      setReleaseContent("");
      return;
    }
    const tree = await api<TreeEntry[]>(`/api/courses/${targetCourseId}/releases/${releaseId}/tree`);
    if (!lease.isCurrent() || targetCourseId !== courseIdRef.current) return;
    const targetPath = tree.some((entry) => entry.path === preferredPath) ? preferredPath : tree[0]?.path ?? "";
    selectedReleaseIdRef.current = releaseId;
    setSelectedReleaseId(releaseId);
    setReleaseTree(tree);
    await readReleaseFile(targetCourseId, releaseId, targetPath);
  };

  const readDraftFile = async (targetCourseId: string, importId: string, targetPath: string) => {
    const lease = draftContentGate.current.begin();
    draftPathRef.current = targetPath;
    setDraftPath(targetPath);
    setDraftContent("");
    setSavedDraftContent("");
    if (!targetPath) {
      setDraftContent("");
      setSavedDraftContent("");
      return;
    }
    const result = await api<{ content: string }>(`/api/courses/${targetCourseId}/imports/${importId}/content?path=${encodeURIComponent(targetPath)}`);
    if (!lease.isCurrent() || targetCourseId !== courseIdRef.current || importId !== currentImportIdRef.current || targetPath !== draftPathRef.current) return;
    setDraftContent(result.content);
    setSavedDraftContent(result.content);
  };

  const loadDraft = async (targetCourseId: string, imported: ImportSummary, preferredPath = "") => {
    const lease = draftGate.current.begin();
    currentImportIdRef.current = imported.id;
    draftPathRef.current = "";
    setCurrentImport(undefined);
    setDraft(undefined);
    setDraftPath("");
    setDraftContent("");
    setSavedDraftContent("");
    const nextDraft = await api<Draft>(`/api/courses/${targetCourseId}/imports/${imported.id}/tree`);
    if (!lease.isCurrent() || targetCourseId !== courseIdRef.current) return;
    const targetPath = nextDraft.tree.some((entry) => entry.path === preferredPath) ? preferredPath : nextDraft.tree[0]?.path ?? "";
    setCurrentImport({ ...imported, draftVersion: nextDraft.version, manifestHash: nextDraft.manifestHash });
    setDraft(nextDraft);
    await readDraftFile(targetCourseId, imported.id, targetPath);
  };

  const refreshWorkspace = async (targetCourseId: string, preferredReleaseId = "", preferredDraftId = "") => {
    if (!targetCourseId) return;
    const lease = workspaceGate.current.begin();
    const [nextReleases, active, nextDrafts] = await Promise.all([
      api<Release[]>(`/api/courses/${targetCourseId}/releases`),
      api<Release | null>(`/api/courses/${targetCourseId}/active`),
      api<ImportSummary[]>(`/api/courses/${targetCourseId}/drafts`),
    ]);
    if (!lease.isCurrent() || targetCourseId !== courseIdRef.current) return;
    const numbered = numberReleases(nextReleases);
    setReleases(numbered);
    setActiveReleaseId(active?.id ?? "");
    setDrafts(nextDrafts);
    const releaseId = numbered.some((release) => release.id === preferredReleaseId) ? preferredReleaseId : active?.id ?? numbered[0]?.id ?? "";
    await loadRelease(targetCourseId, releaseId);
    const selectedDraft = nextDrafts.find((candidate) => candidate.id === preferredDraftId) ?? nextDrafts[0];
    if (selectedDraft) await loadDraft(targetCourseId, selectedDraft);
    else {
      if (!lease.isCurrent() || targetCourseId !== courseIdRef.current) return;
      currentImportIdRef.current = undefined;
      draftPathRef.current = "";
      setCurrentImport(undefined);
      setDraft(undefined);
      setDraftPath("");
      setDraftContent("");
      setSavedDraftContent("");
    }
  };

  useEffect(() => {
    if (directoryInput.current) (directoryInput.current as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    refreshCourses(queryCourseId).catch((error: Error) => showNotice(error.message, "error"));
  }, []);

  useEffect(() => {
    resetCourseState(queryCourseId);
  }, [queryCourseId]);

  useEffect(() => {
    const syncRoute = () => {
      const nextCourseId = new URLSearchParams(window.location.search).get("course") ?? "";
      if (nextCourseId !== courseIdRef.current) resetCourseState(nextCourseId);
    };
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    if (!courseId) {
      setNotice("创建或选择一门课程后开始整理资料");
      return;
    }
    setBusy(true);
    const requestCourseId = courseId;
    refreshWorkspace(requestCourseId)
      .then(() => {
        if (requestCourseId === courseIdRef.current) showNotice("课程资料已就绪");
      })
      .catch((error: Error) => {
        if (requestCourseId === courseIdRef.current) showNotice(error.message, "error");
      })
      .finally(() => {
        if (requestCourseId === courseIdRef.current) setBusy(false);
      });
  }, [courseId]);

  const selectCourse = (id: string) => {
    setTreeQuery("");
    setTab("current");
    navigateWithinApp(id ? `/knowledge?course=${encodeURIComponent(id)}` : "/knowledge");
  };

  const createCourse = async () => {
    try {
      setBusy(true);
      const course = await api<Course>("/api/courses", { method: "POST", body: JSON.stringify({ name: courseName }) });
      setCourseName("");
      await refreshCourses(course.id);
      showNotice(`已创建课程：${course.name}`);
    } catch (error) {
      showNotice((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!courseId || !files?.length) return;
    const requestCourseId = courseId;
    try {
      setBusy(true);
      showNotice("正在读取并整理资料…");
      const payload = {
        files: await Promise.all([...files].filter((file) => /\.md$/i.test(file.name)).map(async (file) => ({
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          content: await file.text(),
        }))),
      };
      if (!payload.files.length) throw new Error("目录中没有 Markdown 文件");
      const imported = await api<ImportSummary>(`/api/courses/${requestCourseId}/imports`, { method: "POST", body: JSON.stringify(payload) });
      if (requestCourseId !== courseIdRef.current) return;
      await loadDraft(requestCourseId, imported);
      const nextDrafts = await api<ImportSummary[]>(`/api/courses/${requestCourseId}/drafts`);
      if (requestCourseId !== courseIdRef.current) return;
      setDrafts(nextDrafts);
      setTab("draft");
      showNotice(`已从 ${payload.files.length} 个源文件生成修订草稿`);
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (directoryInput.current) directoryInput.current.value = "";
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const createRevision = async (releaseId: string) => {
    if (!courseId || !releaseId) return;
    const requestCourseId = courseId;
    try {
      setBusy(true);
      const revision = await api<ImportSummary>(`/api/courses/${requestCourseId}/releases/${releaseId}/revisions`, { method: "POST" });
      if (requestCourseId !== courseIdRef.current) return;
      await loadDraft(requestCourseId, revision);
      const nextDrafts = await api<ImportSummary[]>(`/api/courses/${requestCourseId}/drafts`);
      if (requestCourseId !== courseIdRef.current) return;
      setDrafts(nextDrafts);
      setTab("draft");
      showNotice(`已基于 ${releases.find((release) => release.id === releaseId)?.versionLabel ?? "所选版本"} 创建独立修订草稿，当前线上版本不受影响`);
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const persistDraft = async (): Promise<Draft | undefined> => {
    if (!courseId || !currentImport || !draft || !draftPath) return draft;
    if (!dirty) return draft;
    const targetCourseId = courseId;
    const importId = currentImport.id;
    const targetPath = draftPath;
    const content = draftContent;
    const updated = await api<Draft>(`/api/courses/${targetCourseId}/imports/${importId}/content`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: draft.version, path: targetPath, content }),
    });
    if (targetCourseId !== courseIdRef.current || importId !== currentImportIdRef.current || targetPath !== draftPathRef.current) return updated;
    setDraft(updated);
    setCurrentImport({ ...currentImport, draftVersion: updated.version, manifestHash: updated.manifestHash });
    setSavedDraftContent(content);
    const nextDrafts = await api<ImportSummary[]>(`/api/courses/${targetCourseId}/drafts`);
    if (targetCourseId === courseIdRef.current && importId === currentImportIdRef.current && targetPath === draftPathRef.current) setDrafts(nextDrafts);
    return updated;
  };

  const saveDraft = async () => {
    const requestCourseId = courseId;
    const importId = currentImport?.id;
    const targetPath = draftPath;
    try {
      setBusy(true);
      await persistDraft();
      if (requestCourseId === courseIdRef.current && importId === currentImportIdRef.current && targetPath === draftPathRef.current) showNotice("Markdown 修改已保存到修订草稿");
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const editTree = async (operation: { type: "rename"; path: string; name: string } | { type: "move"; path: string; directory: string }) => {
    if (!courseId || !currentImport || !draft) return;
    if (dirty && !window.confirm("当前正文尚未保存。继续将放弃这次正文修改，是否继续？")) return;
    const requestCourseId = courseId;
    const importId = currentImport.id;
    const targetPath = draftPath;
    try {
      setBusy(true);
      const next = await api<Draft>(`/api/courses/${requestCourseId}/imports/${importId}/tree`, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: draft.version, operations: [operation] }),
      });
      if (requestCourseId !== courseIdRef.current || importId !== currentImportIdRef.current || targetPath !== draftPathRef.current) return;
      setDraft(next);
      setCurrentImport({ ...currentImport, draftVersion: next.version, manifestHash: next.manifestHash });
      await readDraftFile(requestCourseId, importId, next.tree[0]?.path ?? "");
      const nextDrafts = await api<ImportSummary[]>(`/api/courses/${requestCourseId}/drafts`);
      if (requestCourseId !== courseIdRef.current || importId !== currentImportIdRef.current) return;
      setDrafts(nextDrafts);
      showNotice("草稿目录已更新");
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const rerun = async () => {
    if (!courseId || !currentImport) return;
    if (dirty && !window.confirm("重新整理会覆盖当前未保存的正文修改，是否继续？")) return;
    const requestCourseId = courseId;
    const importId = currentImport.id;
    const targetPath = draftPath;
    try {
      setBusy(true);
      showNotice("正在重新整理资料…");
      const next = await api<Draft>(`/api/courses/${requestCourseId}/imports/${importId}/rerun`, { method: "POST" });
      if (requestCourseId !== courseIdRef.current || importId !== currentImportIdRef.current || targetPath !== draftPathRef.current) return;
      setDraft(next);
      setCurrentImport({ ...currentImport, draftVersion: next.version, manifestHash: next.manifestHash });
      await readDraftFile(requestCourseId, importId, next.tree[0]?.path ?? "");
      showNotice("已生成新的草稿版本");
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const publish = async () => {
    if (!courseId || !currentImport || !draft) return;
    if (!window.confirm("发布后将生成新的不可变版本，并立即用于新的课程答疑会话。是否继续？")) return;
    const requestCourseId = courseId;
    const importId = currentImport.id;
    const targetPath = draftPath;
    try {
      setBusy(true);
      const readyDraft = await persistDraft();
      if (!readyDraft) return;
      if (requestCourseId !== courseIdRef.current || importId !== currentImportIdRef.current || targetPath !== draftPathRef.current) return;
      const release = await api<Release>(`/api/courses/${requestCourseId}/imports/${importId}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: readyDraft.version, expectedManifestHash: readyDraft.manifestHash }),
      });
      if (requestCourseId !== courseIdRef.current) return;
      await refreshWorkspace(requestCourseId, release.id);
      if (requestCourseId !== courseIdRef.current) return;
      setTab("current");
      showNotice(`已发布并启用 v${releases.length + 1}，历史版本仍可预览和切换`);
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const activate = async (releaseId: string) => {
    if (!courseId || releaseId === activeReleaseId) return;
    const requestCourseId = courseId;
    const label = releases.find((release) => release.id === releaseId)?.versionLabel ?? "所选版本";
    if (!window.confirm(`切换到 ${label} 后，新建答疑会话将使用该版本；已有会话仍保留原版本。是否继续？`)) return;
    try {
      setBusy(true);
      await api(`/api/courses/${requestCourseId}/active`, { method: "POST", body: JSON.stringify({ releaseId }) });
      if (requestCourseId !== courseIdRef.current) return;
      await refreshWorkspace(requestCourseId, releaseId, currentImport?.id);
      if (requestCourseId !== courseIdRef.current) return;
      setTab("current");
      showNotice(`已切换当前知识版本为 ${label}`);
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  const openRelease = async (releaseId: string) => {
    if (!courseId) return;
    const requestCourseId = courseId;
    try {
      setBusy(true);
      await loadRelease(requestCourseId, releaseId);
      if (requestCourseId !== courseIdRef.current) return;
      setTab("current");
      showNotice(releaseId === activeReleaseId ? "正在预览当前使用版本" : "正在只读预览历史版本");
    } catch (error) {
      if (requestCourseId === courseIdRef.current) showNotice((error as Error).message, "error");
    } finally {
      if (requestCourseId === courseIdRef.current) setBusy(false);
    }
  };

  return <div className="knowledge-page">
    <header className="workspace-header knowledge-header">
      <div>
        <p className="eyebrow">课程资料库</p>
        <h1>{currentCourse?.name ?? "导入、整理并发布课程知识"}</h1>
        <p>{activeRelease ? `当前使用 ${activeRelease.versionLabel} · ${formatDate(activeRelease.createdAt)}` : "尚未发布课程知识"}</p>
      </div>
      <div className="knowledge-header-actions">
        <button type="button" onClick={() => directoryInput.current?.click()} disabled={!courseId || busy}>导入资料</button>
        <button className="primary-button" type="button" onClick={() => void createRevision(activeReleaseId)} disabled={!activeReleaseId || busy}>创建修订</button>
      </div>
    </header>

    <input ref={directoryInput} className="visually-hidden" type="file" multiple accept=".md,text/markdown" aria-hidden="true" tabIndex={-1} onChange={(event) => void upload(event.target.files)} />

    <section className="knowledge-toolbar" aria-label="课程与版本概览">
      <label>当前课程
        <select value={courseId} onChange={(event) => selectCourse(event.target.value)} disabled={busy}>
          <option value="">选择课程</option>
          {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
        </select>
      </label>
      <div className="knowledge-stat"><span>发布版本</span><strong>{releases.length}</strong></div>
      <div className="knowledge-stat"><span>修订草稿</span><strong>{drafts.length}</strong></div>
      <details className="course-create">
        <summary>新建课程</summary>
        <div><input value={courseName} onChange={(event) => setCourseName(event.target.value)} placeholder="输入课程名称" /><button type="button" onClick={() => void createCourse()} disabled={!courseName.trim() || busy}>创建</button></div>
      </details>
    </section>

    <div className={`knowledge-notice ${noticeKind}`} role={noticeKind === "error" ? "alert" : "status"}>{busy && <span className="busy-dot" aria-hidden="true" />}{notice}</div>

    <nav className="knowledge-tabs" aria-label="资料库视图">
      <button type="button" className={tab === "current" ? "active" : ""} onClick={() => setTab("current")}>当前版本</button>
      <button type="button" className={tab === "draft" ? "active" : ""} onClick={() => setTab("draft")}>修订草稿 {drafts.length > 0 && <span>{drafts.length}</span>}</button>
      <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>版本记录</button>
    </nav>

    {tab === "current" && <section className="knowledge-workspace">
      {selectedRelease ? <>
        <div className="workspace-titlebar">
          <div><span className={`release-badge ${selectedRelease.id === activeReleaseId ? "active" : "history"}`}>{selectedRelease.id === activeReleaseId ? "当前使用" : "历史版本"}</span><h2>{selectedRelease.versionLabel}</h2><p>{formatDate(selectedRelease.createdAt)} · {releaseTree.length} 篇资料</p></div>
          <div><button type="button" onClick={() => void createRevision(selectedRelease.id)} disabled={busy}>基于此版本创建修订</button>{selectedRelease.id !== activeReleaseId && <button className="primary-button" type="button" onClick={() => void activate(selectedRelease.id)} disabled={busy}>切换为当前版本</button>}</div>
        </div>
        <div className="knowledge-browser">
          <aside className="document-tree"><label>查找资料<input type="search" value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="搜索标题或路径" /></label><p>{filteredReleaseTree.length} / {releaseTree.length} 篇</p><nav>{filteredReleaseTree.map((entry) => <button key={entry.path} type="button" className={entry.path === releasePath ? "selected" : ""} onClick={() => void readReleaseFile(courseId, selectedRelease.id, entry.path).catch((error: Error) => { if (entry.path === releasePathRef.current) showNotice(error.message, "error"); })}><strong>{entry.title}</strong><small>{entry.path}</small></button>)}</nav></aside>
          <article className="document-preview"><div className="document-heading"><div><span>只读预览</span><h2>{releaseTree.find((entry) => entry.path === releasePath)?.title ?? "选择一篇资料"}</h2></div><code title={releasePath}>{releasePath}</code></div>{releaseContent ? <Markdown remarkPlugins={[remarkGfm]}>{releaseContent}</Markdown> : <div className="knowledge-empty"><h3>选择左侧资料开始预览</h3><p>发布版本为不可变快照。如需修改，请先创建修订草稿。</p></div>}</article>
        </div>
      </> : <div className="knowledge-empty prominent"><h2>还没有正式课程资料</h2><p>导入 Markdown 目录生成草稿，确认内容后发布为首个知识版本。</p><button className="primary-button" type="button" onClick={() => directoryInput.current?.click()} disabled={!courseId || busy}>导入第一批资料</button></div>}
    </section>}

    {tab === "draft" && <section className="knowledge-workspace">
      {draft && currentImport ? <>
        <div className="workspace-titlebar">
          <div><span className="release-badge draft">可编辑草稿</span><h2>修订草稿 v{draft.version}</h2><p>{currentImport.baseReleaseId ? `基于 ${releases.find((release) => release.id === currentImport.baseReleaseId)?.versionLabel ?? "历史版本"}` : "来自新导入资料"} · {draft.tree.length} 篇资料</p></div>
          <div>{drafts.length > 1 && <select aria-label="切换修订草稿" value={currentImport.id} onChange={(event) => { const selected = drafts.find((item) => item.id === event.target.value); if (selected) void loadDraft(courseId, selected).catch((error: Error) => { if (selected.id === currentImportIdRef.current) showNotice(error.message, "error"); }); }}>{drafts.map((item, index) => <option key={item.id} value={item.id}>草稿 {drafts.length - index}{item.baseReleaseId ? ` · 基于 ${releases.find((release) => release.id === item.baseReleaseId)?.versionLabel ?? "历史版本"}` : " · 新导入"}</option>)}</select>}<button type="button" onClick={() => void rerun()} disabled={busy}>重新整理</button><button className="primary-button" type="button" onClick={() => void publish()} disabled={busy}>发布并启用</button></div>
        </div>
        <div className="knowledge-browser draft-browser">
          <aside className="document-tree"><label>查找草稿<input type="search" value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="搜索标题或路径" /></label><p>{filteredDraftTree.length} / {draft.tree.length} 篇</p><nav>{filteredDraftTree.map((entry) => <div className={`draft-tree-row ${entry.path === draftPath ? "selected" : ""}`} key={entry.path}><button type="button" onClick={() => { if (!dirty || window.confirm("放弃当前未保存的修改并切换文件？")) void readDraftFile(courseId, currentImport.id, entry.path).catch((error: Error) => { if (entry.path === draftPathRef.current) showNotice(error.message, "error"); }); }}><strong>{entry.title}</strong><small>{entry.path}</small></button><details><summary aria-label={`管理 ${entry.title}`}>···</summary><div><button type="button" onClick={() => { const name = window.prompt("新文件名（必须以 .md 结尾）", entry.path.split("/").at(-1)); if (name) void editTree({ type: "rename", path: entry.path, name }); }}>重命名</button><button type="button" onClick={() => { const directory = window.prompt("目标目录", entry.path.split("/").slice(0, -1).join("/")); if (directory) void editTree({ type: "move", path: entry.path, directory }); }}>移动</button></div></details></div>)}</nav></aside>
          <div className="document-workspace"><div className="draft-file-toolbar"><div><span>编辑 Markdown</span><strong>{draftPath || "选择一篇资料"}</strong></div><div><span className={dirty ? "save-state dirty" : "save-state"}>{dirty ? "有未保存修改" : "已保存"}</span><button type="button" onClick={() => void saveDraft()} disabled={!dirty || busy}>保存修改</button></div></div>{draftPath ? <div className="draft-editor-grid"><label>Markdown 源文<textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} spellCheck={false} aria-label="Markdown 源文" /></label><article className="document-preview"><div className="document-heading"><div><span>实时预览</span><h2>{draft.tree.find((entry) => entry.path === draftPath)?.title}</h2></div></div><Markdown remarkPlugins={[remarkGfm]}>{draftContent}</Markdown></article></div> : <div className="knowledge-empty"><h3>选择左侧草稿开始编辑</h3></div>}</div>
        </div>
      </> : <div className="knowledge-empty prominent"><h2>当前没有修订草稿</h2><p>可以导入一套新资料，也可以从当前正式版本创建独立修订；正式版本在发布新草稿前不会改变。</p><div><button type="button" onClick={() => directoryInput.current?.click()} disabled={!courseId || busy}>导入新资料</button><button className="primary-button" type="button" onClick={() => void createRevision(activeReleaseId)} disabled={!activeReleaseId || busy}>基于当前版本创建修订</button></div></div>}
    </section>}

    {tab === "history" && <section className="knowledge-workspace version-history">
      <div className="workspace-titlebar"><div><h2>版本记录</h2><p>每次发布都会生成不可变快照。切换当前版本不会修改或删除历史。</p></div></div>
      {releases.length ? <div className="release-list">{releases.map((release) => <article key={release.id} className={release.id === activeReleaseId ? "current" : ""}><div className="release-version"><strong>{release.versionLabel}</strong><span className={`release-badge ${release.id === activeReleaseId ? "active" : "history"}`}>{release.id === activeReleaseId ? "当前使用" : "历史版本"}</span></div><div><time>{formatDate(release.createdAt)}</time><code title={release.id}>{release.id.slice(0, 8)}</code></div><div className="release-actions"><button type="button" onClick={() => void openRelease(release.id)}>预览</button><button type="button" onClick={() => void createRevision(release.id)} disabled={busy}>创建修订</button>{release.id !== activeReleaseId && <button type="button" onClick={() => void activate(release.id)} disabled={busy}>切换为当前</button>}</div></article>)}</div> : <div className="knowledge-empty"><h3>尚未发布版本</h3><p>发布草稿后，版本记录会显示在这里。</p></div>}
    </section>}
  </div>;
}
