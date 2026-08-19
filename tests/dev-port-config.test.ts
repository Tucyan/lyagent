import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("development port configuration", () => {
  it("allows the Vite API proxy to follow COURSE_AGENT_API_PORT", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../web/vite.config.ts", import.meta.url), "utf8"));
    expect(source).toContain("COURSE_AGENT_API_PORT");
    expect(source).toContain("127.0.0.1:${apiPort}");
  });

  it("rewrites proxied API writes to the backend's trusted origin", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../web/vite.config.ts", import.meta.url), "utf8"));
    expect(source).toContain('setHeader("origin", apiOrigin)');
  });

  it("runs the development API under a restart supervisor", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { scripts: { dev: string } };
    expect(packageJson.scripts.dev).toContain("--restart-tries -1");
    expect(packageJson.scripts.dev).toContain("tsx src/dev.ts");
    expect(packageJson.scripts.dev).not.toContain("tsx watch src/dev.ts");

    const source = await readFile(path.resolve("src", "dev.ts"), "utf8");
    expect(source).toContain('process.env.COURSE_AGENT_SUPERVISED = "1"');
    expect(source).toContain("COURSE_AGENT_RUNTIME_OWNER");
    expect(source).toContain('await import("./main.js")');
  });
});
