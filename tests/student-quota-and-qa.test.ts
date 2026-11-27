import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MaterialService } from "../src/services/material-service.js";
import { loadStudentServerConfig } from "../src/student/config.js";
import { createStudentServer } from "../src/student/server.js";
import { QuotaExceededError } from "../src/student/services/quota-service.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function seedCourse(workspaceRoot: string, name = "操作系统") {
  const materials = new MaterialService(workspaceRoot);
  const course = await materials.createCourse(name);
  const imported = await materials.createImport(course.id, [
    { relativePath: "ch1.md", content: "# 进程\n进程是资源分配的基本单位。\n" },
  ]);
  const draft = await materials.renderPlan(course.id, imported.id, {
    documents: [{ path: "01-进程.md", title: "进程概念", sectionIds: ["ch1.md#0"] }],
  });
  await materials.publish(course.id, imported.id, draft.version, draft.manifestHash);
  return course;
}

describe("Student QuotaService & QA Server API", () => {
  it("enforces daily/total/rate/concurrent/global limits and refunds on failure", async () => {
    const dir = makeTempDir("lyagent-student-quota-");
    const course = await seedCourse(dir);
    let nowMs = Date.parse("2026-11-25T10:00:00.000Z");

    const server = await createStudentServer({
      config: loadStudentServerConfig({ STUDENT_WORKSPACE_ROOT: dir }),
      now: () => new Date(nowMs),
    });

    try {
      const teacher = await server.auth.createInitialTeacher({
        username: "teacher",
        password: "Password123",
        displayName: "张老师",
      });
      const stu = await server.accounts.createStudent({
        username: "2026001",
        displayName: "李明",
        password: "Password123",
        courseIds: [course.id],
        grantedBy: teacher.user.id,
      });

      server.quotas.updateCoursePolicy(course.id, {
        dailyQaLimit: 2,
        totalQaLimit: 3,
        perMinuteLimit: 2,
        maxConcurrent: 1,
      });

      const l1 = server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" });
      expect(() =>
        server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" }),
      ).toThrow(QuotaExceededError);

      // Refunded reservation does not consume quota
      server.quotas.refundQuota(l1, "agent_error");
      expect(server.quotas.getStudentQuotaSummary(stu.user.id, course.id).dailyRemaining).toBe(2);

      const l2 = server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" });
      server.quotas.completeQuota(l2, { promptTokens: 120, completionTokens: 80, totalTokens: 200 });

      const l3 = server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" });
      server.quotas.completeQuota(l3, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });

      // Within 1 minute -> rate limit
      expect(() =>
        server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" }),
      ).toThrow(/频率/);

      // Advance 61s -> daily limit (2) reached
      nowMs += 61_000;
      expect(() =>
        server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" }),
      ).toThrow(/今日/);

      // Advance 1 day -> daily resets, 1 total remaining
      nowMs += 86_400_000;
      const l4 = server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" });
      server.quotas.completeQuota(l4, { promptTokens: 50, completionTokens: 50, totalTokens: 100 });

      nowMs += 61_000;
      expect(() =>
        server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" }),
      ).toThrow(/累计/);

      // Override raises total limit, but emergency pause blocks all QA
      server.quotas.upsertStudentOverride({
        userId: stu.user.id,
        courseId: course.id,
        dailyQaLimit: 10,
        totalQaLimit: 10,
        note: "课代表加额",
      });
      server.quotas.updateGlobalSettings({ emergencyQaPaused: true });
      expect(() =>
        server.quotas.reserveQuota({ userId: stu.user.id, courseId: course.id, sessionId: "s1" }),
      ).toThrow(/暂停/);
    } finally {
      await server.close();
    }
  });

  it("isolates courses and sessions per student and streams QA answers with quota accounting", async () => {
    const dir = makeTempDir("lyagent-student-api-");
    const c1 = await seedCourse(dir, "计算机网络");
    const c2 = await seedCourse(dir, "数据库系统");

    const server = await createStudentServer({
      config: loadStudentServerConfig({ STUDENT_WORKSPACE_ROOT: dir }),
      courseQaAgentFactory: () => ({
        async answer(_question, onEvent, _signal, onUsage) {
          onEvent?.({ type: "status", phase: "thinking" });
          onEvent?.({ type: "answer_delta", delta: "进程是资源分配的基本单位。" });
          onUsage?.({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
          return {
            answer: "进程是资源分配的基本单位。",
            citations: [{ type: "knowledge", path: "01-进程.md", title: "进程概念", startLine: 1, endLine: 2 }],
            insufficient: false,
          };
        },
      }),
    });

    const teacher = await server.auth.createInitialTeacher({
      username: "admin",
      password: "Password123",
      displayName: "Admin",
    });
    await server.accounts.createStudent({
      username: "s01",
      displayName: "学生一",
      password: "Password123",
      courseIds: [c1.id],
      grantedBy: teacher.user.id,
    });
    await server.accounts.createStudent({
      username: "s02",
      displayName: "学生二",
      password: "Password123",
      courseIds: [c1.id],
      grantedBy: teacher.user.id,
    });

    const login1 = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "s01", password: "Password123" },
    });
    expect(login1.statusCode).toBe(200);
    const cookie1 = login1.headers["set-cookie"] as string;

    const login2 = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "s02", password: "Password123" },
    });
    const cookie2 = login2.headers["set-cookie"] as string;

    // Only authorized course c1 is listed
    const coursesRes = await server.app.inject({
      method: "GET",
      url: "/api/student/courses",
      headers: { cookie: cookie1 },
    });
    expect(coursesRes.statusCode).toBe(200);
    expect(coursesRes.json().courses).toHaveLength(1);
    expect(coursesRes.json().courses[0].id).toBe(c1.id);

    // Unauthorized course c2 is rejected
    const forbiddenTree = await server.app.inject({
      method: "GET",
      url: `/api/student/courses/${c2.id}/tree`,
      headers: { cookie: cookie1 },
    });
    expect(forbiddenTree.statusCode).toBe(403);

    // Create session and ask question
    const createSession = await server.app.inject({
      method: "POST",
      url: `/api/student/courses/${c1.id}/sessions`,
      headers: { cookie: cookie1 },
    });
    expect(createSession.statusCode).toBe(201);
    const sessionId = createSession.json().id as string;

    const askRes = await server.app.inject({
      method: "POST",
      url: `/api/student/courses/${c1.id}/sessions/${sessionId}/ask`,
      headers: { cookie: cookie1 },
      payload: { question: "什么是进程？" },
    });
    expect(askRes.statusCode).toBe(200);
    expect(askRes.body).toContain("event: final");
    expect(askRes.body).toContain("进程是资源分配的基本单位");

    // Student 2 cannot access student 1's session
    const crossSession = await server.app.inject({
      method: "GET",
      url: `/api/student/courses/${c1.id}/sessions/${sessionId}`,
      headers: { cookie: cookie2 },
    });
    expect(crossSession.statusCode).toBe(404);

    // Quota updated for student 1
    const quotaRes = await server.app.inject({
      method: "GET",
      url: `/api/student/courses/${c1.id}/quota`,
      headers: { cookie: cookie1 },
    });
    expect(quotaRes.json().quota.dailyUsed).toBe(1);

    await server.close();
  });
});

