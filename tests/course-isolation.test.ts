import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";
import { RubricService } from "../src/services/rubric-service.js";
import { GradingSessionService } from "../src/services/grading-session-service.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore Windows SQLite handle release delay.
      }
    }
  }
});

describe("Unified course switching & course isolation", () => {
  it("filters rubric assignments, grading rubrics, sessions, and batches by courseId", async () => {
    const root = makeTempDir("course-agent-isolation-");
    const app = await createServer({ workspaceRoot: root });
    try {
      const c1 = (await (
        await app.inject({ method: "POST", url: "/api/courses", payload: { name: "课程A" } })
      ).json()) as { id: string };
      const c2 = (await (
        await app.inject({ method: "POST", url: "/api/courses", payload: { name: "课程B" } })
      ).json()) as { id: string };

      const a1 = (await (
        await app.inject({
          method: "POST",
          url: "/api/rubrics/assignments",
          payload: { courseId: c1.id, title: "A的作业", totalScore: 100, requirements: "要求A", sources: [] },
        })
      ).json()) as { id: string };
      const a2 = (await (
        await app.inject({
          method: "POST",
          url: "/api/rubrics/assignments",
          payload: { courseId: c2.id, title: "B的作业", totalScore: 100, requirements: "要求B", sources: [] },
        })
      ).json()) as { id: string };

      const listA = (await (
        await app.inject({ method: "GET", url: `/api/rubrics/assignments?courseId=${c1.id}` })
      ).json()) as Array<{ id: string }>;
      expect(listA.map((x) => x.id)).toEqual([a1.id]);

      const listB = (await (
        await app.inject({ method: "GET", url: `/api/rubrics/assignments?courseId=${c2.id}` })
      ).json()) as Array<{ id: string }>;
      expect(listB.map((x) => x.id)).toEqual([a2.id]);

      const rubricsA = (await (
        await app.inject({ method: "GET", url: `/api/grading/rubrics?courseId=${c1.id}` })
      ).json()) as Array<{ assignmentId: string }>;
      expect(rubricsA).toEqual([]);

      const sessionsA = (await (
        await app.inject({ method: "GET", url: `/api/grading/sessions?courseId=${c1.id}` })
      ).json()) as Array<{ assignmentId: string }>;
      expect(sessionsA).toEqual([]);

      const batchesA = (await (
        await app.inject({ method: "GET", url: `/api/grading/batches?courseId=${c1.id}` })
      ).json()) as Array<{ assignmentId: string }>;
      expect(batchesA).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("places unified course switcher in AdminShell sidebar and carries course query across nav links", () => {
    const shell = readFileSync(path.resolve("web/src/components/AdminShell.tsx"), "utf8");
    expect(shell).toContain("切换当前课程");
    expect(shell).toContain("withCourseQuery");
  });

  it("places unified course creation and switching in DashboardPage", () => {
    const dashboard = readFileSync(path.resolve("web/src/pages/DashboardPage.tsx"), "utf8");
    expect(dashboard).toContain("新建课程");
    expect(dashboard).toContain("设为当前课程");
    expect(dashboard).toContain("selectActiveCourse");
  });

  it("removes scattered course creation/switching from KnowledgeLibraryPage and RubricPage and isolates Grading/Batch pages", () => {
    const knowledge = readFileSync(path.resolve("web/src/pages/KnowledgeLibraryPage.tsx"), "utf8");
    const rubric = readFileSync(path.resolve("web/src/pages/RubricPage.tsx"), "utf8");
    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    const batch = readFileSync(path.resolve("web/src/pages/GradingBatchPage.tsx"), "utf8");

    expect(knowledge).not.toContain('className="course-create"');
    expect(rubric).not.toContain('className="rubric-course-create"');
    expect(rubric).toContain("courseId=");
    expect(grading).toContain("courseId=");
    expect(batch).toContain("courseId=");
  });

  it("isolates rubric assignments and grading sessions by courseId at service layer", async () => {
    const root = makeTempDir("course-agent-service-isolation-");
    const rubrics = new RubricService(root);
    const a1 = await rubrics.createAssignment({
      courseId: "course-a",
      title: "A作业",
      totalScore: 100,
      requirements: "要求A",
      sources: [],
    });
    await rubrics.createAssignment({
      courseId: "course-b",
      title: "B作业",
      totalScore: 100,
      requirements: "要求B",
      sources: [],
    });

    const filteredA = await rubrics.listAssignments({ courseId: "course-a" });
    expect(filteredA.map((item) => item.id)).toEqual([a1.id]);

    await rubrics.selectMode(a1.id, "deductive");
    const draft = await rubrics.createDraft(a1.id, {
      schemaVersion: "1.0",
      mode: "deductive",
      totalScore: 100,
      rules: [
        {
          id: "r1",
          name: "规则1",
          condition: "条件1",
          deduction: 10,
          maxDeduction: 10,
          occurrence: "once",
          evidenceRequired: true,
        },
      ],
      overlapGroups: [],
    });
    await rubrics.freeze(a1.id, draft.version, []);

    const filePath = path.join(root, "s1.txt");
    writeFileSync(filePath, "学生报告内容", "utf8");
    const sessions = new GradingSessionService(root, rubrics);
    const s1 = await sessions.createSession({
      assignmentId: a1.id,
      rubricVersion: 1,
      studentName: "张三",
      studentNumber: "1001",
      originalPath: filePath,
      originalFilename: "s1.txt",
      autoStartAfterConversion: false,
    });

    const listA = await sessions.listSessions({ courseId: "course-a" });
    const listB = await sessions.listSessions({ courseId: "course-b" });
    expect(listA.map((s) => s.id)).toEqual([s1.id]);
    expect(listB).toEqual([]);
  });

  it("scopes localStorage keys and cross-course detail/draft resets per course in frontend grading pages", () => {
    const grading = readFileSync(path.resolve("web/src/pages/GradingPage.tsx"), "utf8");
    const batch = readFileSync(path.resolve("web/src/pages/GradingBatchPage.tsx"), "utf8");
    const review = readFileSync(path.resolve("web/src/pages/GradingBatchReviewPage.tsx"), "utf8");
    const exportPage = readFileSync(path.resolve("web/src/pages/GradingExportPage.tsx"), "utf8");

    expect(grading).toContain("gradingRubricStorageKey");
    expect(batch).toContain("batchRubricStorageKey");
    expect(batch).toContain("batchDraftStorageKey");
    expect(review).toContain("withCourseQuery");
    expect(exportPage).toContain("exportRubricStorageKey");
    expect(exportPage).toContain("courseId=");

    const rubric = readFileSync(path.resolve("web/src/pages/RubricPage.tsx"), "utf8");
    expect(rubric).toContain("clearSelectedSession");
    expect(rubric).toContain("nextAssignment.courseId !== activeCourse");
    expect(rubric).toContain("assignmentsGate");
    expect(rubric).toContain("item.courseId === effectiveCourseId");
    expect(rubric).toContain("搜索评分会话");
  });

  it("sends JSON Content-Type when creating a course and carries frozen rubric selection to single and batch grading", () => {
    const dashboard = readFileSync(path.resolve("web/src/pages/DashboardPage.tsx"), "utf8");
    expect(dashboard).not.toContain("...withJsonHeaders()");
    expect(dashboard).toMatch(/withJsonHeaders\(\{\s*method:\s*"POST"/);
    expect(dashboard).toContain("正在加载课程数据");

    const rubric = readFileSync(path.resolve("web/src/pages/RubricPage.tsx"), "utf8");
    expect(rubric).toContain('rubric=${encodeURIComponent(');

    const batch = readFileSync(path.resolve("web/src/pages/GradingBatchPage.tsx"), "utf8");
    expect(batch).toContain("!item.courseId || item.courseId === nextCourseId");
    expect(batch).toMatch(/new URLSearchParams\(window\.location\.search\)[\s\S]*?params\.get\("rubric"\)/);
  });
});
