import { useState, type FormEvent } from "react";
import { navigateStudent, StudentApiError, studentJson } from "../lib/api";
import type { StudentUser } from "../components/StudentShell";

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
  required,
}: {
  id: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="student-password-wrap">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        required={required}
      />
      <button
        type="button"
        className="student-password-toggle"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
      >
        {visible ? "隐藏" : "显示"}
      </button>
    </div>
  );
}

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: StudentUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await studentJson<{ user: StudentUser }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="student-auth-page">
      <div className="student-auth-card">
        <div className="student-auth-brand">
          <div className="student-auth-logo" aria-hidden="true">CA</div>
          <div>
            <h1>课程智能体 · 登录</h1>
            <p className="student-auth-subtitle">使用学号或教师管理员账号登录课程资料与答疑系统</p>
          </div>
        </div>

        {error && <div className="student-error-banner" role="alert">{error}</div>}

        <form className="student-form" onSubmit={submit}>
          <div className="student-field">
            <label htmlFor="login-username">学号 / 账号</label>
            <input
              id="login-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入学号或教师账号"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="student-field">
            <label htmlFor="login-password">密码</label>
            <PasswordInput
              id="login-password"
              value={password}
              onChange={setPassword}
              placeholder="请输入登录密码"
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" className="st-btn st-btn-primary st-btn-block" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
        </form>

        <div className="student-auth-footer">
          <span style={{ color: "var(--text-muted)" }}>持有课程邀请码？</span>
          <a
            href="/register"
            className="student-link"
            onClick={(e) => {
              e.preventDefault();
              navigateStudent("/register");
            }}
          >
            学生自助注册 →
          </a>
        </div>
      </div>
    </div>
  );
}

export function RegisterPage({ onAuthenticated }: { onAuthenticated: (user: StudentUser) => void }) {
  const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(initialCode);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await studentJson<{ user: StudentUser }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim(),
          username: username.trim(),
          displayName: displayName.trim(),
          password,
        }),
      });
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "注册失败，请检查输入信息");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="student-auth-page">
      <div className="student-auth-card">
        <div className="student-auth-brand">
          <div className="student-auth-logo" aria-hidden="true">CA</div>
          <div>
            <h1>学生账号注册</h1>
            <p className="student-auth-subtitle">填写授课教师发放的课程邀请码，注册后自动开通课程权限</p>
          </div>
        </div>

        {error && <div className="student-error-banner" role="alert">{error}</div>}

        <form className="student-form" onSubmit={submit}>
          <div className="student-field">
            <label htmlFor="reg-code">课程邀请码</label>
            <input
              id="reg-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="例如：COURSE-A1B2C3"
              required
            />
          </div>
          <div className="student-field">
            <label htmlFor="reg-username">学号</label>
            <input
              id="reg-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="2-64 位字母、数字或下划线"
              required
            />
          </div>
          <div className="student-field">
            <label htmlFor="reg-name">姓名</label>
            <input
              id="reg-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="请输入真实姓名"
              required
            />
          </div>
          <div className="student-field">
            <label htmlFor="reg-password">设置密码（至少 6 位）</label>
            <PasswordInput
              id="reg-password"
              value={password}
              onChange={setPassword}
              placeholder="请输入至少 6 位密码"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </div>
          <button type="submit" className="st-btn st-btn-primary st-btn-block" disabled={busy}>
            {busy ? "正在注册…" : "注册并进入学习"}
          </button>
        </form>

        <div className="student-auth-footer">
          <span style={{ color: "var(--text-muted)" }}>已有账号？</span>
          <a
            href="/login"
            className="student-link"
            onClick={(e) => {
              e.preventDefault();
              navigateStudent("/login");
            }}
          >
            返回登录
          </a>
        </div>
      </div>
    </div>
  );
}

export function AdminSetupPage({ onAuthenticated }: { onAuthenticated: (user: StudentUser) => void }) {
  const [username, setUsername] = useState("teacher");
  const [displayName, setDisplayName] = useState("教师管理员");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await studentJson<{ user: StudentUser }>("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), password }),
      });
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="student-auth-page">
      <div className="student-auth-card">
        <div className="student-auth-brand">
          <div className="student-auth-logo" aria-hidden="true">CA</div>
          <div>
            <h1>初始化教师管理员</h1>
            <p className="student-auth-subtitle">首次部署学生端服务器时，请先创建教师管理员账号</p>
          </div>
        </div>

        {error && <div className="student-error-banner" role="alert">{error}</div>}

        <form className="student-form" onSubmit={submit}>
          <div className="student-field">
            <label htmlFor="setup-username">管理员账号</label>
            <input id="setup-username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="student-field">
            <label htmlFor="setup-name">教师姓名</label>
            <input id="setup-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="student-field">
            <label htmlFor="setup-password">管理员密码（至少 6 位）</label>
            <PasswordInput
              id="setup-password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={6}
              required
            />
          </div>
          <button type="submit" className="st-btn st-btn-primary st-btn-block" disabled={busy}>
            {busy ? "正在初始化…" : "创建管理员并进入后台"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function ChangePasswordModal({
  forced,
  onClose,
  onChanged,
}: {
  forced: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await studentJson("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof StudentApiError ? err.message : "修改密码失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="student-modal-backdrop" role="dialog" aria-modal="true">
      <div className="student-modal">
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{forced ? "首次登录请修改初始密码" : "修改登录密码"}</h2>
          <p className="student-auth-subtitle">
            {forced ? "您当前使用的是教师发放的初始/重置密码，请先设置个人新密码以继续使用。" : "修改成功后，其他设备的登录会话将自动失效。"}
          </p>
        </div>
        {error && <div className="student-error-banner">{error}</div>}
        <form className="student-form" onSubmit={submit}>
          <div className="student-field">
            <label htmlFor="cp-old">当前密码</label>
            <PasswordInput id="cp-old" value={currentPassword} onChange={setCurrentPassword} required />
          </div>
          <div className="student-field">
            <label htmlFor="cp-new">新密码（至少 6 位）</label>
            <PasswordInput id="cp-new" value={newPassword} onChange={setNewPassword} minLength={6} required />
          </div>
          <div className="student-field">
            <label htmlFor="cp-confirm">确认新密码</label>
            <PasswordInput id="cp-confirm" value={confirmPassword} onChange={setConfirmPassword} minLength={6} required />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {!forced && (
              <button type="button" className="st-btn" onClick={onClose}>
                取消
              </button>
            )}
            <button type="submit" className="st-btn st-btn-primary" disabled={busy}>
              {busy ? "正在保存…" : "确认修改"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
