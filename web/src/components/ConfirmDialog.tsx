import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";

export function ConfirmDialog({
  open,
  title,
  description,
  details,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "default",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const target = tone === "danger" ? cancelRef.current : confirmRef.current;
    target?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, tone, busy, onCancel]);

  if (!open) return null;

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="session-modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="modal-close" aria-label="关闭弹窗" disabled={busy} onClick={onCancel}>×</button>
      </div>
      <div className="modal-description">{typeof description === "string" ? <p>{description}</p> : description}</div>
      {details && details.length > 0 && <ul className="modal-detail-list">{details.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button ref={confirmRef} type="button" className={tone === "danger" ? "danger-button" : "primary-button"} disabled={busy} onClick={onConfirm}>
          {busy ? "处理中…" : confirmLabel}
        </button>
      </div>
    </section>
  </div>;
}

export function PromptDialog({
  open,
  title,
  label,
  description,
  value,
  placeholder,
  suggestions,
  confirmLabel = "保存",
  cancelLabel = "取消",
  maxLength = 120,
  busy = false,
  error,
  onChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  suggestions?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  maxLength?: number;
  busy?: boolean;
  error?: string;
  onChange(value: string): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && value.trim()) onConfirm();
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="session-modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" aria-label="关闭弹窗" disabled={busy} onClick={onCancel}>×</button>
        </div>
        {description && <p className="modal-hint">{description}</p>}
        <label>
          {label}
          <input
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            list={suggestions && suggestions.length > 0 ? listId : undefined}
            autoFocus
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        {suggestions && suggestions.length > 0 && <datalist id={listId}>
          {suggestions.map((item) => <option key={item} value={item} />)}
        </datalist>}
        {error && <p className="modal-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="submit" className="primary-button" disabled={busy || !value.trim()}>{busy ? "保存中…" : confirmLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}
