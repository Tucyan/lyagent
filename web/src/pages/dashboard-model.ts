export type DashboardCourse = {
  id: string;
  name: string;
  createdAt: string;
  knowledgeStatus: "published" | "unpublished" | "unavailable";
  activeRelease: { id: string; createdAt: string } | null;
  releaseCount: number;
  documentCount: number;
  qaSessionCount: number;
  lastActivityAt: string;
};

export type DashboardActivity =
  | { type: "course_created"; courseId: string; courseName: string; at: string }
  | { type: "release_published"; courseId: string; courseName: string; releaseId: string; at: string }
  | { type: "qa_session_updated"; courseId: string; courseName: string; sessionId: string; summary: string; at: string };

export type DashboardModelStatus = {
  provider: string;
  model: string;
  configured: boolean;
};

export type DashboardRuntime = {
  converter: {
    provider: "docling";
    status: "starting" | "ready" | "unavailable";
    device: "auto" | "cpu";
  };
};

export type DashboardSnapshot = {
  generatedAt: string;
  model: DashboardModelStatus;
  totals: {
    courses: number;
    publishedCourses: number;
    activeDocuments: number;
    qaSessions: number;
  };
  courses: DashboardCourse[];
  recentActivity: DashboardActivity[];
};

export type DashboardSystemAlert = {
  id: string;
  tone: "warning" | "info";
  title: string;
  detail: string;
  actionLabel?: string;
  actionHref?: string;
};

export type SystemReadinessSummary = {
  tone: "ready" | "info" | "warning";
  label: string;
  href: string;
  title: string;
};

export const dashboardQuickActions = [
  {
    href: "/knowledge",
    label: "整理课程资料",
    description: "上传 PDF、Word 或讲义，更新课程答疑资料库。",
  },
  {
    href: "/rubrics",
    label: "制定评分标准",
    description: "与 AI 一起梳理作业评分细则并定稿。",
  },
  {
    href: "/grading",
    label: "批改单份作业",
    description: "上传学生报告，按已定稿评分标准生成评分与评语。",
  },
  {
    href: "/grading/batches",
    label: "整班批量批改",
    description: "一次上传全班作业，集中复核成绩并导出成绩表。",
  },
] as const;

export const dashboardOnboardingSteps = [
  {
    step: "1",
    title: "创建课程并上传资料",
    description: "新建课程后导入课件、讲义或作业说明，支持 PDF、Word 与 Markdown。",
    actionLabel: "去创建课程",
    href: "/knowledge",
  },
  {
    step: "2",
    title: "发布资料，开启智能答疑",
    description: "确认资料整理无误后点击发布，即可基于课程内容进行问答。",
    actionLabel: "前往资料库",
    href: "/knowledge",
  },
  {
    step: "3",
    title: "制定评分标准并批改作业",
    description: "和 AI 一起完善评分细则，定稿后可单份精批或整班批量批改。",
    actionLabel: "制定评分标准",
    href: "/rubrics",
  },
] as const;

export function dashboardHeadlineSummary(totals: DashboardSnapshot["totals"]): string {
  if (totals.courses === 0) {
    return "还没有创建课程，按下面三步即可开始使用。";
  }
  return `当前共有 ${totals.courses} 门课程，其中 ${totals.publishedCourses} 门已开启课程答疑。`;
}

export function dashboardSystemAlerts(
  model: DashboardModelStatus,
  runtime?: DashboardRuntime,
): DashboardSystemAlert[] {
  const alerts: DashboardSystemAlert[] = [];

  if (!model.configured) {
    alerts.push({
      id: "model-unconfigured",
      tone: "warning",
      title: "AI 助教尚未配置",
      detail: "完成模型设置后，即可使用课程答疑、评分标准制定和作业批改。",
      actionLabel: "前往模型设置",
      actionHref: "/settings/models",
    });
  }

  if (runtime?.converter.status === "starting") {
    alerts.push({
      id: "converter-starting",
      tone: "info",
      title: "课件解析服务准备中",
      detail: "PDF 与 Word 文档解析即将就绪，稍后即可直接上传。",
    });
  } else if (runtime?.converter.status === "unavailable") {
    alerts.push({
      id: "converter-unavailable",
      tone: "warning",
      title: "PDF / Word 解析暂不可用",
      detail: "当前仍可直接上传 Markdown 讲义，或稍后刷新重试文档解析服务。",
    });
  }

  return alerts;
}

export function systemReadinessSummary(
  model: DashboardModelStatus,
  runtime?: DashboardRuntime,
): SystemReadinessSummary {
  if (!model.configured) {
    return {
      tone: "warning",
      label: "待配置模型",
      href: "/settings/models",
      title: "点击前往模型设置",
    };
  }
  if (runtime?.converter.status === "starting") {
    return {
      tone: "info",
      label: "解析服务准备中",
      href: "/settings/models",
      title: "PDF / Word 解析正在启动，点击查看模型与系统设置",
    };
  }
  if (runtime?.converter.status === "unavailable") {
    return {
      tone: "warning",
      label: "文档解析异常",
      href: "/settings/models",
      title: "PDF / Word 解析暂不可用，点击查看模型与系统设置",
    };
  }
  return {
    tone: "ready",
    label: "AI 助教已就绪",
    href: "/settings/models",
    title: "点击查看或修改模型设置",
  };
}

export function courseStatusPresentation(
  status: DashboardCourse["knowledgeStatus"],
): { label: string; tone: DashboardCourse["knowledgeStatus"] } {
  if (status === "published") return { label: "答疑已开启", tone: "published" };
  if (status === "unpublished") return { label: "待发布资料", tone: "unpublished" };
  return { label: "资料需重新发布", tone: "unavailable" };
}

export function activityPresentation(activity: DashboardActivity): {
  title: string;
  description: string;
  href: string;
  actionLabel: string;
} {
  const courseParam = encodeURIComponent(activity.courseId);
  if (activity.type === "course_created") {
    return {
      title: activity.courseName,
      description: "创建了这门课程",
      href: `/knowledge?course=${courseParam}`,
      actionLabel: "整理资料",
    };
  }
  if (activity.type === "release_published") {
    return {
      title: activity.courseName,
      description: "更新了生效课程资料",
      href: `/knowledge?course=${courseParam}`,
      actionLabel: "查看资料",
    };
  }
  return {
    title: activity.courseName,
    description: `答疑：${activity.summary}`,
    href: `/qa?course=${courseParam}`,
    actionLabel: "继续答疑",
  };
}
