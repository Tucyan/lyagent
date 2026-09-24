import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveApiPort } from "../src/config/api-port.js";

describe("development port configuration", () => {
  it("uses COURSE_AGENT_API_PORT when PORT is unset", () => {
    expect(resolveApiPort({ COURSE_AGENT_API_PORT: "3011" })).toBe(3011);
  });

  it("gives PORT precedence when both API port variables are set", () => {
    expect(resolveApiPort({ PORT: "3022", COURSE_AGENT_API_PORT: "3011" })).toBe(3022);
  });

  it.each([
    ["0", "PORT"],
    ["65536", "PORT"],
    ["3010tail", "PORT"],
    [" 3010", "COURSE_AGENT_API_PORT"],
    ["", "COURSE_AGENT_API_PORT"],
  ])("rejects invalid API port %j from %s", (value, variable) => {
    expect(() => resolveApiPort({ [variable]: value })).toThrow(`Invalid API port in ${variable}`);
  });

  it("uses the existing default when neither API port variable is set", () => {
    expect(resolveApiPort({})).toBe(3010);
  });

  it("accepts the lowest and highest legal decimal port", () => {
    expect(resolveApiPort({ PORT: "1" })).toBe(1);
    expect(resolveApiPort({ PORT: "65535" })).toBe(65535);
  });

  it("uses PORT without parsing the lower-priority API port", () => {
    expect(resolveApiPort({ PORT: "3012", COURSE_AGENT_API_PORT: "invalid" })).toBe(3012);
  });

  it("shares the same resolved API port between the server and Vite proxy", async () => {
    const main = await readFile(path.resolve("src/main.ts"), "utf8");
    const vite = await readFile(path.resolve("web/vite.config.ts"), "utf8");
    expect(main).toContain("resolveApiPort(process.env)");
    expect(vite).toContain("resolveApiPort(process.env)");
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
