import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerWebAssets } from "../src/api/web-assets.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("web assets", () => {
  it("serves the built index at the root without duplicating Fastify routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "course-agent-web-"));
    directories.push(root);
    await writeFile(path.join(root, "index.html"), "<h1>课程资料库</h1>", "utf8");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "app.js"), "document.body.dataset.ready = 'true';", "utf8");
    const app = Fastify();

    await registerWebAssets(app, root);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("课程资料库");
    const qaResponse = await app.inject({ method: "GET", url: "/qa" });
    expect(qaResponse.statusCode).toBe(200);
    const knowledgeResponse = await app.inject({ method: "GET", url: "/knowledge" });
    expect(knowledgeResponse.statusCode).toBe(200);
    const rubricsResponse = await app.inject({ method: "GET", url: "/rubrics" });
    expect(rubricsResponse.statusCode).toBe(200);
    const gradingResponse = await app.inject({ method: "GET", url: "/grading" });
    expect(gradingResponse.statusCode).toBe(200);
    expect(qaResponse.body).toContain("课程资料库");
    const assetResponse = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.body).toContain("dataset.ready");
    await app.close();
  });
});
