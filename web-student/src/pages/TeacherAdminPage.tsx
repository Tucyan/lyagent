import { useEffect, useState, type FormEvent } from "react";
import { StudentApiError, studentJson } from "../lib/api";

interface AdminCourse {
  id: string;
  name: string;
  activeReleaseId?: string;
  releasedAt?: string;
}

interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  role: "teacher" | "student";
  status: "active" | "disabled";
  mustChangePassword: boolean;
  courseIds: string[];
}

interface InviteCode {
  code: string;
  label: string;
  courseIds: string[];
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  status: "active" | "revoked";
  createdAt: string;
}

interface SyncToken {
  id: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface QuotaDashboard {
  todayKey: string;
  globalSettings: {
    emergencyQaPaused: boolean;
    globalDailyQaLimit: number | null;
    globalDailyTokenLimit: number | null;
  };
  stats: {
    todayCount: number;
    todayTokens: number;
    yesterdayCount: number;
    yesterdayTokens: number;
    activeConcurrent: number;
  };
  coursePolicies: Array<{
    courseId: string;
    dailyQaLimit: number;
    totalQaLimit: number | null;
    perMinuteLimit: number;
    maxConcurrent: number;
  }>;
  studentUsage: Array<{
    userId: string;
    username: string;
    displayName: string;
    courseId: string;
    dailyUsed: number;
    totalUsed: number;
    totalTokens: number;
    overrideDailyLimit: number | null;
    overrideTotalLimit: number | null;
    overrideNote: string;
  }>;
}

type AdminTab = "accounts" | "invites" | "quotas" | "sync";

export function TeacherAdminPage() {
  const [tab, setTab] = useState<AdminTab>("accounts");
  const [courses, setCourses] = useState<AdminCourse[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [syncTokens, setSyncTokens] = useState<SyncToken[]>([]);
  const [quotaDash, setQuotaDash] = useState<QuotaDashboard | null>(null);
  const [filterCourseId, setFilterCourseId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Single student modal
  const [showAddStudent, setShowAddStudent] = useState(false);
  const [newStuUsername, setNewStuUsername] = useState("");
  const [newStuName, setNewStuName] = useState("");
  const [newStuPassword, setNewStuPassword] = useState("");
  const [newStuCourseIds, setNewStuCourseIds] = useState<string[]>([]);

  // Bulk import modal
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkCourseIds, setBulkCourseIds] = useState<string[]>([]);
  const [bulkResult, setBulkResult] = useState<{
    createdCount: number;
    updatedCount: number;
    credentials: Array<{ username: string; displayName: string; initialPassword?: string; action: string }>;
    errors: Array<{ lineNumber: number; raw: string; error: string }>;
  } | null>(null);

  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [editingCourseIds, setEditingCourseIds] = useState<string[]>([]);

  const [inviteLabel, setInviteLabel] = useState("");
  const [inviteCourseIds, setInviteCourseIds] = useState<string[]>([]);
  const [inviteMaxUses, setInviteMaxUses] = useState("100");
  const [inviteDays, setInviteDays] = useState("30");

  const [newSyncLabel, setNewSyncLabel] = useState("本地教师工作台");
  const [createdSyncPlain, setCreatedSyncPlain] = useState("");

  const [globalDailyQa, setGlobalDailyQa] = useState("");
  const [globalDailyToken, setGlobalDailyToken] = useState("");

  const [overrideTarget, setOverrideTarget] = useState<QuotaDashboard["studentUsage"][number] | null>(null);
  const [overrideDaily, setOverrideDaily] = useState("");
  const [overrideTotal, setOverrideTotal] = useState("");
  const [overrideNote, setOverrideNote] = useState("");

  const courseName = (id: string) => courses.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const refreshAll = async () => {
    setError("");
    const [coursesRes, usersRes, invitesRes, tokensRes, quotaRes] = await Promise.all([
      studentJson<{ courses: AdminCourse[] }>("/api/admin/courses"),
      studentJson<{ users: ManagedUser[] }>(
        `/api/admin/users?${new URLSearchParams({
          ...(filterCourseId ? { courseId: filterCourseId } : {}),
          ...(searchText.trim() ? { q: searchText.trim() } : {}),
        }).toString()}`,
      ),
      studentJson<{ invites: InviteCode[] }>("/api/admin/invites"),
      studentJson<{ tokens: SyncToken[] }>("/api/admin/sync-tokens"),
      studentJson<QuotaDashboard>("/api/admin/quotas/dashboard"),
    ]);
    setCourses(coursesRes.courses);
    setUsers(usersRes.users);
    setInvites(invitesRes.invites);
    setSyncTokens(tokensRes.tokens);
    setQuotaDash(quotaRes);
    setGlobalDailyQa(quotaRes.globalSettings.globalDailyQaLimit !== null ? String(quotaRes.globalSettings.globalDailyQaLimit) : "");
    setGlobalDailyToken(quotaRes.globalSettings.globalDailyTokenLimit !== null ? String(quotaRes.globalSettings.globalDailyTokenLimit) : "");
  };

  useEffect(() => {
    void refreshAll().catch((err) => setError(err instanceof StudentApiError ? err.message : "加载管理数据失败"));
  }, [filterCourseId]);

  const handleAddStudent = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await studentJson<{ user: ManagedUser; initialPassword: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: newStuUsername.trim(),
          displayName: newStuName.trim(),
          ...(newStuPassword.trim() ? { password: newStuPassword.trim() } : {}),
          courseIds: newStuCourseIds,
        }),
      });
      setShowAddStudent(false);
      setNotice(`已创建学生账号 ${res.user.username}（${res.user.displayName}），初始密码：${res.initialPassword}`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "创建学生账号失败");
    }
  };

  const handleBulkImport = async () => {
    setError("");
    try {
      const res = await studentJson<NonNullable<typeof bulkResult>>("/api/admin/users/bulk-import", {
        method: "POST",
        body: JSON.stringify({ rawText: bulkText, courseIds: bulkCourseIds }),
      });
      setBulkResult(res);
      await refreshAll();
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "批量导入失败");
    }
  };

  const downloadBulkCsv = () => {
    if (!bulkResult) return;
    const rows = [
      ["学号", "姓名", "结果", "初始密码"],
      ...bulkResult.credentials.map((c) => [
        c.username,
        c.displayName,
        c.action === "created" ? "新建账号" : "已存在-已追加课程",
        c.initialPassword ?? "保持原密码",
      ]),
    ];
    const csv = `\uFEFF${rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `student-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateInvite = async () => {
    setError("");
    setNotice("");
    try {
      await studentJson("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify({
          label: inviteLabel.trim() || "课程邀请码",
          courseIds: inviteCourseIds,
          maxUses: inviteMaxUses.trim() ? Number.parseInt(inviteMaxUses, 10) : null,
          expiresInDays: inviteDays.trim() ? Number.parseInt(inviteDays, 10) : null,
        }),
      });
      setInviteLabel("");
      setNotice("邀请码已创建，点击“复制注册链接”发到课程群即可让学生自助注册。");
      await refreshAll();
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "创建邀请码失败");
    }
  };

  const handleResetPassword = async (user: ManagedUser) => {
    if (!window.confirm(`确定重置 ${user.displayName}（${user.username}）的密码并踢出其当前登录状态吗？`)) return;
    const res = await studentJson<{ username: string; temporaryPassword: string }>(
      `/api/admin/users/${encodeURIComponent(user.id)}/reset-password`,
      { method: "POST" },
    );
    setNotice(`已重置 ${res.username} 的临时密码为：${res.temporaryPassword}（请妥善告知学生，登录后需修改）`);
    await refreshAll();
  };

  const handleToggleStatus = async (user: ManagedUser) => {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    await studentJson(`/api/admin/users/${encodeURIComponent(user.id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    await refreshAll();
  };

  const handleSaveUserCourses = async () => {
    if (!editingUser) return;
    await studentJson(`/api/admin/users/${encodeURIComponent(editingUser.id)}/courses`, {
      method: "PUT",
      body: JSON.stringify({ courseIds: editingCourseIds }),
    });
    setEditingUser(null);
    setNotice("已更新学生的课程访问许可");
    await refreshAll();
  };

  const handleToggleGlobalPause = async () => {
    if (!quotaDash) return;
    await studentJson("/api/admin/quotas/global", {
      method: "PUT",
      body: JSON.stringify({ emergencyQaPaused: !quotaDash.globalSettings.emergencyQaPaused }),
    });
    await refreshAll();
  };

  const handleSaveGlobalLimits = async () => {
    await studentJson("/api/admin/quotas/global", {
      method: "PUT",
      body: JSON.stringify({
        globalDailyQaLimit: globalDailyQa.trim() === "" ? null : Math.max(0, Number.parseInt(globalDailyQa, 10)),
        globalDailyTokenLimit: globalDailyToken.trim() === "" ? null : Math.max(0, Number.parseInt(globalDailyToken, 10)),
      }),
    });
    setNotice("已保存全站每日熔断阈值");
    await refreshAll();
  };

  const handleSaveCoursePolicy = async (
    courseId: string,
    dailyQaLimit: number,
    totalQaLimit: number | null,
    perMinuteLimit: number,
  ) => {
    await studentJson(`/api/admin/quotas/courses/${encodeURIComponent(courseId)}`, {
      method: "PUT",
      body: JSON.stringify({ dailyQaLimit, totalQaLimit, perMinuteLimit, maxConcurrent: 1 }),
    });
    setNotice(`已更新课程《${courseName(courseId)}》的默认答疑额度`);
    await refreshAll();
  };

  const handleSaveOverride = async () => {
    if (!overrideTarget) return;
    await studentJson(
      `/api/admin/quotas/users/${encodeURIComponent(overrideTarget.userId)}/courses/${encodeURIComponent(overrideTarget.courseId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          dailyQaLimit: overrideDaily.trim() === "" ? null : Number.parseInt(overrideDaily, 10),
          totalQaLimit: overrideTotal.trim() === "" ? null : Number.parseInt(overrideTotal, 10),
          note: overrideNote,
        }),
      },
    );
    setOverrideTarget(null);
    setNotice("已保存单学生额度调整");
    await refreshAll();
  };

  return (
    <div className="st-page">
      <div className="st-page-header">
        <div>
          <h1>教师管理后台</h1>
          <p>统一管理学生账号、课程访问许可、答疑额度限制与本地资料同步令牌</p>
        </div>
      </div>

      <div className="student-admin-tabs">
        <button type="button" className={`st-btn st-btn-sm ${tab === "accounts" ? "st-btn-primary" : ""}`} onClick={() => setTab("accounts")}>
          账号与课程权限
        </button>
        <button type="button" className={`st-btn st-btn-sm ${tab === "invites" ? "st-btn-primary" : ""}`} onClick={() => setTab("invites")}>
          课程邀请码注册
        </button>
        <button type="button" className={`st-btn st-btn-sm ${tab === "quotas" ? "st-btn-primary" : ""}`} onClick={() => setTab("quotas")}>
          额度限制后台
        </button>
        <button type="button" className={`st-btn st-btn-sm ${tab === "sync" ? "st-btn-primary" : ""}`} onClick={() => setTab("sync")}>
          资料同步令牌
        </button>
      </div>

      {error && <div className="student-error-banner">{error}</div>}
      {notice && <div className="student-success-banner">{notice}</div>}

      {tab === "accounts" && (
        <div className="student-admin-grid">
          <div className="st-card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                className="student-input"
                value={filterCourseId}
                onChange={(e) => setFilterCourseId(e.target.value)}
                style={{ width: "auto", minWidth: 160, padding: "7px 10px", fontSize: 13 }}
              >
                <option value="">全部课程</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input
                className="student-input"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refreshAll();
                }}
                placeholder="搜索学号或姓名…"
                style={{ width: 200, padding: "7px 10px", fontSize: 13 }}
              />
              <button type="button" className="st-btn st-btn-sm" onClick={() => void refreshAll()}>
                筛选
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => {
                  setNewStuUsername("");
                  setNewStuName("");
                  setNewStuPassword("");
                  setNewStuCourseIds(courses.map((c) => c.id));
                  setShowAddStudent(true);
                }}
              >
                + 添加单个学生
              </button>
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-sm"
                onClick={() => {
                  setBulkResult(null);
                  setBulkText("");
                  setBulkCourseIds(courses.map((c) => c.id));
                  setShowBulkModal(true);
                }}
              >
                粘贴名单批量建号
              </button>
            </div>
          </div>

          <div className="student-table-wrap">
            <table className="student-table">
              <thead>
                <tr>
                  <th>学号 / 账号</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>已授权课程</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: 28, color: "var(--text-muted)" }}>
                      暂无符合条件的账号记录
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id}>
                      <td style={{ whiteSpace: "nowrap" }}><strong>{u.username}</strong></td>
                      <td style={{ whiteSpace: "nowrap" }}>{u.displayName}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{u.role === "teacher" ? "教师管理员" : "学生"}</td>
                      <td>
                        {u.role === "teacher" ? (
                          <span className="student-chip">全部课程</span>
                        ) : u.courseIds.length === 0 ? (
                          <span style={{ color: "var(--text-muted)" }}>未分配课程</span>
                        ) : (
                          <div className="student-course-chips">
                            {u.courseIds.map((cid) => (
                              <span key={cid} className="student-chip">{courseName(cid)}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`student-chip ${u.status === "active" ? "success" : "danger"}`}>
                          {u.status === "active" ? "正常" : "已停用"}
                        </span>
                      </td>
                      <td>
                        {u.role === "student" && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
                            <button
                              type="button"
                              className="st-btn st-btn-sm"
                              onClick={() => {
                                setEditingUser(u);
                                setEditingCourseIds(u.courseIds);
                              }}
                            >
                              调整课程
                            </button>
                            <button type="button" className="st-btn st-btn-sm" onClick={() => void handleResetPassword(u)}>
                              重置密码
                            </button>
                            <button
                              type="button"
                              className={`st-btn st-btn-sm ${u.status === "active" ? "st-btn-danger" : ""}`}
                              onClick={() => void handleToggleStatus(u)}
                            >
                              {u.status === "active" ? "停用" : "启用"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "invites" && (
        <div className="student-admin-grid">
          <div className="st-card" style={{ display: "grid", gap: 14 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>生成课程注册邀请码</h3>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
                勾选课程后生成邀请码与注册链接，发到班级群即可让学生凭学号自助注册并自动开通对应课程。
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <div className="student-field">
                <label>班级 / 备注</label>
                <input value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)} placeholder="如：2026秋计网1班" />
              </div>
              <div className="student-field">
                <label>最多注册人数（留空不限）</label>
                <input value={inviteMaxUses} onChange={(e) => setInviteMaxUses(e.target.value)} type="number" min={1} />
              </div>
              <div className="student-field">
                <label>有效天数（留空不过期）</label>
                <input value={inviteDays} onChange={(e) => setInviteDays(e.target.value)} type="number" min={1} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>勾选学生注册后自动开通的课程：</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {courses.map((c) => (
                  <label key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={inviteCourseIds.includes(c.id)}
                      onChange={(e) =>
                        setInviteCourseIds((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <button
                type="button"
                className="st-btn st-btn-primary"
                disabled={inviteCourseIds.length === 0}
                onClick={() => void handleCreateInvite()}
              >
                生成邀请码
              </button>
            </div>
          </div>

          <div className="student-table-wrap">
            <table className="student-table">
              <thead>
                <tr>
                  <th>邀请码</th>
                  <th>备注</th>
                  <th>绑定课程</th>
                  <th>已用 / 上限</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {invites.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: 28, color: "var(--text-muted)" }}>
                      尚未生成课程邀请码，可在上方勾选课程后一键创建
                    </td>
                  </tr>
                ) : (
                  invites.map((inv) => {
                    const link = `${window.location.origin}/register?code=${encodeURIComponent(inv.code)}`;
                    return (
                      <tr key={inv.code}>
                        <td><code>{inv.code}</code></td>
                        <td>{inv.label}</td>
                        <td>
                          <div className="student-course-chips">
                            {inv.courseIds.map((cid) => (
                              <span key={cid} className="student-chip">{courseName(cid)}</span>
                            ))}
                          </div>
                        </td>
                        <td>{inv.usedCount} / {inv.maxUses ?? "不限"}</td>
                        <td>
                          <span className={`student-chip ${inv.status === "active" ? "success" : "danger"}`}>
                            {inv.status === "active" ? "有效" : "已停用"}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="st-btn st-btn-sm"
                              onClick={() => {
                                void navigator.clipboard?.writeText(link);
                                setNotice(`已复制注册链接：${link}`);
                              }}
                            >
                              复制注册链接
                            </button>
                            {inv.status === "active" && (
                              <button
                                type="button"
                                className="st-btn st-btn-danger st-btn-sm"
                                onClick={async () => {
                                  await studentJson(`/api/admin/invites/${encodeURIComponent(inv.code)}/revoke`, { method: "POST" });
                                  await refreshAll();
                                }}
                              >
                                停用
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "quotas" && quotaDash && (
        <div className="student-admin-grid">
          <div className="student-stat-row">
            <div className="student-stat-card">
              <span>今日答疑次数（昨日 {quotaDash.stats.yesterdayCount}）</span>
              <strong>{quotaDash.stats.todayCount}</strong>
            </div>
            <div className="student-stat-card">
              <span>今日消耗 Token</span>
              <strong>{quotaDash.stats.todayTokens.toLocaleString()}</strong>
            </div>
            <div className="student-stat-card">
              <span>当前进行中答疑</span>
              <strong>{quotaDash.stats.activeConcurrent}</strong>
            </div>
            <div className="student-stat-card">
              <span>全站答疑总开关</span>
              <button
                type="button"
                className={`st-btn st-btn-sm ${quotaDash.globalSettings.emergencyQaPaused ? "st-btn-primary" : "st-btn-danger"}`}
                onClick={() => void handleToggleGlobalPause()}
              >
                {quotaDash.globalSettings.emergencyQaPaused ? "已暂停 · 点击恢复" : "运行中 · 紧急暂停"}
              </button>
            </div>
          </div>

          <div className="st-card" style={{ display: "grid", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>全站每日熔断保护（可选）</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
              <div className="student-field" style={{ width: 220 }}>
                <label>全站每日总答疑次数上限（留空不限）</label>
                <input type="number" min={0} value={globalDailyQa} onChange={(e) => setGlobalDailyQa(e.target.value)} placeholder="不限" />
              </div>
              <div className="student-field" style={{ width: 240 }}>
                <label>全站每日总 Token 上限（留空不限）</label>
                <input type="number" min={0} value={globalDailyToken} onChange={(e) => setGlobalDailyToken(e.target.value)} placeholder="不限" />
              </div>
              <button type="button" className="st-btn st-btn-primary" onClick={() => void handleSaveGlobalLimits()}>
                保存全站阈值
              </button>
            </div>
          </div>

          <div className="st-card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>课程默认答疑配额</h3>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="student-table">
                <thead>
                  <tr>
                    <th>课程</th>
                    <th>每人每日次数</th>
                    <th>每人总次数</th>
                    <th>每分钟上限</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {quotaDash.coursePolicies.map((p) => (
                    <CourseQuotaRow
                      key={p.courseId}
                      name={courseName(p.courseId)}
                      policy={p}
                      onSave={(daily, total, perMin) => void handleSaveCoursePolicy(p.courseId, daily, total, perMin)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="st-card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>学生答疑用量与个人额度调整</h3>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="student-table">
                <thead>
                  <tr>
                    <th>学号</th>
                    <th>姓名</th>
                    <th>课程</th>
                    <th>今日已用</th>
                    <th>累计已用</th>
                    <th>Token 消耗</th>
                    <th>个人覆写</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {quotaDash.studentUsage.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", padding: 28, color: "var(--text-muted)" }}>
                        暂无已授权课程的学生用量记录
                      </td>
                    </tr>
                  ) : (
                    quotaDash.studentUsage.map((row) => (
                      <tr key={`${row.userId}-${row.courseId}`}>
                        <td>{row.username}</td>
                        <td>{row.displayName}</td>
                        <td>{courseName(row.courseId)}</td>
                        <td>{row.dailyUsed}</td>
                        <td>{row.totalUsed}</td>
                        <td>{row.totalTokens.toLocaleString()}</td>
                        <td>
                          {row.overrideDailyLimit !== null || row.overrideTotalLimit !== null ? (
                            <span className="student-chip">
                              日:{row.overrideDailyLimit ?? "默认"} / 总:{row.overrideTotalLimit ?? "默认"}
                            </span>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>课程默认</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="st-btn st-btn-sm"
                            onClick={() => {
                              setOverrideTarget(row);
                              setOverrideDaily(row.overrideDailyLimit !== null ? String(row.overrideDailyLimit) : "");
                              setOverrideTotal(row.overrideTotalLimit !== null ? String(row.overrideTotalLimit) : "");
                              setOverrideNote(row.overrideNote);
                            }}
                          >
                            调整额度
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "sync" && (
        <div className="student-admin-grid">
          <div className="st-card" style={{ display: "grid", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>生成本地教师工作台同步令牌</h3>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
                在本地教师工作台的“课程资料库”中填入本服务器地址与下方生成的同步令牌，即可一键推送最新课程资料。
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, maxWidth: 460 }}>
              <input
                className="student-input"
                value={newSyncLabel}
                onChange={(e) => setNewSyncLabel(e.target.value)}
                placeholder="令牌备注"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="st-btn st-btn-primary"
                onClick={async () => {
                  const res = await studentJson<{ plainToken: string }>("/api/admin/sync-tokens", {
                    method: "POST",
                    body: JSON.stringify({ label: newSyncLabel }),
                  });
                  setCreatedSyncPlain(res.plainToken);
                  await refreshAll();
                }}
              >
                生成令牌
              </button>
            </div>
            {createdSyncPlain && (
              <div className="student-success-banner">
                <div><strong>请立即复制同步令牌（仅显示这一次）：</strong></div>
                <code style={{ wordBreak: "break-all" }}>{createdSyncPlain}</code>
              </div>
            )}
          </div>

          <div className="student-table-wrap">
            <table className="student-table">
              <thead>
                <tr>
                  <th>备注</th>
                  <th>创建时间</th>
                  <th>最近同步</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {syncTokens.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: 28, color: "var(--text-muted)" }}>
                      尚未生成同步令牌。若教师端与学生端部署在同一台机器并共享目录，则无需令牌。
                    </td>
                  </tr>
                ) : (
                  syncTokens.map((t) => (
                    <tr key={t.id}>
                      <td>{t.label}</td>
                      <td>{new Date(t.createdAt).toLocaleString("zh-CN")}</td>
                      <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString("zh-CN") : "尚未使用"}</td>
                      <td>
                        <span className={`student-chip ${t.revokedAt ? "danger" : "success"}`}>
                          {t.revokedAt ? "已撤销" : "有效"}
                        </span>
                      </td>
                      <td>
                        {!t.revokedAt && (
                          <button
                            type="button"
                            className="st-btn st-btn-danger st-btn-sm"
                            onClick={async () => {
                              await studentJson(`/api/admin/sync-tokens/${encodeURIComponent(t.id)}/revoke`, { method: "POST" });
                              await refreshAll();
                            }}
                          >
                            撤销
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAddStudent && (
        <div className="student-modal-backdrop" role="dialog" aria-modal="true">
          <div className="student-modal">
            <h2 style={{ margin: 0, fontSize: 18 }}>添加单个学生账号</h2>
            <form className="student-form" onSubmit={handleAddStudent}>
              <div className="student-field">
                <label>学号</label>
                <input value={newStuUsername} onChange={(e) => setNewStuUsername(e.target.value)} placeholder="如：2026002" required />
              </div>
              <div className="student-field">
                <label>姓名</label>
                <input value={newStuName} onChange={(e) => setNewStuName(e.target.value)} placeholder="如：王小明" required />
              </div>
              <div className="student-field">
                <label>初始密码（留空则自动生成 8 位随机密码）</label>
                <input value={newStuPassword} onChange={(e) => setNewStuPassword(e.target.value)} placeholder="留空自动生成" minLength={6} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>开通课程权限：</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {courses.map((c) => (
                    <label key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5 }}>
                      <input
                        type="checkbox"
                        checked={newStuCourseIds.includes(c.id)}
                        onChange={(e) =>
                          setNewStuCourseIds((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="st-btn" onClick={() => setShowAddStudent(false)}>取消</button>
                <button type="submit" className="st-btn st-btn-primary">创建账号</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showBulkModal && (
        <div className="student-modal-backdrop" role="dialog" aria-modal="true">
          <div className="student-modal">
            <h2 style={{ margin: 0, fontSize: 18 }}>粘贴名单批量建号</h2>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
              每行一名学生，支持空格、Tab 或逗号分隔（例如：<code>2026001 张三</code>）。已存在学号会自动追加所选课程，不覆盖原密码。
            </p>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>开通课程：</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {courses.map((c) => (
                  <label key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5 }}>
                    <input
                      type="checkbox"
                      checked={bulkCourseIds.includes(c.id)}
                      onChange={(e) =>
                        setBulkCourseIds((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="student-field">
              <label>学生名单</label>
              <textarea
                rows={7}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"2026001 张三\n2026002\t李四\n2026003,王五"}
              />
            </div>
            {bulkResult && (
              <div className="student-success-banner">
                <div>新建 {bulkResult.createdCount} 人，已有账号追加课程 {bulkResult.updatedCount} 人，格式错误 {bulkResult.errors.length} 行。</div>
                {bulkResult.credentials.length > 0 && (
                  <button type="button" className="st-btn st-btn-primary st-btn-sm" style={{ marginTop: 8 }} onClick={downloadBulkCsv}>
                    下载初始密码 CSV
                  </button>
                )}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="st-btn" onClick={() => setShowBulkModal(false)}>关闭</button>
              <button type="button" className="st-btn st-btn-primary" disabled={!bulkText.trim()} onClick={() => void handleBulkImport()}>
                开始导入
              </button>
            </div>
          </div>
        </div>
      )}

      {editingUser && (
        <div className="student-modal-backdrop" role="dialog" aria-modal="true">
          <div className="student-modal">
            <h2 style={{ margin: 0, fontSize: 18 }}>调整课程权限：{editingUser.displayName}</h2>
            <div style={{ display: "grid", gap: 8 }}>
              {courses.map((c) => (
                <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editingCourseIds.includes(c.id)}
                    onChange={(e) =>
                      setEditingCourseIds((prev) =>
                        e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="st-btn" onClick={() => setEditingUser(null)}>取消</button>
              <button type="button" className="st-btn st-btn-primary" onClick={() => void handleSaveUserCourses()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {overrideTarget && (
        <div className="student-modal-backdrop" role="dialog" aria-modal="true">
          <div className="student-modal">
            <h2 style={{ margin: 0, fontSize: 18 }}>
              调整个人额度：{overrideTarget.displayName}（{courseName(overrideTarget.courseId)}）
            </h2>
            <div className="student-field">
              <label>每日答疑次数上限（留空则沿用课程默认，填 0 仅禁答疑）</label>
              <input value={overrideDaily} onChange={(e) => setOverrideDaily(e.target.value)} type="number" min={0} />
            </div>
            <div className="student-field">
              <label>累计总次数上限（留空则沿用课程默认）</label>
              <input value={overrideTotal} onChange={(e) => setOverrideTotal(e.target.value)} type="number" min={0} />
            </div>
            <div className="student-field">
              <label>备注</label>
              <input value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="如：课代表加额" />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="st-btn" onClick={() => setOverrideTarget(null)}>取消</button>
              <button type="button" className="st-btn st-btn-primary" onClick={() => void handleSaveOverride()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CourseQuotaRow({
  name,
  policy,
  onSave,
}: {
  name: string;
  policy: QuotaDashboard["coursePolicies"][number];
  onSave: (daily: number, total: number | null, perMin: number) => void;
}) {
  const [daily, setDaily] = useState(String(policy.dailyQaLimit));
  const [total, setTotal] = useState(policy.totalQaLimit !== null ? String(policy.totalQaLimit) : "");
  const [perMin, setPerMin] = useState(String(policy.perMinuteLimit));

  useEffect(() => {
    setDaily(String(policy.dailyQaLimit));
    setTotal(policy.totalQaLimit !== null ? String(policy.totalQaLimit) : "");
    setPerMin(String(policy.perMinuteLimit));
  }, [policy.dailyQaLimit, policy.totalQaLimit, policy.perMinuteLimit]);

  return (
    <tr>
      <td><strong>{name}</strong></td>
      <td>
        <input
          className="student-input"
          type="number"
          min={0}
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          style={{ width: 84, padding: "6px 8px", fontSize: 13 }}
        />
      </td>
      <td>
        <input
          className="student-input"
          type="number"
          min={0}
          value={total}
          placeholder="不限"
          onChange={(e) => setTotal(e.target.value)}
          style={{ width: 96, padding: "6px 8px", fontSize: 13 }}
        />
      </td>
      <td>
        <input
          className="student-input"
          type="number"
          min={1}
          value={perMin}
          onChange={(e) => setPerMin(e.target.value)}
          style={{ width: 74, padding: "6px 8px", fontSize: 13 }}
        />
      </td>
      <td>
        <button
          type="button"
          className="st-btn st-btn-sm"
          onClick={() =>
            onSave(
              Math.max(0, Number.parseInt(daily || "0", 10)),
              total.trim() === "" ? null : Math.max(0, Number.parseInt(total, 10)),
              Math.max(1, Number.parseInt(perMin || "1", 10)),
            )
          }
        >
          保存
        </button>
      </td>
    </tr>
  );
}
