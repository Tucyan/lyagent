import { KnowledgeService } from "./knowledge-service.js";
import { MaterialService, type Course, type KnowledgeRelease } from "./material-service.js";
import type { RubricService } from "./rubric-service.js";
import { SessionService, type CourseQaSessionSummary } from "./session-service.js";

export type DashboardKnowledgeStatus = "published" | "unpublished" | "unavailable";

export interface CourseGradingSummary {
  sessionCount: number;
  confirmedCount: number;
  pendingReviewCount: number;
  batchCount: number;
}

export interface DashboardServiceDependencies {
  rubrics?: RubricService;
  summarizeGradingByCourse?: () => Record<string, CourseGradingSummary>;
}

export interface DashboardSnapshot {
  generatedAt: string;
  model: { provider: string; model: string; configured: boolean };
  totals: { courses: number; publishedCourses: number; activeDocuments: number; qaSessions: number };
  courses: DashboardCourse[];
  recentActivity: DashboardActivity[];
}

export interface DashboardCourse {
  id: string;
  name: string;
  createdAt: string;
  knowledgeStatus: DashboardKnowledgeStatus;
  activeRelease: { id: string; createdAt: string } | null;
  releaseCount: number;
  documentCount: number;
  qaSessionCount: number;
  rubricCount: number;
  frozenRubricCount: number;
  gradingSessionCount: number;
  confirmedGradingCount: number;
  pendingReviewCount: number;
  batchCount: number;
  lastActivityAt: string;
}

export type DashboardActivity =
  | { type: "course_created"; courseId: string; courseName: string; at: string }
  | { type: "release_published"; courseId: string; courseName: string; releaseId: string; at: string }
  | { type: "qa_session_updated"; courseId: string; courseName: string; sessionId: string; summary: string; at: string };

export class DashboardService {
  private readonly materials: MaterialService;
  private readonly knowledge: KnowledgeService;
  private readonly sessions: SessionService;

  constructor(
    workspaceRoot: string,
    private readonly model: DashboardSnapshot["model"],
    private readonly dependencies: DashboardServiceDependencies = {},
  ) {
    this.materials = new MaterialService(workspaceRoot);
    this.knowledge = new KnowledgeService(workspaceRoot);
    this.sessions = new SessionService(workspaceRoot);
  }

  async snapshot(): Promise<DashboardSnapshot> {
    const courses = await this.materials.listCourses();
    const gradingByCourse = this.dependencies.summarizeGradingByCourse?.() ?? {};
    const details = await Promise.all(
      courses.map((course) => this.courseSummary(course, gradingByCourse[course.id])),
    );
    const dashboardCourses = details.map((detail) => detail.course);
    const recentActivity = details
      .flatMap((detail) => detail.activity)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 8);

    return {
      generatedAt: new Date().toISOString(),
      model: this.model,
      totals: {
        courses: dashboardCourses.length,
        publishedCourses: dashboardCourses.filter((course) => course.knowledgeStatus === "published").length,
        activeDocuments: dashboardCourses.reduce((total, course) => total + course.documentCount, 0),
        qaSessions: dashboardCourses.reduce((total, course) => total + course.qaSessionCount, 0),
      },
      courses: dashboardCourses,
      recentActivity,
    };
  }

  private async courseSummary(
    course: Course,
    gradingSummary?: CourseGradingSummary,
  ): Promise<{ course: DashboardCourse; activity: DashboardActivity[] }> {
    let releases: KnowledgeRelease[] = [];
    let sessions: CourseQaSessionSummary[] = [];
    let activeRelease: KnowledgeRelease | undefined;
    let knowledgeStatus: DashboardKnowledgeStatus = "unpublished";
    let documentCount = 0;
    let rubricCount = 0;
    let frozenRubricCount = 0;

    try {
      releases = await this.materials.listReleases(course.id);
      activeRelease = await this.materials.getActiveRelease(course.id);
      if (activeRelease) {
        try {
          documentCount = (await this.knowledge.forCourse(course.id)).documents.length;
          knowledgeStatus = "published";
        } catch {
          knowledgeStatus = "unavailable";
        }
      }
    } catch {
      knowledgeStatus = "unavailable";
      activeRelease = undefined;
      releases = [];
    }

    try {
      sessions = await this.sessions.list(course.id);
    } catch {
      sessions = [];
    }

    if (this.dependencies.rubrics) {
      try {
        const assignments = await this.dependencies.rubrics.listAssignments({ courseId: course.id });
        rubricCount = assignments.length;
        const versionLists = await Promise.all(
          assignments.map((assignment) => this.dependencies.rubrics!.listVersions(assignment.id).catch(() => [])),
        );
        frozenRubricCount = versionLists.filter((versions) => versions.length > 0).length;
      } catch {
        rubricCount = 0;
        frozenRubricCount = 0;
      }
    }

    const activity: DashboardActivity[] = [
      { type: "course_created", courseId: course.id, courseName: course.name, at: course.createdAt },
      ...releases.map((release) => ({ type: "release_published" as const, courseId: course.id, courseName: course.name, releaseId: release.id, at: release.createdAt })),
      ...sessions.map((session) => ({ type: "qa_session_updated" as const, courseId: course.id, courseName: course.name, sessionId: session.id, summary: session.summary, at: session.updatedAt })),
    ];
    const lastActivityAt = activity.reduce((latest, item) => item.at > latest ? item.at : latest, course.createdAt);

    return {
      course: {
        id: course.id,
        name: course.name,
        createdAt: course.createdAt,
        knowledgeStatus,
        activeRelease: activeRelease ? { id: activeRelease.id, createdAt: activeRelease.createdAt } : null,
        releaseCount: releases.length,
        documentCount,
        qaSessionCount: sessions.length,
        rubricCount,
        frozenRubricCount,
        gradingSessionCount: gradingSummary?.sessionCount ?? 0,
        confirmedGradingCount: gradingSummary?.confirmedCount ?? 0,
        pendingReviewCount: gradingSummary?.pendingReviewCount ?? 0,
        batchCount: gradingSummary?.batchCount ?? 0,
        lastActivityAt,
      },
      activity,
    };
  }
}
