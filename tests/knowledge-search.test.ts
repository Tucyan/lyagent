import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeAccessError, KnowledgeService } from "../src/services/knowledge-service.js";
import { MaterialService } from "../src/services/material-service.js";

const roots: string[] = [];

async function publishedCourse() {
  const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-knowledge-"));
  roots.push(root);
  const materials = new MaterialService(root);
  const course = await materials.createCourse("操作系统");
  const imported = await materials.createImport(course.id, [{
    relativePath: "source.md",
    content: "# 进程\n进程是程序的一次执行。\n\n## 调度\n调度决定下一个运行的进程。\n",
  }]);
  const draft = await materials.renderPlan(course.id, imported.id, {
    documents: [{ path: "第一章/进程.md", title: "进程与调度", sectionIds: ["source.md#0", "source.md#1"] }],
  });
  const release = await materials.publish(course.id, imported.id, draft.version, draft.manifestHash);
  return { course, release, knowledge: new KnowledgeService(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KnowledgeService", () => {
  it("only exposes documents from the course active release", async () => {
    const { course, knowledge } = await publishedCourse();
    const other = new MaterialService(roots[0]!);
    const otherCourse = await other.createCourse("其他课程");
    const service = await knowledge.forCourse(course.id);

    await expect(knowledge.forCourse(otherCourse.id)).rejects.toBeInstanceOf(KnowledgeAccessError);
    await expect(service.listDirectory("")).resolves.toEqual([{ path: "第一章/进程.md", title: "进程与调度", type: "file" }]);
    expect(await service.search("进程")).toContainEqual(expect.objectContaining({ path: "第一章/进程.md", startLine: 1 }));
  });

  it("returns bounded logical search results and line ranges", async () => {
    const { course, knowledge } = await publishedCourse();
    const service = await knowledge.forCourse(course.id);

    const results = await service.search("调度", 0, 10);
    expect(results).toContainEqual(expect.objectContaining({ path: "第一章/进程.md", title: "进程与调度", startLine: 6, endLine: 6, excerpt: "调度决定下一个运行的进程。" }));
    await expect(service.readLines("第一章/进程.md", 5, 99)).resolves.toEqual({
      path: "第一章/进程.md", startLine: 5, endLine: 7, content: "## 调度\n调度决定下一个运行的进程。\n\n",
    });
    await expect(service.readLines("../staging/secret.md", 1, 1)).rejects.toBeInstanceOf(KnowledgeAccessError);
  });
});
