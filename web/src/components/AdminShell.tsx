import { useState, type ReactNode } from "react";

type ActivePage = "dashboard" | "knowledge";

const futureModules = ["评分量表", "作业批改", "批量任务", "系统运维", "企业微信"];

export function AdminShell({ active, children }: { active: ActivePage; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigation = [
    { id: "dashboard", href: "/", label: "总览" },
    { id: "knowledge", href: "/knowledge", label: "课程资料库" },
    { id: "qa", href: "/qa", label: "课程答疑" },
  ];

  return <div className="admin-shell">
    <button className="admin-menu-toggle" type="button" aria-label="打开工作台导航" onClick={() => setOpen(true)}>☰</button>
    {open && <button className="admin-nav-backdrop" type="button" aria-label="关闭工作台导航" onClick={() => setOpen(false)} />}
    <aside className={`admin-nav ${open ? "open" : ""}`} aria-label="教师工作台导航">
      <div className="admin-brand"><strong>Course Agent</strong><button className="admin-nav-close" type="button" aria-label="关闭工作台导航" onClick={() => setOpen(false)}>×</button></div>
      <p className="admin-nav-label">工作台</p>
      <nav>{navigation.map((item) => <a className={active === item.id ? "active" : ""} key={item.id} href={item.href} onClick={() => setOpen(false)}>{item.label}</a>)}</nav>
      <p className="admin-nav-label">后续里程碑</p>
      <nav>{futureModules.map((item) => <button type="button" key={item} disabled title="将在后续里程碑实现">{item}</button>)}</nav>
    </aside>
    <main className="admin-main">{children}</main>
  </div>;
}
