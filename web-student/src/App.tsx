import { useEffect, useState } from "react";
import { StudentShell, type StudentActiveTab, type StudentCourseOption, type StudentUser } from "./components/StudentShell";
import { navigateStudent, studentJson } from "./lib/api";
import { AdminSetupPage, ChangePasswordModal, LoginPage, RegisterPage } from "./pages/AuthPages";
import { StudentMaterialsPage } from "./pages/StudentMaterialsPage";
import { StudentQaPage } from "./pages/StudentQaPage";
import { TeacherAdminPage } from "./pages/TeacherAdminPage";

export function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [search, setSearch] = useState(window.location.search);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(true);
  const [user, setUser] = useState<StudentUser | null>(null);
  const [courses, setCourses] = useState<StudentCourseOption[]>([]);
  const [courseId, setCourseId] = useState("");
  const [showChangePassword, setShowChangePassword] = useState(false);

  useEffect(() => {
    const onPop = () => {
      setPathname(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshAuth = async () => {
    setLoading(true);
    try {
      const status = await studentJson<{ initialized: boolean; user: StudentUser | null }>("/api/auth/status");
      setInitialized(status.initialized);
      setUser(status.user);
      if (status.user) {
        const list = await studentJson<{ courses: StudentCourseOption[] }>("/api/student/courses");
        setCourses(list.courses);
        const queryCourse = new URLSearchParams(window.location.search).get("course") ?? "";
        const valid = list.courses.find((c) => c.id === queryCourse)?.id ?? list.courses[0]?.id ?? "";
        setCourseId(valid);
      } else {
        setCourses([]);
        setCourseId("");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAuth();
  }, []);

  useEffect(() => {
    const queryCourse = new URLSearchParams(search).get("course");
    if (queryCourse && courses.some((c) => c.id === queryCourse)) {
      setCourseId(queryCourse);
    }
  }, [search, courses]);

  if (loading) {
    return (
      <div className="student-auth-page">
        <div className="student-auth-card">正在加载课程学习平台…</div>
      </div>
    );
  }

  if (!initialized) {
    return (
      <AdminSetupPage
        onAuthenticated={() => {
          navigateStudent("/admin", true);
          void refreshAuth();
        }}
      />
    );
  }

  if (!user) {
    if (pathname === "/register") {
      return (
        <RegisterPage
          onAuthenticated={() => {
            navigateStudent("/materials", true);
            void refreshAuth();
          }}
        />
      );
    }
    return (
      <LoginPage
        onAuthenticated={(loggedIn) => {
          navigateStudent(loggedIn.role === "teacher" ? "/admin" : "/materials", true);
          void refreshAuth();
        }}
      />
    );
  }

  const activeTab: StudentActiveTab =
    pathname.startsWith("/admin") && user.role === "teacher"
      ? "admin"
      : pathname.startsWith("/qa")
        ? "qa"
        : "materials";

  const handleSelectCourse = (nextId: string) => {
    setCourseId(nextId);
    if (activeTab !== "admin") {
      navigateStudent(`${activeTab === "qa" ? "/qa" : "/materials"}?course=${encodeURIComponent(nextId)}`);
    }
  };

  return (
    <>
      <StudentShell
        user={user}
        active={activeTab}
        courses={courses}
        courseId={courseId}
        onSelectCourse={handleSelectCourse}
        onLoggedOut={() => {
          setUser(null);
          navigateStudent("/login", true);
        }}
        onOpenChangePassword={() => setShowChangePassword(true)}
      >
        {activeTab === "admin" ? (
          <TeacherAdminPage />
        ) : activeTab === "qa" ? (
          <StudentQaPage
            courseId={courseId}
            courseName={courses.find((c) => c.id === courseId)?.name ?? ""}
          />
        ) : (
          <StudentMaterialsPage courseId={courseId} />
        )}
      </StudentShell>

      {(user.mustChangePassword || showChangePassword) && (
        <ChangePasswordModal
          forced={user.mustChangePassword}
          onClose={() => setShowChangePassword(false)}
          onChanged={() => {
            setShowChangePassword(false);
            void refreshAuth();
          }}
        />
      )}
    </>
  );
}
