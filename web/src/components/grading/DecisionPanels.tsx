import type { RubricValue } from "../RubricPreviewEditor";
import { gradingItemLabel } from "../../pages/grading-page-model";

function decisionEntries(decisions: Record<string, unknown>) {
  return ["criteria", "deductions", "bonuses"].flatMap((key) =>
    Array.isArray(decisions[key])
      ? (decisions[key] as Array<Record<string, unknown>>).map(
          (item, index) => ({ key, index, item }),
        )
      : [],
  );
}

export function DecisionCards({
  decisions,
  sessionId,
  rubric,
  expandEvidence,
}: {
  decisions: Record<string, unknown>;
  sessionId: string;
  rubric?: RubricValue;
  expandEvidence?: boolean;
}) {
  return (
    <section className="decision-list">
      {decisionEntries(decisions).map(({ item }, index) => {
        const evidence = Array.isArray(item.evidence)
          ? (item.evidence as Array<Record<string, unknown>>)
          : [];
        return (
          <article key={String(item.criterionId ?? item.ruleId ?? index)}>
            <div>
              <strong>
                {gradingItemLabel(rubric, String(item.criterionId ?? item.ruleId ?? ""), index)}
              </strong>
              <span>
                {item.score !== undefined
                  ? `${item.score} 分`
                  : item.deduction !== undefined
                    ? `扣 ${item.deduction} 分`
                    : item.bonus !== undefined
                      ? `加 ${item.bonus} 分`
                      : ""}
              </span>
            </div>
            <p>{String(item.reason ?? "")}</p>
            <small>
              置信度 {Math.round(Number(item.confidence ?? 0) * 100)}% ·
              分析依据 {evidence.length} 条
            </small>
            {evidence.length > 0 && (
              <details open={expandEvidence}>
                <summary>查看评分分析依据</summary>
                {evidence.map((entry, evidenceIndex) => (
                  <div
                    className="grading-evidence"
                    key={`${String(entry.path ?? entry.kind)}-${evidenceIndex}`}
                  >
                    {entry.kind === "analysis" ? (
                      <>
                        <strong>模型分析论据</strong>
                        <p>
                          <b>作业表现：</b>
                          {String(entry.observation ?? "")}
                        </p>
                        <p>
                          <b>标准对应：</b>
                          {String(entry.rubricBasis ?? "")}
                        </p>
                        <p>
                          <b>分值理由：</b>
                          {String(entry.scoreJustification ?? "")}
                        </p>
                      </>
                    ) : entry.kind === "image" ? (
                      <>
                        <img
                          src={`/api/grading/sessions/${sessionId}/assets/${encodeURIComponent(String(entry.path).replace(/^assets\//, ""))}`}
                          alt="评分佐证"
                        />
                        <p>{String(entry.explanation ?? "")}</p>
                      </>
                    ) : (
                      <>
                        <code>
                          {String(entry.path)}:{String(entry.startLine)}-
                          {String(entry.endLine)}
                        </code>
                        <blockquote>{String(entry.quote ?? "")}</blockquote>
                      </>
                    )}
                  </div>
                ))}
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function DecisionEditor({
  decisions,
  onChange,
  rubric,
}: {
  decisions: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  rubric?: RubricValue;
}) {
  const update = (
    key: string,
    index: number,
    field: string,
    value: unknown,
  ) => {
    const next = structuredClone(decisions);
    const items = next[key] as Array<Record<string, unknown>>;
    items[index] = { ...items[index], [field]: value };
    onChange(next);
  };
  return (
    <section className="decision-list decision-editor">
      {decisionEntries(decisions).map(({ key, index, item }) => (
        <article key={`${key}-${index}`}>
          <strong>{gradingItemLabel(rubric, String(item.criterionId ?? item.ruleId ?? ""), index)}</strong>
          {item.triggered !== undefined && (
            <label>
              <input
                type="checkbox"
                checked={Boolean(item.triggered)}
                onChange={(event) =>
                  update(key, index, "triggered", event.target.checked)
                }
              />
              触发规则
            </label>
          )}
          {["score", "deduction", "bonus"]
            .filter((field) => item[field] !== undefined)
            .map((field) => (
              <label key={field}>
                {{ score: "得分", deduction: "扣分", bonus: "加分" }[field]}
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={Number(item[field])}
                  onChange={(event) =>
                    update(key, index, field, Number(event.target.value))
                  }
                />
              </label>
            ))}
          <label>
            理由
            <textarea
              value={String(item.reason ?? "")}
              onChange={(event) =>
                update(key, index, "reason", event.target.value)
              }
            />
          </label>
          <label>
            置信度
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={Number(item.confidence ?? 0)}
              onChange={(event) =>
                update(key, index, "confidence", Number(event.target.value))
              }
            />
          </label>
        </article>
      ))}
    </section>
  );
}
