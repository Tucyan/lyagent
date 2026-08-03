import { AdminShell } from "./components/AdminShell";
import { CourseQaPage } from "./pages/CourseQaPage";
import { DashboardPage } from "./pages/DashboardPage";
import { KnowledgeLibraryPage } from "./pages/KnowledgeLibraryPage";
import { RubricPage } from "./pages/RubricPage";

export function App() {
  if (window.location.pathname === "/qa") return <CourseQaPage />;
  if (window.location.pathname === "/knowledge") return <AdminShell active="knowledge"><KnowledgeLibraryPage /></AdminShell>;
  if (window.location.pathname === "/rubrics") return <AdminShell active="rubrics"><RubricPage /></AdminShell>;
  return <AdminShell active="dashboard"><DashboardPage /></AdminShell>;
}
