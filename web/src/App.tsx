import { AdminShell } from "./components/AdminShell";
import { CourseQaPage } from "./pages/CourseQaPage";
import { DashboardPage } from "./pages/DashboardPage";
import { KnowledgeLibraryPage } from "./pages/KnowledgeLibraryPage";
import { RubricPage } from "./pages/RubricPage";
import { GradingPage } from "./pages/GradingPage";
import { GradingBatchPage } from "./pages/GradingBatchPage";

export function App() {
  if (window.location.pathname === "/qa") return <CourseQaPage />;
  if (window.location.pathname === "/knowledge") return <AdminShell active="knowledge"><KnowledgeLibraryPage /></AdminShell>;
  if (window.location.pathname === "/rubrics") return <AdminShell active="rubrics"><RubricPage /></AdminShell>;
  if (window.location.pathname === "/grading") return <AdminShell active="grading"><GradingPage /></AdminShell>;
  if (window.location.pathname === "/grading/batches") return <AdminShell active="batch-grading"><GradingBatchPage /></AdminShell>;
  return <AdminShell active="dashboard"><DashboardPage /></AdminShell>;
}
