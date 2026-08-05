import { useEffect, useState } from "react";
import { withJsonHeaders } from "../lib/api";
import { converterStatusLabel, dashboardQuickActions } from "./dashboard-model";

type DashboardCourse = {
  id: string;
  name: string;
  createdAt: string;
  knowledgeStatus: "published" | "unpublished" | "unavailable";
  activeRelease: { id: string; createdAt: string } | null;
  releaseCount: number;
  documentCount: number;
  qaSessionCount: number;
  lastActivityAt: string;
};
type DashboardActivity =
  | { type: "course_created"; courseId: string; courseName: string; at: string }
  | { type: "release_published"; courseId: string; courseName: string; releaseId: string; at: string }
  | { type: "qa_session_updated"; courseId: string; courseName: string; sessionId: string; summary: string; at: string };
type DashboardSnapshot = {
  generatedAt: string;
  model: { provider: string; model: string; configured: boolean };
  totals: { courses: number; publishedCourses: number; activeDocuments: number; qaSessions: number };
  courses: DashboardCourse[];
  recentActivity: DashboardActivity[];
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, withJsonHeaders());
  if (!response.ok) throw new Error((await response.json().catch(() => ({ message: response.statusText }))).message ?? "请求失败");
  return response.json() as Promise<T>;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function activityText(activity: DashboardActivity): string {
  if (activity.type === "course_created") return "创建了课程";
  if (activity.type === "release_published") return "发布了知识版本";
  return `更新了答疑会话：${activity.summary}`;
}

const statusLabel: Record<DashboardCourse["knowledgeStatus"], string> = {
  published: "已发布",
  unpublished: "未发布",
  unavailable: "版本不可用",
};

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [runtime, setRuntime] = useState<{ converter: { provider: "docling"; status: "starting" | "ready" | "unavailable"; device: "auto" | "cpu" } }>();
  const [notice, setNotice] = useState("正在加载工作台…");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const [next, nextRuntime] = await Promise.all([api<DashboardSnapshot>("/api/dashboard"), api<{ converter: { provider: "docling"; status: "starting" | "ready" | "unavailable"; device: "auto" | "cpu" } }>("/api/system/runtime")]);
      setSnapshot(next);
      setRuntime(nextRuntime);
      setNotice(`数据更新于 ${dateTime(next.generatedAt)}`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  return <div className="dashboard-page">
    <header className="workspace-header"><div><p className="eyebrow">教师工作台</p><h1>课程总览</h1><p>{notice}</p></div><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新数据"}</button></header>
    {snapshot && <>
      <section className="model-status" aria-label="模型配置状态"><span>模型配置</span><strong>{snapshot.model.provider} / {snapshot.model.model}</strong><span className={snapshot.model.configured ? "status published" : "status unpublished"}>{snapshot.model.configured ? "已配置" : "未配置"}</span></section>
      {runtime && <section className="model-status" aria-label="文档转换器状态"><span>文档转换器</span><strong>{converterStatusLabel(runtime.converter)}</strong></section>}
      <section className="metric-grid" aria-label="课程数据概览">
        <div><span>课程</span><strong>{snapshot.totals.courses}</strong><small>{snapshot.totals.publishedCourses} 门已发布</small></div>
        <div><span>已发布资料</span><strong>{snapshot.totals.activeDocuments}</strong><small>当前 active release 文档</small></div>
        <div><span>答疑会话</span><strong>{snapshot.totals.qaSessions}</strong><small>本地已保存会话</small></div>
        <div><span>知识版本</span><strong>{snapshot.courses.reduce((total, course) => total + course.releaseCount, 0)}</strong><small>不可变发布记录</small></div>
      </section>
      <section className="dashboard-card dashboard-quick-actions"><div className="section-heading"><div><h2>快捷开始</h2><p>从常用教学工作中继续。</p></div></div><div>{dashboardQuickActions.map((action) => <a key={action.href} href={action.href}><strong>{action.label}</strong><span>{action.description}</span></a>)}</div></section>
      <section className="dashboard-card"><div className="section-heading"><div><h2>课程状态</h2><p>只统计当前已发布资料与本地答疑会话。</p></div><a href="/knowledge">管理课程资料</a></div>
        {snapshot.courses.length === 0 ? <div className="dashboard-empty"><h3>还没有课程</h3><p>先创建课程并导入已整理的 Markdown 资料，随后可发布为答疑可读的知识版本。</p><a href="/knowledge">前往课程资料库</a></div> : <div className="course-table-wrap"><table><thead><tr><th>课程</th><th>资料状态</th><th>文档</th><th>版本</th><th>答疑会话</th><th>最近活动</th><th>操作</th></tr></thead><tbody>{snapshot.courses.map((course) => <tr key={course.id}><td><strong>{course.name}</strong><small>{course.activeRelease ? `当前版本 ${course.activeRelease.id.slice(0, 8)}` : "尚无当前版本"}</small></td><td><span className={`status ${course.knowledgeStatus}`}>{statusLabel[course.knowledgeStatus]}</span></td><td>{course.documentCount}</td><td>{course.releaseCount}</td><td>{course.qaSessionCount}</td><td>{dateTime(course.lastActivityAt)}</td><td className="course-links"><a href={`/knowledge?course=${encodeURIComponent(course.id)}`}>资料</a>{course.knowledgeStatus === "published" ? <a href={`/qa?course=${encodeURIComponent(course.id)}`}>答疑</a> : <span>答疑不可用</span>}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><h2>最近活动</h2><p>显示最近八条实际发生的课程、发布和答疑活动。</p></div></div>
        {snapshot.recentActivity.length === 0 ? <p className="empty-activity">暂无活动记录。</p> : <ol className="activity-list">{snapshot.recentActivity.map((activity, index) => <li key={`${activity.type}-${activity.at}-${index}`}><span className="activity-dot" /><div><strong>{activity.courseName}</strong><p>{activityText(activity)}</p></div><time dateTime={activity.at}>{dateTime(activity.at)}</time></li>)}</ol>}
      </section>
    </>}
  </div>;
}
