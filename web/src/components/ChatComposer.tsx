import { useEffect, useRef } from "react";

export function ChatComposer({ value, onChange, onSend, onStop, allowWebSearch, onAllowWebSearchChange, disabled, streaming }: { value: string; onChange(value: string): void; onSend(): void; onStop(): void; allowWebSearch: boolean; onAllowWebSearchChange(value: boolean): void; disabled: boolean; streaming: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [value]);
  return <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
    <textarea ref={input} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || streaming} placeholder={disabled ? "请选择已发布课程后开始答疑" : "输入你的课程问题"} aria-label="课程问题" rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} />
    <label className="web-search-toggle"><input type="checkbox" checked={allowWebSearch} onChange={(event) => onAllowWebSearchChange(event.target.checked)} disabled={disabled || streaming} />联网搜索</label>
    {streaming ? <button type="button" className="stop-button" onClick={onStop}>停止生成</button> : <button type="submit" disabled={disabled || !value.trim()}>发送</button>}
  </form>;
}
