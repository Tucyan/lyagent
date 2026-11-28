import { reviewReasonLabel } from "../lib/api.js";

export function GradingReviewChecklist({ confirmed, reasons, notices = [], acknowledgedReasons, onChange }: {
  confirmed: boolean;
  reasons: string[];
  notices?: string[];
  acknowledgedReasons: string[];
  onChange(value: string[]): void;
}) {
  if (!reasons.length) return null;
  const allChecked = reasons.every((reason) => acknowledgedReasons.includes(reason));
  return <section className={`review-alert ${confirmed ? "review-completed" : ""}`}>
    <div className="review-alert-head">
      <strong>{confirmed ? "已完成教师复核" : "需要教师复核并逐项确认"}</strong>
      {!confirmed && reasons.length > 1 && (
        <button
          type="button"
          className="text-button review-alert-toggle-all"
          onClick={() => onChange(allChecked ? [] : [...reasons])}
        >
          {allChecked ? "取消全选" : "全部勾选"}
        </button>
      )}
    </div>
    {confirmed ? <ul>{reasons.map(reason => <li key={reason}>{reviewReasonLabel(reason)}</li>)}</ul>
      : reasons.map(reason => <label key={reason}><input type="checkbox" checked={acknowledgedReasons.includes(reason)} onChange={event => onChange(event.target.checked ? [...new Set([...acknowledgedReasons, reason])] : acknowledgedReasons.filter(item => item !== reason))} />{reviewReasonLabel(reason)}</label>)}
    {notices.length > 0 && <div className="review-notices"><strong>具体说明</strong><ul>{notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul></div>}
  </section>;
}
