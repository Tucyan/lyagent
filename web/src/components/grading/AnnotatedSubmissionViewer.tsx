import { createContext, useContext, useEffect, useMemo, useRef, type ComponentPropsWithoutRef } from "react";
import type { Components, ExtraProps } from "react-markdown";
import { SubmissionMarkdown } from "./SubmissionMarkdown.js";
import type { EvidenceJumpPayload, EvidenceJumpTarget } from "./grading-result-model.js";

type HastNode = ExtraProps["node"];

const AnnotationTargetContext = createContext<EvidenceJumpTarget | undefined>(undefined);

function blockAnnotationProps(
  node: HastNode,
  activeTarget: EvidenceJumpTarget | undefined,
  baseClass = "annotated-md-block",
) {
  const startLine = node?.position?.start?.line;
  const endLine = node?.position?.end?.line;
  const isHighlighted =
    activeTarget?.kind === "text" &&
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    startLine <= activeTarget.endLine &&
    endLine >= activeTarget.startLine;

  return {
    ...(typeof startLine === "number" ? { "data-line": startLine } : {}),
    ...(typeof endLine === "number" ? { "data-end-line": endLine } : {}),
    className: `${baseClass}${isHighlighted ? " is-highlighted" : ""}`,
  };
}

export function AnnotatedSubmissionViewer({
  sessionId,
  markdown,
  activeTarget,
  allTargets = [],
  onSelectTarget,
  onClearTarget,
}: {
  sessionId: string;
  markdown: string;
  decisions?: Record<string, unknown> | undefined;
  activeTarget?: EvidenceJumpTarget | undefined;
  allTargets?: EvidenceJumpPayload[];
  onSelectTarget?: (target: EvidenceJumpPayload) => void;
  onClearTarget?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIndex = activeTarget
    ? allTargets.findIndex((item) => item.key === activeTarget.key)
    : -1;
  const totalTargets = allTargets.length;
  const stepTarget = (delta: number) => {
    if (!onSelectTarget || totalTargets === 0) return;
    const base = activeIndex >= 0 ? activeIndex : 0;
    const nextIndex = (base + delta + totalTargets) % totalTargets;
    const next = allTargets[nextIndex];
    if (next) onSelectTarget(next);
  };

  useEffect(() => {
    if (!activeTarget || !containerRef.current) return;
    const target = containerRef.current.querySelector<HTMLElement>(".is-highlighted");
    target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [activeTarget?.key, activeTarget?.nonce]);

  const components = useMemo<Components>(() => {
    const withBlock = <K extends "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "blockquote" | "pre" | "table" | "li">(
      Tag: K,
    ) => {
      return function AnnotatedBlock({
        node,
        className,
        children,
        ...rest
      }: ComponentPropsWithoutRef<K> & ExtraProps) {
        const currentTarget = useContext(AnnotationTargetContext);
        const ann = blockAnnotationProps(node, currentTarget);
        const mergedClass = [className, ann.className].filter(Boolean).join(" ");
        const ElementTag = Tag as "p";
        return (
          <ElementTag
            {...(rest as ComponentPropsWithoutRef<"p">)}
            data-line={ann["data-line"]}
            data-end-line={ann["data-end-line"]}
            className={mergedClass}
          >
            {children}
          </ElementTag>
        );
      };
    };

    return {
      h1: withBlock("h1"),
      h2: withBlock("h2"),
      h3: withBlock("h3"),
      h4: withBlock("h4"),
      h5: withBlock("h5"),
      h6: withBlock("h6"),
      p: withBlock("p"),
      blockquote: withBlock("blockquote"),
      pre: withBlock("pre"),
      table: withBlock("table"),
      li: withBlock("li"),
      img: function AnnotatedImage({ node, className, alt, ...props }) {
        const currentTarget = useContext(AnnotationTargetContext);
        const isImageHighlighted =
          currentTarget?.kind === "image" && node?.properties.dataAssetPath === currentTarget.path;
        return (
          <img
            {...props}
            alt={alt ?? "学生报告插图"}
            className={[className, "annotated-image-inline", isImageHighlighted ? "is-highlighted" : ""]
              .filter(Boolean)
              .join(" ")}
          />
        );
      },
    };
  }, []);

  return (
    <div className="annotated-submission" ref={containerRef}>
      {activeTarget ? (
        <div className="annotated-jump-banner" role="status">
          <span>
            已定位：<strong>{activeTarget.itemLabel}</strong> ·{" "}
            {activeTarget.kind === "text"
              ? `${activeTarget.path}:${activeTarget.startLine}-${activeTarget.endLine}`
              : activeTarget.path}
            {totalTargets > 0 && activeIndex >= 0 && (
              <em className="annotated-jump-counter">（{activeIndex + 1}/{totalTargets}）</em>
            )}
          </span>
          <div className="annotated-jump-controls">
            {onSelectTarget && totalTargets > 1 && (
              <>
                <button type="button" className="text-button" onClick={() => stepTarget(-1)}>
                  上一处
                </button>
                <button type="button" className="text-button" onClick={() => stepTarget(1)}>
                  下一处
                </button>
              </>
            )}
            {onClearTarget && (
              <button type="button" className="text-button" onClick={onClearTarget}>
                清除标记
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="annotated-hint-banner">
          <span>点击右侧任意评分依据，左侧自动跳转并以黄色底纹标出对应段落或图片。</span>
          {onSelectTarget && totalTargets > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => onSelectTarget(allTargets[0]!)}
            >
              定位首条依据（共 {totalTargets} 处）
            </button>
          )}
        </div>
      )}

      <div className="annotated-markdown-body" role="document" aria-label="批注模式学生作业">
        <AnnotationTargetContext.Provider value={activeTarget}>
          <SubmissionMarkdown sessionId={sessionId} components={components}>
            {markdown}
          </SubmissionMarkdown>
        </AnnotationTargetContext.Provider>
      </div>
    </div>
  );
}
