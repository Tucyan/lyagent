export interface QaCourse { id: string; name: string; }
export interface QaSessionSummary { id: string; summary: string; updatedAt: string; }

export function ChatSidebar({ courses, courseId, sessions, activeSessionId, onCourseChange, onNewChat, onRename, onDelete, open, onClose }: { courses: QaCourse[]; courseId: string; sessions: QaSessionSummary[]; activeSessionId?: string; onCourseChange(courseId: string): void; onNewChat(): void; onRename(session: QaSessionSummary): void; onDelete(session: QaSessionSummary): void; open: boolean; onClose(): void }) {
  return <aside className={`chat-sidebar ${open ? "open" : ""}`} aria-label="答疑会话">
    <div className="sidebar-heading"><strong>课程答疑</strong><button className="mobile-only" onClick={onClose} aria-label="关闭会话侧栏">×</button></div>
    <select value={courseId} onChange={(event) => onCourseChange(event.target.value)} aria-label="选择课程"><option value="">选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select>
    <button className="new-chat" onClick={onNewChat} disabled={!courseId}>＋ 新建对话</button>
    <p className="sidebar-label">最近对话</p>
    <nav>{sessions.length === 0 ? <p className="muted">尚无对话</p> : sessions.map((session) => <div className={`session-row ${activeSessionId === session.id ? "active" : ""}`} key={session.id}><button className="session-link" onClick={() => location.assign(`/qa?course=${encodeURIComponent(courseId)}&session=${encodeURIComponent(session.id)}`)}>{session.summary}</button><div className="session-actions"><button className="session-action" type="button" onClick={() => onRename(session)} aria-label={`重命名会话：${session.summary}`} title="重命名">✎</button><button className="session-action delete" type="button" onClick={() => onDelete(session)} aria-label={`删除会话：${session.summary}`} title="删除">🗑</button></div></div>)}</nav>
    <a className="back-library" href="/">← 返回工作台</a>
  </aside>;
}
