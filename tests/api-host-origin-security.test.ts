import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("API Host and Origin boundary", () => {
  it("serves local course content but blocks DNS-rebinding Host and foreign Origin reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-host-security-"));
    roots.push(root);
    const app = await createServer({
      workspaceRoot: root,
      modelStatus: { provider: "deepseek", model: "test", configured: true },
      modelApiSecurity: { csrfToken: "test-token", allowedOrigin: "http://127.0.0.1:3010", isLoopback: (request) => request.ip === "127.0.0.1" || request.ip === "::1" },
      materialPlanner: async (sections) => ({ documents: [{ path: "notes.md", title: "Notes", sectionIds: sections.map(({ id }) => id) }] }),
    });
    const course = (await app.inject({ method: "POST", url: "/api/courses", payload: { name: "受保护课程" } })).json() as { id: string };
    const imported = (await app.inject({
      method: "POST", url: `/api/courses/${course.id}/imports`,
      payload: { files: [{ relativePath: "source.md", content: "STUDENT_AND_COURSE_SECRET" }] },
    })).json() as { id: string; draftVersion: number; manifestHash: string };
    const release = (await app.inject({
      method: "POST", url: `/api/courses/${course.id}/imports/${imported.id}/publish`,
      payload: { expectedVersion: imported.draftVersion, expectedManifestHash: imported.manifestHash },
    })).json() as { id: string };
    const assignment = (await app.inject({ method: "POST", url: "/api/rubrics/assignments", payload: {
      courseId: course.id, title: "受保护评分表", totalScore: 10, requirements: "报告要求", sources: [],
    } })).json() as { id: string };
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/mode`, payload: { mode: "additive" } });
    const rubric = {
      schemaVersion: "1.0", mode: "additive", totalScore: 10, partialCreditAllowed: true,
      criteria: [{ id: "quality", name: "质量", maxScore: 10, description: "报告质量", scorePolicy: "continuous", evidenceRequired: true }],
    };
    await app.inject({ method: "PUT", url: `/api/rubrics/assignments/${assignment.id}/draft`, payload: { expectedVersion: 0, rubric } });
    await app.inject({ method: "POST", url: `/api/rubrics/assignments/${assignment.id}/freeze`, payload: { expectedVersion: 1, acknowledgedWarningCodes: [] } });
    const upload = (await app.inject({ method: "POST", url: "/api/grading/batch-uploads", payload: {
      title: "受保护学生作业", assignmentId: assignment.id, rubricVersion: 1, concurrency: 1,
      items: [{ filename: "20260001_张晓明_校园AI报告.md" }],
    } })).json() as { id: string };
    try {
      const local = await app.inject({
        method: "GET", url: `/api/courses/${course.id}/releases/${release.id}/content?path=notes.md`,
        headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:3010" },
      });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.body).toContain("STUDENT_AND_COURSE_SECRET");

      const rebindingCourseRead = await app.inject({
        method: "GET", url: `/api/courses/${course.id}/releases/${release.id}/content?path=notes.md`,
        headers: { host: "attacker.example", origin: "http://attacker.example" },
      });
      expect(rebindingCourseRead.statusCode).toBe(403);
      expect(rebindingCourseRead.body).not.toContain("STUDENT_AND_COURSE_SECRET");

      const rebindingStudentRead = await app.inject({
        method: "GET", url: `/api/grading/batch-uploads/${upload.id}`,
        headers: { host: "attacker.example", origin: "http://attacker.example" },
      });
      expect(rebindingStudentRead.statusCode).toBe(403);
      expect(rebindingStudentRead.body).not.toContain("张晓明");
      const localStudentRead = await app.inject({
        method: "GET", url: `/api/grading/batch-uploads/${upload.id}`,
        headers: { host: "localhost:3010" },
      });
      expect(localStudentRead.statusCode, localStudentRead.body).toBe(200);
      expect(localStudentRead.body).toContain("张晓明");

      const foreignOrigin = await app.inject({
        method: "GET", url: "/api/courses",
        headers: { host: "127.0.0.1:3010", origin: "https://attacker.example" },
      });
      expect(foreignOrigin.statusCode).toBe(403);
      const untrustedLoopbackPort = await app.inject({
        method: "GET", url: "/api/courses",
        headers: { host: "127.0.0.1:3010", origin: "http://localhost:5173" },
      });
      expect(untrustedLoopbackPort.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
