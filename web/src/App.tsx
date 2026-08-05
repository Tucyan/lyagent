import { useEffect, useState, type ReactNode } from "react";
import { AdminShell } from "./components/AdminShell";
import { CourseQaPage } from "./pages/CourseQaPage";
import { DashboardPage } from "./pages/DashboardPage";
import { KnowledgeLibraryPage } from "./pages/KnowledgeLibraryPage";
import { RubricPage } from "./pages/RubricPage";
import { GradingPage } from "./pages/GradingPage";
import { GradingBatchPage } from "./pages/GradingBatchPage";
import { ModelSettingsPage } from "./pages/ModelSettingsPage";
import { resolveAppRoute } from "./pages/model-settings-page-model";

export function App() {
  const path = window.location.pathname;
  if (path === "/setup") return <ModelSettingsPage mode="setup" />;
  return <SetupGuard path={path}>{path === "/settings/models" ? <AdminShell active="model-settings"><ModelSettingsPage mode="settings" /></AdminShell> : <ApplicationPage path={path} />}</SetupGuard>;
}

function SetupGuard({ path, children }: { path: string; children: ReactNode }) {
  const [configured, setConfigured] = useState<boolean>();
  useEffect(() => { void fetch("/api/system/models", { cache: "no-store" }).then((response) => response.json()).then((status: { primary?: { configured?: boolean } }) => setConfigured(status.primary?.configured === true)).catch(() => setConfigured(false)); }, []);
  if (configured === undefined) return <main><p>正在检查模型设置…</p></main>;
  const route = resolveAppRoute(path, configured);
  if (route.kind === "redirect") { window.location.replace(route.href); return <main><p>正在前往首次设置…</p></main>; }
  return children;
}

function ApplicationPage({ path }: { path: string }) {
  if (path === "/qa") return <CourseQaPage />;
  if (path === "/knowledge") return <AdminShell active="knowledge"><KnowledgeLibraryPage /></AdminShell>;
  if (path === "/rubrics") return <AdminShell active="rubrics"><RubricPage /></AdminShell>;
  if (path === "/grading") return <AdminShell active="grading"><GradingPage /></AdminShell>;
  if (path === "/grading/batches") return <AdminShell active="batch-grading"><GradingBatchPage /></AdminShell>;
  return <AdminShell active="dashboard"><DashboardPage /></AdminShell>;
}
