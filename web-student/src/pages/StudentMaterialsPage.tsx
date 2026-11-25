import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StudentApiError, studentJson } from "../lib/api";

interface KnowledgeDoc {
  path: string;
  title: string;
}

interface SearchHit {
  path: string;
  title: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

const NAV_COLLAPSED_KEY = "student-materials-nav-collapsed";

export function StudentMaterialsPage({ courseId }: { courseId: string }) {
  const [courseName, setCourseName] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [releasedAt, setReleasedAt] = useState("");
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(NAV_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggleNav = () => {
    setNavCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSearchResults(null);
    setSearchQuery("");
    void studentJson<{
      course: { id: string; name: string };
      release: { id: string; createdAt: string };
      documents: KnowledgeDoc[];
    }>(`/api/student/courses/${encodeURIComponent(courseId)}/tree`)
      .then((res) => {
        if (cancelled) return;
        setCourseName(res.course.name);
        setReleaseId(res.release.id);
        setReleasedAt(res.release.createdAt);
        setDocuments(res.documents);
        const firstPath = res.documents[0]?.path ?? "";
        setSelectedPath(firstPath);
        if (!firstPath) setContent("");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof StudentApiError ? err.message : "加载课程目录失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !selectedPath || !releaseId) return;
    let cancelled = false;
    setError("");
    void studentJson<{ content: string }>(
      `/api/student/courses/${encodeURIComponent(courseId)}/document?path=${encodeURIComponent(selectedPath)}&releaseId=${encodeURIComponent(releaseId)}`,
    )
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof StudentApiError ? err.message : "加载文档内容失败");
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, selectedPath, releaseId]);

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q || !courseId) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const res = await studentJson<{ results: SearchHit[] }>(
        `/api/student/courses/${encodeURIComponent(courseId)}/search?q=${encodeURIComponent(q)}&maxResults=10`,
      );
      setSearchResults(res.results);
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "搜索失败");
    } finally {
      setSearching(false);
    }
  };

  if (!courseId) {
    return (
      <div className="st-card st-empty-state">
        <h2>暂无可查看的课程资料</h2>
        <p>请先等待授课教师为您开通课程权限并发布课程资料。</p>
      </div>
    );
  }

  const activeDoc = documents.find((d) => d.path === selectedPath);

  return (
    <div className="st-materials-page">
      <header className="st-materials-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <button
            type="button"
            className="st-icon-btn"
            onClick={toggleNav}
            title={navCollapsed ? "展开资料目录" : "收起资料目录"}
            aria-label={navCollapsed ? "展开资料目录" : "收起资料目录"}
          >
            {navCollapsed ? "»" : "«"}
          </button>
          <div style={{ minWidth: 0 }}>
            <h1 title={activeDoc?.title ?? (courseName || "课程资料")}>
              {activeDoc?.title ?? (courseName || "课程资料")}
            </h1>
            <p title={selectedPath || courseName}>
              {[
                courseName || "课程资料",
                selectedPath,
                releasedAt ? `更新于 ${new Date(releasedAt).toLocaleString("zh-CN")}` : "正在加载…",
                documents.length > 0 ? `共 ${documents.length} 篇` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
      </header>

      {error && <div className="student-error-banner" style={{ margin: "10px 20px 0" }}>{error}</div>}

      <div className={`st-materials-shell ${navCollapsed ? "nav-collapsed" : ""}`}>
        <aside className="st-materials-nav" aria-hidden={navCollapsed}>
          <div className="st-materials-nav-inner">
            <div className="st-materials-search">
              <input
                className="student-input"
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value.trim()) setSearchResults(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                placeholder="搜索关键词…"
                style={{ padding: "6px 10px", fontSize: 13 }}
              />
              <button
                type="button"
                className="st-btn st-btn-sm"
                disabled={searching}
                onClick={() => void handleSearch()}
              >
                {searching ? "…" : "搜索"}
              </button>
            </div>

            <div className="st-materials-list">
              {searchResults !== null ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    <span>找到 {searchResults.length} 条结果</span>
                    <button
                      type="button"
                      className="student-link"
                      style={{ border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: 12 }}
                      onClick={() => {
                        setSearchResults(null);
                        setSearchQuery("");
                      }}
                    >
                      返回目录
                    </button>
                  </div>
                  {searchResults.length === 0 ? (
                    <div className="st-empty-state" style={{ padding: "24px 10px" }}>
                      <p>未找到包含“{searchQuery}”的内容</p>
                    </div>
                  ) : (
                    searchResults.map((hit, idx) => (
                      <button
                        key={`${hit.path}-${hit.startLine}-${idx}`}
                        type="button"
                        className={`student-doc-item ${selectedPath === hit.path ? "active" : ""}`}
                        onClick={() => setSelectedPath(hit.path)}
                      >
                        <strong>{hit.title}</strong>
                        <small>{hit.path} · 第 {hit.startLine} 行</small>
                        <small style={{ color: "var(--text-secondary)" }}>
                          {hit.excerpt.trim() || "（匹配文档标题或路径）"}
                        </small>
                      </button>
                    ))
                  )}
                </>
              ) : loading ? (
                <div className="st-empty-state" style={{ padding: "24px 10px" }}>
                  <p>正在加载课程目录…</p>
                </div>
              ) : documents.length === 0 ? (
                <div className="st-empty-state" style={{ padding: "24px 10px" }}>
                  <p>该课程暂未包含文档</p>
                </div>
              ) : (
                documents.map((doc) => (
                  <button
                    key={doc.path}
                    type="button"
                    className={`student-doc-item ${selectedPath === doc.path ? "active" : ""}`}
                    onClick={() => setSelectedPath(doc.path)}
                  >
                    <strong>{doc.title}</strong>
                    <small>{doc.path}</small>
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>

        <article className="st-materials-reader">
          {selectedPath ? (
            <div className="st-reader-body">
              <div className="markdown-body st-reader-prose">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  urlTransform={(url) => resolveReleaseAssetUrl(url, courseId, releaseId, selectedPath)}
                >
                  {content}
                </Markdown>
              </div>
            </div>
          ) : (
            <div className="st-empty-state" style={{ margin: "auto" }}>
              <h3>请选择左侧章节</h3>
              <p>点击目录中的任意章节即可在此阅读完整课程讲义。</p>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function resolveReleaseAssetUrl(rawUrl: string, courseId: string, releaseId: string, docPath: string): string {
  if (!rawUrl || /^(https?:|data:|mailto:|#)/i.test(rawUrl)) return rawUrl;
  const baseDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/") + 1) : "";
  const combined = `${baseDir}${rawUrl}`.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const safePath = segments.join("/");
  return `/api/student/courses/${encodeURIComponent(courseId)}/releases/${encodeURIComponent(releaseId)}/assets/${safePath}`;
}
