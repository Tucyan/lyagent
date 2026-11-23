import { useEffect, useState } from "react";
import { withJsonHeaders, apiFetch, apiErrorFromResponse } from "../lib/api";
import {
  activityPresentation,
  courseStatusPresentation,
  dashboardHeadlineSummary,
  dashboardOnboardingSteps,
  dashboardQuickActions,
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

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [runtime, setRuntime] = useState<DashboardRuntime>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

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
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const alerts = snapshot ? dashboardSystemAlerts(snapshot.model, runtime) : [];
  const readiness = snapshot ? systemReadinessSummary(snapshot.model, runtime) : undefined;
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
              : snapshot
                ? dashboardHeadlineSummary(snapshot.totals)
                : "正在加载课程信息…"}
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
          <a className="dashboard-primary-cta" href="/knowledge">
            {hasCourses ? "整理课程资料" : "创建第一门课程"}
          </a>
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

          {hasCourses ? (
            <section className="metric-grid dashboard-metric-grid" aria-label="教学概览">
              <div>
                <span>我的课程</span>
                <strong>{snapshot.totals.courses}</strong>
                <small>{snapshot.totals.publishedCourses} 门已开启答疑</small>
              </div>
              <div>
                <span>已生效资料</span>
                <strong>{snapshot.totals.activeDocuments}</strong>
                <small>可供课程答疑参考的讲义</small>
              </div>
              <div>
                <span>答疑记录</span>
                <strong>{snapshot.totals.qaSessions}</strong>
                <small>累计课程问答会话</small>
              </div>
            </section>
          ) : (
            <section className="dashboard-card dashboard-onboarding" aria-label="新手引导">
              <div className="section-heading">
                <div>
                  <h2>三步开始使用课程助教</h2>
                  <p>先建立课程资料库，再随时用于课程答疑与作业批改。</p>
                </div>
              </div>
              <ol className="dashboard-onboarding-steps">
                {dashboardOnboardingSteps.map((item) => (
                  <li key={item.step}>
                    <span className="dashboard-step-badge">{item.step}</span>
                    <div className="dashboard-step-body">
                      <strong>{item.title}</strong>
                      <p>{item.description}</p>
                    </div>
                    <a href={item.href}>{item.actionLabel}</a>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="dashboard-card dashboard-quick-actions">
            <div className="section-heading">
              <div>
                <h2>常用教学工作</h2>
                <p>从常见备课与批改场景直接开始。</p>
              </div>
            </div>
            <div>
              {dashboardQuickActions.map((action) => (
                <a key={action.href} href={action.href}>
                  <strong>{action.label}</strong>
                  <span>{action.description}</span>
                </a>
              ))}
            </div>
          </section>

          {hasCourses && (
            <section className="dashboard-card">
              <div className="section-heading">
                <div>
                  <h2>我的课程</h2>
                  <p>选择一门课程整理资料，或直接进入课程答疑。</p>
                </div>
                <a href="/knowledge">前往课程资料库</a>
              </div>
              <div className="dashboard-course-grid">
                {snapshot.courses.map((course) => {
                  const status = courseStatusPresentation(course.knowledgeStatus);
                  const updatedAt = course.activeRelease?.createdAt ?? course.lastActivityAt;
                  const courseParam = encodeURIComponent(course.id);
                  return (
                    <article key={course.id} className="dashboard-course-card">
                      <div className="dashboard-course-card-head">
                        <h3>{course.name}</h3>
                        <span className={`status ${status.tone}`}>{status.label}</span>
                      </div>
                      <p className="dashboard-course-meta">
                        <span>{course.documentCount} 份生效资料</span>
                        <span aria-hidden="true">·</span>
                        <span>{course.qaSessionCount} 次答疑</span>
                        <span aria-hidden="true">·</span>
                        <span>更新于 {shortDate(updatedAt)}</span>
                      </p>
                      <div className="dashboard-course-actions">
                        <a className="dashboard-course-btn secondary" href={`/knowledge?course=${courseParam}`}>
                          整理资料
                        </a>
                        {course.knowledgeStatus === "published" ? (
                          <a className="dashboard-course-btn primary" href={`/qa?course=${courseParam}`}>
                            进入答疑
                          </a>
                        ) : (
                          <span className="dashboard-course-hint">发布资料后可开启答疑</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {snapshot.recentActivity.length > 0 && (
            <section className="dashboard-card">
              <div className="section-heading">
                <div>
                  <h2>最近工作</h2>
                  <p>点击即可回到上次的教学任务继续处理。</p>
                </div>
              </div>
              <ol className="activity-list dashboard-activity-list">
                {snapshot.recentActivity.map((activity, index) => {
                  const item = activityPresentation(activity);
                  return (
                    <li key={`${activity.type}-${activity.at}-${index}`}>
                      <a className="dashboard-activity-link" href={item.href}>
                        <span className="activity-dot" aria-hidden="true" />
                        <div className="dashboard-activity-copy">
                          <strong>{item.title}</strong>
                          <p>{item.description}</p>
                        </div>
                        <div className="dashboard-activity-right">
                          <time dateTime={activity.at}>{dateTime(activity.at)}</time>
                          <span className="dashboard-activity-cta">{item.actionLabel} →</span>
                        </div>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
