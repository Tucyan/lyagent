import { useState, type ReactNode } from "react";
import { navigateStudent, studentJson } from "../lib/api";

export interface StudentUser {
  id: string;
  username: string;
  displayName: string;
  role: "teacher" | "student";
  status: "active" | "disabled";
  mustChangePassword: boolean;
}

export interface StudentCourseOption {
  id: string;
  name: string;
  activeReleaseId: string;
  releasedAt: string;
}

export type StudentActiveTab = "materials" | "qa" | "admin";

const COMPACT_STORAGE_KEY = "student-nav-compact";

function NavIcon({ path }: { path: string }) {
  return (
    <svg
      className="admin-nav-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function readCompactPreference(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function StudentShell({
  user,
  active,
  courses,
  courseId,
  onSelectCourse,
  onLoggedOut,
  onOpenChangePassword,
  children,
}: {
  user: StudentUser;
  active: StudentActiveTab;
  courses: StudentCourseOption[];
  courseId: string;
  onSelectCourse: (courseId: string) => void;
  onLoggedOut: () => void;
  onOpenChangePassword: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(readCompactPreference);

  const toggleCompact = () => {
    setCompact((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COMPACT_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleLogout = async () => {
    await studentJson("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLoggedOut();
  };

  const courseQuery = courseId ? `?course=${encodeURIComponent(courseId)}` : "";

  const renderLink = (tab: StudentActiveTab, href: string, label: string, iconPath: string) => (
    <a
      className={active === tab ? "active" : ""}
      href={href}
      title={compact ? label : undefined}
      aria-label={label}
      aria-current={active === tab ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        setOpen(false);
        navigateStudent(href);
      }}
    >
      <NavIcon path={iconPath} />
      <span className="admin-nav-text">{label}</span>
    </a>
  );

  return (
    <div className={`admin-shell ${compact ? "nav-compact" : ""}`}>
      <button
        className="admin-menu-toggle"
        type="button"
        aria-label="打开导航菜单"
        onClick={() => setOpen(true)}
      >
        ☰
      </button>
      {open && (
        <button
          className="admin-nav-backdrop"
          type="button"
          aria-label="关闭导航菜单"
          onClick={() => setOpen(false)}
        />
      )}

      <aside className={`admin-nav ${open ? "open" : ""}`} aria-label="学生端导航">
        <div className="admin-brand">
          <strong className="admin-brand-name" title="Course Agent">
            <span className="admin-brand-mark" aria-hidden="true">CA</span>
            <span className="admin-nav-text">Course Agent</span>
          </strong>
          <button
            className="admin-compact-toggle"
            type="button"
            onClick={toggleCompact}
            aria-label={compact ? "展开侧边导航" : "收起侧边导航"}
            title={compact ? "展开导航" : "收起为图标轨"}
          >
            {compact ? "»" : "«"}
          </button>
          <button
            className="admin-nav-close"
            type="button"
            aria-label="关闭导航菜单"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="admin-course-switcher">
          {courses.length > 0 ? (
            <label>
              <span className="admin-nav-label">当前课程</span>
              <select
                aria-label="切换当前课程"
                value={courseId}
                onChange={(event) => {
                  onSelectCourse(event.target.value);
                  setOpen(false);
                }}
              >
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="admin-nav-label" style={{ padding: "6px 4px" }}>
              暂无已授权课程
            </div>
          )}
        </div>

        <div className="admin-nav-groups">
          <div className="admin-nav-group">
            <p className="admin-nav-label">课程学习</p>
            <nav>
              {renderLink(
                "materials",
                `/materials${courseQuery}`,
                "课程资料",
                "M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15.5v-11ZM7 7h6M7 10h6M7 13h4",
              )}
              {renderLink(
                "qa",
                `/qa${courseQuery}`,
                "课程答疑",
                "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6A1.5 1.5 0 0 1 14.5 13H9l-3.5 3v-3H5.5A1.5 1.5 0 0 1 4 11.5v-6Z",
              )}
            </nav>
          </div>

          {user.role === "teacher" && (
            <div className="admin-nav-group">
              <p className="admin-nav-label">教师后台</p>
              <nav>
                {renderLink(
                  "admin",
                  "/admin",
                  "账号与额度管理",
                  "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5 5l1.1 1.1M13.9 13.9 15 15M15 5l-1.1 1.1M6.1 13.9 5 15",
                )}
              </nav>
            </div>
          )}
        </div>

        <div className="admin-nav-footer">
          <div className="student-user-footer">
            <div className="student-user-badge">
              <strong>{user.displayName}</strong>
              <span>{user.username} · {user.role === "teacher" ? "教师管理员" : "学生"}</span>
            </div>
            <div className="student-user-actions">
              <button type="button" className="st-btn st-btn-sm" onClick={onOpenChangePassword}>
                改密码
              </button>
              <button type="button" className="st-btn st-btn-sm" onClick={handleLogout}>
                退出
              </button>
            </div>
            <div className="student-compact-logout">
              <button type="button" className="st-btn st-btn-sm" title="退出登录" onClick={handleLogout}>
                退出
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className={`admin-main ${active === "qa" ? "st-main-qa" : ""}`}>{children}</main>
    </div>
  );
}
