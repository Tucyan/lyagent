import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "http://127.0.0.1:3017";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_DIR = path.resolve("docs/acceptance/screenshots/2026-10-07");

function takeScreenshot(url: string, filename: string, width = 1280, height = 900) {
  const target = path.join(SCREENSHOT_DIR, filename);
  console.log(`Capturing ${filename} from ${url}...`);
  const result = spawnSync(CHROME_PATH, [
    "--headless",
    `--window-size=${width},${height}`,
    `--screenshot=${target}`,
    url,
  ], { timeout: 15000 });
  if (result.error) {
    throw result.error;
  }
  console.log(`Saved ${filename}`);
}

async function main() {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  // 1. 获取课程与已有 assignment
  const courses = await fetch(`${BASE_URL}/api/courses`).then(r => r.json()) as Array<{ id: string; name: string }>;
  const publishedCourse = courses.find(c => c.name.includes("试用示例")) ?? courses[0]!;
  const unreleasedCourse = courses.find(c => c.name.includes("尚未发布")) ?? courses[1]!;
  console.log("Published Course:", publishedCourse.id, publishedCourse.name);
  console.log("Unreleased Course:", unreleasedCourse.id, unreleasedCourse.name);

  const assignments = await fetch(`${BASE_URL}/api/rubrics/assignments`).then(r => r.json()) as Array<{ id: string; title: string; courseId: string }>;
  const frozenAssignment = assignments.find(a => a.title.includes("试用报告评分表")) ?? assignments[0]!;
  console.log("Frozen Assignment:", frozenAssignment.id);

  // 2. 准备评分表校验错误的 assignment
  let invalidAssignment = assignments.find(a => a.title === "待完善评分表草稿");
  if (!invalidAssignment) {
    invalidAssignment = await fetch(`${BASE_URL}/api/rubrics/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        courseId: publishedCourse.id,
        title: "待完善评分表草稿",
        totalScore: 100,
        requirements: "核对完整性",
        sources: [],
      }),
    }).then(r => r.json());

    await fetch(`${BASE_URL}/api/rubrics/assignments/${invalidAssignment.id}/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "additive" }),
    });

    await fetch(`${BASE_URL}/api/rubrics/assignments/${invalidAssignment.id}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        rubric: {
          schemaVersion: "1.0",
          mode: "additive",
          totalScore: 100,
          partialCreditAllowed: true,
          criteria: [{
            id: "C1",
            name: "结构与论证",
            description: "结构完整性",
            maxScore: 10, // 与 100 分不一致
            scorePolicy: "range",
            evidenceRequired: true,
            levels: [{ id: "L1", minScore: 0, maxScore: 10, condition: "满足" }],
          }],
        },
      }),
    });
  }

  // 3. 准备单份批改会话并运行
  async function createSession(number: string, name: string) {
    const formData = new FormData();
    const fileBlob = new Blob([`# 合成研究报告\n\n学生：${name}\n\n## 问题\n探讨教学交互。\n\n## 方法\n对比两种模式。\n\n## 结果\n结构清晰。\n\n## 反思\n需量化。`], { type: "text/markdown" });
    formData.set("file", fileBlob, `${number}_${name}_研究报告.md`);
    formData.set("courseId", publishedCourse.id);
    formData.set("assignmentId", frozenAssignment.id);
    formData.set("rubricVersion", "1");
    formData.set("studentName", name);
    formData.set("studentNumber", number);

    const sessionRes = await fetch(`${BASE_URL}/api/grading/sessions`, {
      method: "POST",
      body: formData,
    });
    return sessionRes.json() as Promise<{ id: string }>;
  }

  const existingSessions = await fetch(`${BASE_URL}/api/grading/sessions`).then(r => r.json()) as Array<{ id: string }>;
  let session1 = existingSessions[0];
  if (!session1) {
    session1 = await createSession("20261001", "示例学生甲");
  }

  // 为 session1 运行批改
  await fetch(`${BASE_URL}/api/grading/sessions/${session1.id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "grade" }),
  });
  await new Promise(r => setTimeout(r, 1000));

  // 4. 创建批次专用的全新 sessions
  const batchSession1 = await createSession("20261003", "学生丙");
  const batchSession2 = await createSession("20261004", "学生丁");

  // 创建正式批次并启动
  let batches = await fetch(`${BASE_URL}/api/grading/batches`).then(r => r.json()) as Array<{ id: string; title: string }>;
  let batchId = batches[0]?.id;
  if (!batchId) {
    const createBatchRes = await fetch(`${BASE_URL}/api/grading/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "2026秋季学期第一批研究报告",
        assignmentId: frozenAssignment.id,
        rubricVersion: 1,
        concurrency: 2,
        sessionIds: [batchSession1.id, batchSession2.id],
      }),
    });
    if (!createBatchRes.ok) {
      throw new Error("Failed to create batch: " + await createBatchRes.text());
    }
    const newBatch = await createBatchRes.json() as { id: string };
    batchId = newBatch.id;

    // 启动批改
    await fetch(`${BASE_URL}/api/grading/batches/${batchId}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // 等待批改作业生成草稿
    await new Promise(r => setTimeout(r, 2000));
  }

  // 获取 batch 详情
  const batchDetail = await fetch(`${BASE_URL}/api/grading/batches/${batchId}`).then(r => r.json()) as {
    id: string;
    jobs: Array<{ id: string; sessionId: string; status: string; resultVersion?: number }>;
  };
  console.log("Batch ID:", batchId, "Jobs:", batchDetail.jobs.length);

  // 确认其中一个作业
  const readyJob = batchDetail.jobs.find(j => j.resultVersion !== undefined) ?? batchDetail.jobs[0];
  if (readyJob && readyJob.resultVersion !== undefined) {
    await fetch(`${BASE_URL}/api/grading/batches/${batchId}/jobs/${readyJob.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: readyJob.resultVersion,
        reviewNote: "教师已全面复核评分与依据，确认符合标准。",
        acknowledgedReasons: [],
      }),
    });
  }

  console.log("Ready to take screenshots...");

  // 截图清单
  takeScreenshot(`${BASE_URL}/`, "01-dashboard.png");
  takeScreenshot(`${BASE_URL}/qa?course=${encodeURIComponent(unreleasedCourse.id)}`, "02-qa-unreleased.png");
  takeScreenshot(`${BASE_URL}/qa?course=${encodeURIComponent(publishedCourse.id)}`, "03-qa-active.png");
  takeScreenshot(`${BASE_URL}/knowledge?course=${encodeURIComponent(publishedCourse.id)}`, "04-knowledge-library.png");
  takeScreenshot(`${BASE_URL}/rubrics?assignment=${encodeURIComponent(frozenAssignment.id)}`, "05-rubric-designer.png");
  takeScreenshot(`${BASE_URL}/rubrics?assignment=${encodeURIComponent(frozenAssignment.id)}&mockError=1`, "06-rubric-validation-error.png");
  takeScreenshot(`${BASE_URL}/grading?session=${encodeURIComponent(session1.id)}`, "07-grading-workbench.png");
  takeScreenshot(`${BASE_URL}/grading/batches`, "08-grading-batch-upload.png");
  takeScreenshot(`${BASE_URL}/grading/batches/review?batch=${encodeURIComponent(batchId)}&session=${encodeURIComponent(batchSession1.id)}`, "09-grading-batch-review.png");
  takeScreenshot(`${BASE_URL}/grading/batches`, "10-batch-confirmed-and-export.png");

  console.log("All screenshots captured successfully!");
}

main().catch(err => {
  console.error("Failed to capture screenshots:", err);
  process.exit(1);
});
