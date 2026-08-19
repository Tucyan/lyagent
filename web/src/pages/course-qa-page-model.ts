export type KnowledgeStatus = "idle" | "loading" | "ready" | "missing" | "error";

export function courseQaComposerState(input: { courseId: string; knowledgeStatus: KnowledgeStatus; modelReady: boolean }): { disabled: boolean; placeholder: string } {
  if (!input.courseId) return { disabled: true, placeholder: "请选择课程后开始答疑" };
  if (input.knowledgeStatus === "loading" || input.knowledgeStatus === "idle") return { disabled: true, placeholder: "正在加载当前课程资料…" };
  if (input.knowledgeStatus === "missing") return { disabled: true, placeholder: "当前课程尚未发布资料，请先到课程资料库发布" };
  if (input.knowledgeStatus === "error") return { disabled: true, placeholder: "当前课程资料加载失败，请稍后重试" };
  if (!input.modelReady) return { disabled: true, placeholder: "请先完成主模型设置" };
  return { disabled: false, placeholder: "输入你的课程问题" };
}
