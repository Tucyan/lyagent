import { useEffect, useState, type ReactNode } from "react";

export type ActivePage = "dashboard" | "knowledge" | "qa" | "rubrics" | "grading" | "batch-grading" | "model-settings";

interface NavItem {
  id: ActivePage;
  href: string;
  label: string;
  icon: ReactNode;
}

const COMPACT_STORAGE_KEY = "admin-nav-compact";

function NavIcon({ path }: { path: string }) {
  return <svg className="admin-nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "工作台",
    items: [
      { id: "dashboard", href: "/", label: "课程总览", icon: <NavIcon path="M3.5 9.5 10 4l6.5 5.5v6.5a1 1 0 0 1-1 1h-3.8v-4.5H8.3V17H4.5a1 1 0 0 1-1-1V9.5Z" /> },
    ],
  },
  {
    label: "课程与知识",
    items: [
      { id: "knowledge", href: "/knowledge", label: "课程资料库", icon: <NavIcon path="M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15.5v-11ZM7 7h6M7 10h6M7 13h4" /> },
      { id: "qa", href: "/qa", label: "课程答疑", icon: <NavIcon path="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6A1.5 1.5 0 0 1 14.5 13H9l-3.5 3v-3H5.5A1.5 1.5 0 0 1 4 11.5v-6Z" /> },
    ],
  },
  {
    label: "评分与批改",
    items: [
      { id: "rubrics", href: "/rubrics", label: "评分量表", icon: <NavIcon path="M4.5 5h11M4.5 10h11M4.5 15h7M14.5 13.5l1.5 1.5 2.5-3" /> },
      { id: "grading", href: "/grading", label: "单份批改", icon: <NavIcon path="M5 3.5h7l3 3v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM7.5 10.5l1.8 1.8 3.4-3.6" /> },
      { id: "batch-grading", href: "/grading/batches", label: "批量批改", icon: <NavIcon path="M3.5 6.5h13v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9ZM6 3.5h8M7 10.5h6M7 13.5h4" /> },
    ],
  },
];

const settingsItem: NavItem = {
  id: "model-settings",
  href: "/settings/models",
  label: "模型设置",
  icon: <NavIcon path="M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5 5l1.1 1.1M13.9 13.9 15 15M15 5l-1.1 1.1M6.1 13.9 5 15" />,
};

function readCompactPreference(compactDefault: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(COMPACT_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch {
    // Ignore storage access failures.
  }
  return compactDefault;
}

export function AdminShell({
  active,
  compactDefault = false,
  children,
}: {
  active: ActivePage;
  compactDefault?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(() => readCompactPreference(compactDefault));

  useEffect(() => {
    try {
      if (window.localStorage.getItem(COMPACT_STORAGE_KEY) === null) {
        setCompact(compactDefault);
      }
    } catch {
      setCompact(compactDefault);
    }
  }, [compactDefault]);

  const toggleCompact = () => {
    setCompact((current) => {
      const next = !current;
      try { window.localStorage.setItem(COMPACT_STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const renderLink = (item: NavItem) => (
    <a
      className={active === item.id ? "active" : ""}
      key={item.id}
      href={item.href}
      title={compact ? item.label : undefined}
      aria-label={item.label}
      aria-current={active === item.id ? "page" : undefined}
      onClick={() => setOpen(false)}
    >
      {item.icon}
      <span className="admin-nav-text">{item.label}</span>
    </a>
  );

  return <div className={`admin-shell ${compact ? "nav-compact" : ""}`}>
    <button className="admin-menu-toggle" type="button" aria-label="打开工作台导航" onClick={() => setOpen(true)}>☰</button>
    {open && <button className="admin-nav-backdrop" type="button" aria-label="关闭工作台导航" onClick={() => setOpen(false)} />}
    <aside className={`admin-nav ${open ? "open" : ""}`} aria-label="教师工作台导航">
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
        <button className="admin-nav-close" type="button" aria-label="关闭工作台导航" onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="admin-nav-groups">
        {navGroups.map((group) => <div className="admin-nav-group" key={group.label}>
          <p className="admin-nav-label">{group.label}</p>
          <nav>{group.items.map(renderLink)}</nav>
        </div>)}
      </div>
      <div className="admin-nav-footer">
        <nav>{renderLink(settingsItem)}</nav>
      </div>
    </aside>
    <main className="admin-main">{children}</main>
  </div>;
}
