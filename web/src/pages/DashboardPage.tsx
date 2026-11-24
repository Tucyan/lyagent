import { useEffect, useState, type FormEvent } from "react";
import { withJsonHeaders, apiFetch, apiErrorFromResponse } from "../lib/api";
import {
  COURSE_CHANGED_EVENT,
  notifyCoursesUpdated,
  readCourseFromUrl,
  resolveActiveCourseId,
  selectActiveCourse,
  withCourseQuery,
} from "../lib/course-context";
import {
  courseStatusPresentation,
  dashboardSystemAlerts,
  systemReadinessSummary,
  type DashboardRuntime,
  type DashboardSnapshot,
} from "./dashboard-model";

async function api<T>(url: string): Promise<T> {
  const response = await apiFetch(url, withJsonHeaders());
  if (!response.ok) throw await apiErrorFromResponse(response, "请求失败");
  return response.json() as Promise<T>;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function KnowledgeFlowIcon() {
  return (
    <svg className="dashboard-flow-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="7" width="24" height="32" rx="4" />
      <path d="M16 15h10M16 22h10M16 29h6" />
      <path d="M33 14h4a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3H17" />
    </svg>
  );
}

function QaFlowIcon() {
  return (
    <svg className="dashboard-flow-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 13a5 5 0 0 1 5-5h20a5 5 0 0 1 5 5v15a5 5 0 0 1-5 5H21l-8 7v-7h-0a4 4 0 0 1-4-4V13Z" />
      <path d="M18 18h12M18 24h8" />
    </svg>
  );
}

function RubricFlowIcon() {
  return (
    <svg className="dashboard-flow-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="10" y="8" width="28" height="33" rx="4" />
      <path d="M18 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
      <path d="M16 19l2.5 2.5L23 17M27 19h5M16 28l2.5 2.5L23 26M27 28h5" />
    </svg>
  );
}

function SingleGradingFlowIcon() {
  return (
    <svg className="dashboard-flow-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 7h15l9 9v24a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3Z" />
      <path d="M28 7v9h9" />
      <path d="M17 28l4 4 9-9" />
    </svg>
  );
}

function BatchGradingFlowIcon() {
  return (
    <svg className="dashboard-flow-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="14" width="26" height="27" rx="4" />
      <path d="M14 9h20a4 4 0 0 1 4 4v21" />
      <path d="M15 24h12M15 30h8" />
      <path d="M24 33l3 3 5-6" />
    </svg>
  );
}

function FlowArrow() {
  return (
    <div className="dashboard-flow-arrow" aria-hidden="true">
      <svg viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12h22M19 6l7 6-7 6" />
      </svg>
    </div>
  );
}

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [runtime, setRuntime] = useState<DashboardRuntime>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [activeCourseId, setActiveCourseId] = useState(() => readCourseFromUrl());
  const [newCourseName, setNewCourseName] = useState("");
  const [creatingCourse, setCreatingCourse] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    setErrorMessage(undefined);
    try {
      const [next, nextRuntime] = await Promise.all([
        api<DashboardSnapshot>("/api/dashboard"),
        api<DashboardRuntime>("/api/system/runtime"),
      ]);
      setSnapshot(next);
      setRuntime(nextRuntime);
      setActiveCourseId(resolveActiveCourseId(next.courses, readCourseFromUrl()));
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    const syncCourse = () => {
      setErrorMessage(undefined);
      setSnapshot((current) => {
        if (current) setActiveCourseId(resolveActiveCourseId(current.courses, readCourseFromUrl()));
        return current;
      });
    };
    window.addEventListener("popstate", syncCourse);
    window.addEventListener(COURSE_CHANGED_EVENT, syncCourse);
    return () => {
      window.removeEventListener("popstate", syncCourse);
      window.removeEventListener(COURSE_CHANGED_EVENT, syncCourse);
    };
  }, []);

  const createCourse = async (event: FormEvent) => {
    event.preventDefault();
    const name = newCourseName.trim();
    if (!name || creatingCourse) return;
    setCreatingCourse(true);
    setErrorMessage(undefined);
    try {
      const response = await apiFetch(
        "/api/courses",
        withJsonHeaders({
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      );
      if (!response.ok) throw await apiErrorFromResponse(response, "创建课程失败");
      const created = (await response.json()) as { id: string };
      setNewCourseName("");
      notifyCoursesUpdated(created.id);
      selectActiveCourse(created.id, "/");
      await refresh();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setCreatingCourse(false);
    }
  };

  const alerts = snapshot ? dashboardSystemAlerts(snapshot.model, runtime) : [];
  const readiness = snapshot ? systemReadinessSummary(snapshot.model, runtime) : undefined;
  const activeCourse = snapshot?.courses.find((course) => course.id === activeCourseId) ?? snapshot?.courses[0];
  const hasCourses = (snapshot?.courses.length ?? 0) > 0;

  return (
    <div className="dashboard-page">
      <header className="workspace-header dashboard-header">
        <div>
          <p className="eyebrow">教师工作台</p>
          <h1>课程总览</h1>
          <p>
            {errorMessage
              ? errorMessage
              : !snapshot
                ? "正在加载课程数据…"
                : activeCourse
                  ? `当前正在处理「${activeCourse.name}」，可按下方流程直接开始备课或批改。`
                  : "先创建一门课程，再按下方流程开始资料答疑或作业批改。"}
          </p>
        </div>
        <div className="dashboard-header-actions">
          {readiness && (
            <a
              className={`dashboard-readiness-pill ${readiness.tone}`}
              href={readiness.href}
              title={readiness.title}
            >
              <span className="dashboard-readiness-dot" aria-hidden="true" />
              {readiness.label}
            </a>
          )}
          <button
            className="dashboard-refresh-button"
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            title={snapshot ? `最近更新于 ${dateTime(snapshot.generatedAt)}` : "刷新课程数据"}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {snapshot && (
        <>
          {alerts.length > 0 && (
            <section className="dashboard-alerts" aria-label="系统提醒">
              {alerts.map((alert) => (
                <div key={alert.id} className={`dashboard-alert ${alert.tone}`} role="status">
                  <div>
                    <strong>{alert.title}</strong>
                    <p>{alert.detail}</p>
                  </div>
                  {alert.actionHref && alert.actionLabel && (
                    <a className="dashboard-alert-action" href={alert.actionHref}>
                      {alert.actionLabel}
                    </a>
                  )}
                </div>
              ))}
            </section>
          )}

          {/* 1. 课程管理 */}
          <section className="dashboard-card" aria-label="课程管理">
            <div className="section-heading">
              <div>
                <h2>课程管理</h2>
                <p>在这里统一新建或切换课程，各工作区会自动隔离显示当前课程的内容。</p>
              </div>
              <form className="dashboard-course-create" onSubmit={(event) => void createCourse(event)}>
                <input
                  aria-label="新课程名称"
                  value={newCourseName}
                  onChange={(event) => setNewCourseName(event.target.value)}
                  placeholder="输入新课程名称，例如：数据结构"
                  maxLength={100}
                />
                <button className="primary-button" type="submit" disabled={!newCourseName.trim() || creatingCourse}>
                  {creatingCourse ? "创建中…" : "新建课程"}
                </button>
              </form>
            </div>

            {hasCourses ? (
              <div className="dashboard-course-grid">
                {snapshot.courses.map((course) => {
                  const status = courseStatusPresentation(course.knowledgeStatus);
                  const isCurrent = course.id === activeCourse?.id;
                  return (
                    <article key={course.id} className={`dashboard-course-card ${isCurrent ? "is-active" : ""}`}>
                      <div className="dashboard-course-card-head">
                        <h3>{course.name}</h3>
                        <div className="dashboard-course-badges">
                          {isCurrent && <span className="status published">当前课程</span>}
                          <span className={`status ${status.tone}`}>{status.label}</span>
                        </div>
                      </div>
                      <p className="dashboard-course-meta">
                        <span>{course.documentCount} 份生效讲义</span>
                        <span aria-hidden="true">·</span>
                        <span>{course.qaSessionCount} 次答疑对话</span>
                      </p>
                      <div className="dashboard-course-actions">
                        <button
                          type="button"
                          className={`dashboard-course-btn ${isCurrent ? "secondary" : "primary"}`}
                          disabled={isCurrent}
                          onClick={() => selectActiveCourse(course.id, "/")}
                        >
                          {isCurrent ? "当前使用中" : "设为当前课程"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="dashboard-empty-hint">还没有课程，先在右上角输入课程名称创建第一门课吧。</p>
            )}
          </section>

          {/* 2. 课程与知识：资料 → 答疑 */}
          <section className="dashboard-card" aria-label="课程与知识">
            <div className="section-heading">
              <div>
                <h2>课程与知识</h2>
                <p>准备好课程讲义后，助教就能依据你的资料为学生答疑解惑。</p>
              </div>
            </div>
            <div className="dashboard-flow-row two-steps">
              <a className="dashboard-flow-card" href={withCourseQuery("/knowledge", activeCourse?.id ?? "")}>
                <KnowledgeFlowIcon />
                <div className="dashboard-flow-body">
                  <strong>1. 课程资料库</strong>
                  <p>导入并发布 Markdown 讲义，作为助教回答问题的知识依据。</p>
                </div>
              </a>
              <FlowArrow />
              <a className="dashboard-flow-card" href={withCourseQuery("/qa", activeCourse?.id ?? "")}>
                <QaFlowIcon />
                <div className="dashboard-flow-body">
                  <strong>2. 课程答疑</strong>
                  <p>基于已发布的课程资料提问，回答会附上可核查的原文引用。</p>
                </div>
              </a>
            </div>
          </section>

          {/* 3. 评分与批改：定标准 → 单份 / 批量批改 */}
          <section className="dashboard-card" aria-label="评分与批改">
            <div className="section-heading">
              <div>
                <h2>评分与批改</h2>
                <p>先与 AI 一起定好评分标准，再进行单份精批或整班批量批改。</p>
              </div>
            </div>
            <div className="dashboard-flow-row grading-steps">
              <a className="dashboard-flow-card" href={withCourseQuery("/rubrics", activeCourse?.id ?? "")}>
                <RubricFlowIcon />
                <div className="dashboard-flow-body">
                  <strong>1. 制定评分标准</strong>
                  <p>说明作业要求或导入草稿，由 AI 协助梳理细则并定稿。</p>
                </div>
              </a>
              <FlowArrow />
              <div className="dashboard-grading-pair">
                <a className="dashboard-flow-card" href={withCourseQuery("/grading", activeCourse?.id ?? "")}>
                  <SingleGradingFlowIcon />
                  <div className="dashboard-flow-body">
                    <strong>2A. 单份批改</strong>
                    <p>上传一份学生报告，逐项生成得分、评语并支持对话微调。</p>
                  </div>
                </a>
                <a className="dashboard-flow-card" href={withCourseQuery("/grading/batches", activeCourse?.id ?? "")}>
                  <BatchGradingFlowIcon />
                  <div className="dashboard-flow-body">
                    <strong>2B. 批量批改</strong>
                    <p>一次上传全班作业，自动批改后集中复核并导出成绩表。</p>
                  </div>
                </a>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
