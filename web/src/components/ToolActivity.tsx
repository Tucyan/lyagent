import { useState } from "react";
import { collapseConsecutiveToolSteps, visibleToolSteps } from "../lib/qa-presentation";

export interface ToolStep {
  id: string;
  label: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

export function ToolActivity({ steps, streaming, title, streamingTitle }: { steps: ToolStep[]; streaming: boolean; title?: string; streamingTitle?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return streaming ? <p className="qa-status">正在准备回答…</p> : null;
  const completed = !streaming && steps.every((step) => step.status !== "running");
  const usesWeb = steps.some((step) => step.label === "搜索网络" || step.label === "阅读网页");
  const collapsedSteps = collapseConsecutiveToolSteps(steps);
  const displayedSteps = visibleToolSteps(collapsedSteps, expanded);
  const hiddenCount = collapsedSteps.length - displayedSteps.length;
  const headingBase = streaming
    ? (streamingTitle ?? (usesWeb ? "正在查阅资料与网络来源" : "正在查阅课程资料"))
    : (title ?? (usesWeb ? "资料与网络检索过程" : "资料检索过程"));
  const headingMeta = !streaming && steps.length > 0
    ? (collapsedSteps.length < steps.length ? ` · ${collapsedSteps.length} 项（共 ${steps.length} 次调用）` : ` · ${steps.length} 项`)
    : "";

  return <details className="tool-activity" open={!completed}>
    <summary>{headingBase}{headingMeta && <small className="tool-activity-meta">{headingMeta}</small>}</summary>
    <ol>{displayedSteps.map((step) => <li key={step.id} className={`tool-step ${step.status}`}>
      <span aria-hidden="true">{step.status === "running" ? "…" : step.status === "completed" ? "✓" : "!"}</span>
      <span className="tool-step-label">{step.label}{step.count > 1 && <em className="tool-step-count">×{step.count}</em>}</span>
      <small>{step.summary}</small>
    </li>)}</ol>
    {collapsedSteps.length > 5 && <button className="tool-activity-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "收起步骤" : `展开其余 ${hiddenCount} 项步骤`}</button>}
  </details>;
}