it("cancels a running answer and refunds the reserved quota when the HTTP connection closes", async () => {
  const dir = makeTempDir("lyagent-student-disconnect-");
  const course = await seedCourse(dir);
  let reportAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { reportAbort = resolve; });
  let finishModel!: () => void;
  const finish = new Promise<void>((resolve) => { finishModel = resolve; });
  const server = await createStudentServer({
    config: loadStudentServerConfig({ STUDENT_WORKSPACE_ROOT: dir }),
    courseQaAgentFactory: () => ({
      async answer(_question, _onEvent, signal) {
        if (signal?.aborted) reportAbort();
        signal?.addEventListener("abort", reportAbort, { once: true });
        await finish;
        return { answer: "Synthetic answer", citations: [], insufficient: false };
      },
    }),
  });
  const client = new AbortController();
  try {
    const teacher = await server.auth.createInitialTeacher({ username: "admin", password: "Password123", displayName: "Admin" });
    const student = await server.accounts.createStudent({ username: "s01", password: "Password123", displayName: "Sample", courseIds: [course.id], grantedBy: teacher.user.id });
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "s01", password: "Password123" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
    const scope = "/api/student/courses/" + course.id;
    const session = await server.app.inject({ method: "POST", url: scope + "/sessions", headers: { cookie } });
    const detail = scope + "/sessions/" + session.json().id;
    const base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(base + detail + "/ask", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ question: "What is a process?" }),
      signal: client.signal,
    });
    expect(response.status).toBe(200);
    await response.body!.getReader().read();
    client.abort();
    const outcome = await abortWithin(aborted, 900);
    finishModel();
    expect(outcome).toBe("aborted");
    await expect.poll(() => server.quotas.getStudentQuotaSummary(student.user.id, course.id).dailyUsed).toBe(0);
    expect((await server.app.inject({ url: detail, headers: { cookie } })).json().messages).toEqual([]);
  } finally {
    client.abort();
    finishModel();
    await server.close();
  }
});

async function abortWithin(aborted: Promise<void>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      aborted.then(() => "aborted"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still running"), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
