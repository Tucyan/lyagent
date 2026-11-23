export const dashboardQuickActions = [
  {
    href: "/knowledge",
    label: "管理课程资料",
    description: "导入、整理并发布课程知识版本。",
  },
  {
    href: "/rubrics",
    label: "创建评分量表",
    description: "新建评分会话，和 AI 一起制定可冻结的评分标准。",
  },
  {
    href: "/grading",
    label: "批改单份作业",
    description: "上传学生报告，使用冻结评分表开始可复核的会话式批改。",
  },
  {
    href: "/grading/batches",
    label: "批量批改作业",
    description: "一次上传全班报告并发批改，集中复核成绩并导出班级成绩表。",
  },
] as const;

export function converterStatusLabel(value: { provider: "docling"; status: "starting" | "ready" | "unavailable"; device: "auto" | "cpu" }): string {
  const status = value.status === "ready" ? "就绪" : value.status === "starting" ? "启动中" : "不可用";
  return `Docling ${status} · ${value.device}`;
}
