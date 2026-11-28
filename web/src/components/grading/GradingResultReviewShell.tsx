import { useState, type ReactNode } from "react";
import type { AnyRubricLike } from "../../../../src/schemas/rubric-engine.js";
import { GradingReviewChecklist } from "../GradingReviewChecklist.js";
import { DecisionCards } from "./DecisionPanels";
import {
  summarizeGradingResult,
  type EvidenceJumpPayload,
  type GradingResultSummaryInput,
} from "./grading-result-model.js";

export function GradingResultReviewShell({
  mode,
  sessionId,
  result,
  rubric,
  confirmed,
  confirmationMode,
  editing,
  acknowledgedReasons,
  onChangeAcknowledgedReasons,
  reviewActions,
  confirmedSection,
  editorSection,
  showHeader = true,
  externalExpandAll,
  externalExpandEpoch = 0,
  onToggleExternalExpandAll,
  annotationMode = false,
  activeEvidenceKey,
  onSelectEvidence,
  onEditItem,
}: {
  mode: "single" | "batch";
  sessionId: string;
  result: GradingResultSummaryInput;
  rubric?: AnyRubricLike;
  confirmed: boolean;
  confirmationMode?: "auto" | "manual" | undefined;
  editing: boolean;
  acknowledgedReasons: string[];
  onChangeAcknowledgedReasons(value: string[]): void;
  reviewActions?: ReactNode;
  confirmedSection?: ReactNode;
  editorSection?: ReactNode;
  showHeader?: boolean;
  externalExpandAll?: boolean;
  externalExpandEpoch?: number;
  onToggleExternalExpandAll?(next: boolean): void;
  annotationMode?: boolean;
  activeEvidenceKey?: string | undefined;
  onSelectEvidence?: (target: EvidenceJumpPayload) => void;
  onEditItem?: (itemKey: string) => void;
}) {
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [localExpandAll, setLocalExpandAll] = useState(false);
  const [localExpandEpoch, setLocalExpandEpoch] = useState(0);
  const [focusAttentionEpoch, setFocusAttentionEpoch] = useState(0);

  const expandAll = externalExpandAll ?? localExpandAll;
  const setExpandAll = (next: boolean) => {
    if (onToggleExternalExpandAll) onToggleExternalExpandAll(next);
    else setLocalExpandAll(next);
    setLocalExpandEpoch((epoch) => epoch + 1);
  };

  const summary = summarizeGradingResult(result, {
    mode,
    confirmed,
    ...(confirmationMode ? { confirmationMode } : {}),
  });
  const reasons = result.review.reasons ?? [];
  const notices = Array.isArray(result.decisions.warnings)
    ? (result.decisions.warnings as string[])
    : [];

  return (
    <div className="grading-review-shell">
      {showHeader && (
        <header className="grading-overview-header">
          <div className="grading-overview-score">
            <span>程序计算总分</span>
            <div className="grading-overview-score-row">
              <strong>
                {summary.earned}/{summary.possible}
              </strong>
              <small>得分率 {summary.scorePercent}%</small>
            </div>
          </div>
          <div className="grading-overview-meta">
            <span className={`grading-status-pill is-${summary.statusTone}${confirmed && confirmationMode === "auto" ? " is-auto-confirmed" : ""}`}>
              {summary.statusLabel}
            </span>
            <span
              className={`grading-confidence-pill${summary.lowConfidenceCount > 0 || summary.minimumConfidencePercent < 70 ? " is-warn" : ""}`}
            >
              置信度 {summary.overallConfidencePercent}%
              {summary.attentionItemCount > 0 ? ` · ${summary.attentionItemCount} 项需关注` : ""}
            </span>
          </div>
        </header>
      )}

      <div className={`grading-next-step is-${summary.statusTone}`} role="status">
        <span>{summary.nextStep}</span>
        {!editing && summary.attentionItemCount > 0 && (
          <button
            type="button"
            className="text-button grading-focus-attention-btn"
            onClick={() => {
              setAttentionOnly(true);
              setFocusAttentionEpoch((epoch) => epoch + 1);
            }}
          >
            查看 {summary.attentionItemCount} 项需关注分项 →
          </button>
        )}
      </div>

      <GradingReviewChecklist
        confirmed={confirmed}
        reasons={reasons}
        notices={notices}
        acknowledgedReasons={acknowledgedReasons}
        onChange={onChangeAcknowledgedReasons}
      />

      {confirmed ? confirmedSection : !editing ? reviewActions : null}

      {editing ? (
        <section className="grading-edit-section">{editorSection}</section>
      ) : (
        <details
          key={`breakdown-${sessionId}-${externalExpandEpoch}-${focusAttentionEpoch}-${annotationMode ? "annotated" : "normal"}`}
          className="grading-breakdown-disclosure"
          open={externalExpandAll || annotationMode || focusAttentionEpoch > 0 ? true : undefined}
        >
          <summary>
            <span>分项得分与判断详情（共 {summary.totalItems} 项）</span>
            <span className="grading-breakdown-badges">
              {summary.attentionItemCount > 0 ? (
                <small className="is-warn">{summary.attentionItemCount} 项需关注</small>
              ) : (
                <small>点击按需展开</small>
              )}
            </span>
          </summary>
          <div className="grading-breakdown-content">
            <div className="grading-breakdown-toolbar">
              {summary.attentionItemCount > 0 && (
                <div className="grading-breakdown-filter" role="group" aria-label="筛选分项判断">
                  <button
                    type="button"
                    className={!attentionOnly ? "active" : ""}
                    onClick={() => setAttentionOnly(false)}
                  >
                    全部 ({summary.totalItems})
                  </button>
                  <button
                    type="button"
                    className={attentionOnly ? "active" : ""}
                    onClick={() => setAttentionOnly(true)}
                  >
                    仅看需关注 ({summary.attentionItemCount})
                  </button>
                </div>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => setExpandAll(!expandAll)}
              >
                {expandAll ? "收起全部详情" : "展开全部理由与依据"}
              </button>
            </div>
            <DecisionCards
              decisions={result.decisions}
              rubric={rubric}
              sessionId={sessionId}
              expandEvidence={expandAll}
              attentionOnly={attentionOnly}
              expandEpoch={localExpandEpoch + externalExpandEpoch}
              annotationMode={annotationMode}
              activeEvidenceKey={activeEvidenceKey}
              onSelectEvidence={onSelectEvidence}
              onEditItem={!confirmed ? onEditItem : undefined}
            />
          </div>
        </details>
      )}
    </div>
  );
}
