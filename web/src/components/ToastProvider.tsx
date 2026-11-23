import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { navigateWithinApp } from "../lib/app-navigation";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastInput {
  tone?: ToastTone;
  title?: string;
  message: string;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss. Errors and warnings stay visible until dismissed by default. */
  durationMs?: number;
}

interface ToastItem {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
  action?: ToastAction;
  durationMs: number;
}

export interface ToastApi {
  show(input: ToastInput): string;
  info(message: string, options?: Omit<ToastInput, "message" | "tone">): string;
  success(message: string, options?: Omit<ToastInput, "message" | "tone">): string;
  warning(message: string, options?: Omit<ToastInput, "message" | "tone">): string;
  error(message: string, options?: Omit<ToastInput, "message" | "tone">): string;
  fromError(caught: unknown, fallbackAction?: ToastAction): string;
  dismiss(id: string): void;
}

export function recoveryActionForError(caught: unknown): ToastAction | undefined {
  if (!(caught instanceof ApiError)) return undefined;
  const code = caught.code;
  if (["SETUP_REQUIRED", "MODEL_NOT_CONFIGURED", "GRADING_MODEL_NOT_CONFIGURED", "QA_FAILED", "RUBRIC_DESIGN_FAILED", "GRADING_MODEL_REQUEST_FAILED"].includes(code)) {
    return { label: "前往模型设置", onClick: () => navigateWithinApp("/settings/models") };
  }
  if (["ACTIVE_RELEASE_NOT_FOUND", "KNOWLEDGE_ERROR", "GRADING_KNOWLEDGE_UNAVAILABLE"].includes(code)) {
    return { label: "前往课程资料库", onClick: () => navigateWithinApp("/knowledge") };
  }
  if (code === "RUBRIC_COURSE_BINDING_ERROR") {
    return { label: "管理课程", onClick: () => navigateWithinApp("/knowledge") };
  }
  return undefined;
}

const noopToastApi: ToastApi = {
  show: () => "",
  info: () => "",
  success: () => "",
  warning: () => "",
  error: () => "",
  fromError: () => "",
  dismiss: () => undefined,
};

const ToastContext = createContext<ToastApi>(noopToastApi);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const toneIcon: Record<ToastTone, string> = {
  info: "i",
  success: "✓",
  warning: "!",
  error: "!",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, [clearTimer]);

  const scheduleDismiss = useCallback((id: string, durationMs: number) => {
    clearTimer(id);
    if (durationMs <= 0) return;
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    }, durationMs));
  }, [clearTimer]);

  useEffect(() => () => {
    for (const handle of timers.current.values()) clearTimeout(handle);
    timers.current.clear();
  }, []);

  const show = useCallback((input: ToastInput): string => {
    const tone = input.tone ?? "info";
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const defaultDuration = tone === "error" || tone === "warning" ? 0 : (input.action ? 6000 : 3600);
    const durationMs = input.durationMs ?? defaultDuration;
    setItems((current) => [...current.slice(-3), { id, tone, title: input.title, message: input.message, action: input.action, durationMs }]);
    if (durationMs > 0) scheduleDismiss(id, durationMs);
    return id;
  }, [scheduleDismiss]);

  const api = useMemo<ToastApi>(() => ({
    show,
    info: (message, options) => show({ ...options, message, tone: "info" }),
    success: (message, options) => show({ ...options, message, tone: "success" }),
    warning: (message, options) => show({ ...options, message, tone: "warning" }),
    error: (message, options) => show({ ...options, message, tone: "error" }),
    fromError: (caught, fallbackAction) => {
      const message = caught instanceof Error && caught.message.trim()
        ? caught.message
        : "操作未完成，请稍后重试。";
      const action = fallbackAction ?? recoveryActionForError(caught);
      return show({ tone: "error", message, action });
    },
    dismiss,
  }), [dismiss, show]);

  return <ToastContext.Provider value={api}>
    {children}
    {items.length > 0 && <div className="toast-viewport" aria-label="系统通知">
      {items.map((item) => <section
        key={item.id}
        className={`toast-item toast-${item.tone}`}
        role={item.tone === "error" || item.tone === "warning" ? "alert" : "status"}
        aria-live={item.tone === "error" || item.tone === "warning" ? "assertive" : "polite"}
        onMouseEnter={() => clearTimer(item.id)}
        onMouseLeave={() => { if (item.durationMs > 0) scheduleDismiss(item.id, Math.min(item.durationMs, 2500)); }}
      >
        <span className="toast-icon" aria-hidden="true">{toneIcon[item.tone]}</span>
        <div className="toast-body">
          {item.title && <strong>{item.title}</strong>}
          <p>{item.message}</p>
          {item.action && <div className="toast-actions">
            <button type="button" className="toast-action-button" onClick={() => { item.action?.onClick(); dismiss(item.id); }}>{item.action.label}</button>
          </div>}
        </div>
        <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => dismiss(item.id)}>×</button>
      </section>)}
    </div>}
  </ToastContext.Provider>;
}
