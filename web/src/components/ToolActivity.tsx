import { useState } from "react";
import { visibleToolSteps } from "../lib/qa-presentation";

export interface ToolStep {
  id: string;
  label: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

export function ToolActivity({ steps, streaming }: { steps: ToolStep[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return streaming ? <p className="qa-status">正在准备回答…</p> : null;
  const completed = !streaming && steps.every((step) => step.status !== "running");
  const usesWeb = steps.some((step) => step.label === "搜索网络" || step.label === "阅读网页");
  const displayedSteps = visibleToolSteps(steps, expanded);
  const hiddenCount = steps.length - displayedSteps.length;
  return <details className="tool-activity" open={!completed}>
    <summary>{streaming ? (usesWeb ? "正在查阅资料与网络来源" : "正在查阅课程资料") : (usesWeb ? "资料与网络检索过程" : "资料检索过程")}</summary>
    <ol>{displayedSteps.map((step) => <li key={step.id} className={`tool-step ${step.status}`}><span aria-hidden="true">{step.status === "running" ? "…" : step.status === "completed" ? "✓" : "!"}</span><span>{step.label}</span><small>{step.summary}</small></li>)}</ol>
    {steps.length > 5 && <button className="tool-activity-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "收起工具调用" : `展开其余 ${hiddenCount} 条工具调用`}</button>}
  </details>;
}
