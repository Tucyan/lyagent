import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activityPresentation,
  courseStatusPresentation,
  dashboardHeadlineSummary,
  dashboardOnboardingSteps,
  dashboardQuickActions,
  dashboardSystemAlerts,
  systemReadinessSummary,
} from "../web/src/pages/dashboard-model.js";

describe("dashboard teacher-friendly model", () => {
  it("provides teacher-friendly quick actions without developer jargon", () => {
    expect(dashboardQuickActions).toHaveLength(4);
    expect(dashboardQuickActions).toContainEqual(expect.objectContaining({
      href: "/rubrics",
      label: "制定评分标准",
    }));
    expect(dashboardQuickActions).toContainEqual(expect.objectContaining({
      href: "/grading/batches",
      label: "整班批量批改",
    }));

    const combinedText = dashboardQuickActions.map((item) => `${item.label} ${item.description}`).join(" ");
    expect(combinedText).not.toMatch(/冻结|并发|active release|Docling/i);
  });

  it("hides system alerts when model and converter are ready, and surfaces actionable alerts otherwise", () => {
    expect(
      dashboardSystemAlerts(
        { provider: "openai", model: "gpt-4o", configured: true },
        { converter: { provider: "docling", status: "ready", device: "auto" } },
      ),
    ).toEqual([]);

    const unconfiguredAlerts = dashboardSystemAlerts(
      { provider: "openai", model: "gpt-4o", configured: false },
      { converter: { provider: "docling", status: "starting", device: "cpu" } },
    );
    expect(unconfiguredAlerts).toHaveLength(2);
    expect(unconfiguredAlerts[0]).toMatchObject({
      tone: "warning",
      actionHref: "/settings/models",
    });
    expect(unconfiguredAlerts[1]).toMatchObject({
      tone: "info",
    });
    expect(unconfiguredAlerts.map((item) => `${item.title} ${item.detail}`).join(" ")).not.toMatch(/Docling|auto|cpu/i);
  });

  it("formats compact readiness pill without exposing provider or device internals", () => {
    const ready = systemReadinessSummary(
      { provider: "openai", model: "gpt-4o", configured: true },
      { converter: { provider: "docling", status: "ready", device: "auto" } },
    );
    expect(ready).toMatchObject({
      tone: "ready",
      label: "AI 助教已就绪",
      href: "/settings/models",
    });

    const missingModel = systemReadinessSummary(
      { provider: "openai", model: "gpt-4o", configured: false },
      { converter: { provider: "docling", status: "ready", device: "auto" } },
    );
    expect(missingModel).toMatchObject({
      tone: "warning",
      label: "待配置模型",
      href: "/settings/models",
    });
  });

  it("maps course status, headline summary, onboarding steps, and clickable activities into teacher language", () => {
    expect(courseStatusPresentation("published")).toEqual({ label: "答疑已开启", tone: "published" });
    expect(courseStatusPresentation("unpublished")).toEqual({ label: "待发布资料", tone: "unpublished" });
    expect(courseStatusPresentation("unavailable")).toEqual({ label: "资料需重新发布", tone: "unavailable" });

    expect(dashboardHeadlineSummary({ courses: 0, publishedCourses: 0, activeDocuments: 0, qaSessions: 0 })).toContain("还没有创建课程");
    expect(dashboardHeadlineSummary({ courses: 3, publishedCourses: 2, activeDocuments: 12, qaSessions: 5 })).toBe("当前共有 3 门课程，其中 2 门已开启课程答疑。");

    expect(dashboardOnboardingSteps).toHaveLength(3);

    expect(
      activityPresentation({
        type: "qa_session_updated",
        courseId: "course-1",
        courseName: "人工智能导论",
        sessionId: "sess-1",
        summary: "第 3 章作业要求",
        at: "2026-11-23T08:00:00.000Z",
      }),
    ).toEqual({
      title: "人工智能导论",
      description: "答疑：第 3 章作业要求",
      href: "/qa?course=course-1",
      actionLabel: "继续答疑",
    });

    expect(
      activityPresentation({
        type: "release_published",
        courseId: "course-1",
        courseName: "人工智能导论",
        releaseId: "rel-1",
        at: "2026-11-23T08:00:00.000Z",
      }),
    ).toEqual({
      title: "人工智能导论",
      description: "更新了生效课程资料",
      href: "/knowledge?course=course-1",
      actionLabel: "查看资料",
    });
  });

  it("keeps DashboardPage free of developer-facing jargon", () => {
    const source = readFileSync(new URL("../web/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("active release");
    expect(source).not.toContain("不可变发布记录");
    expect(source).not.toContain("文档转换器");
    expect(source).not.toContain("activeRelease.id.slice");
  });
});
