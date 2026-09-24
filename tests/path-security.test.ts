import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeFilesystem, UnsafePathError } from "../src/core/safe-filesystem.js";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "course-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe("SafeFilesystem", () => {
  it("rejects Windows and traversal path forms before reading", async () => {
    const root = await temporaryWorkspace();
    const filesystem = new SafeFilesystem(root);

    for (const candidate of ["../outside.md", "C:\\outside.md", "\\\\server\\share\\file.md", "\\\\?\\C:\\outside.md", "chapter.md:secret"]) {
      await expect(filesystem.readText(candidate)).rejects.toBeInstanceOf(UnsafePathError);
    }
  });

  it("writes only permitted Markdown below a controlled root", async () => {
    const root = await temporaryWorkspace();
    const filesystem = new SafeFilesystem(root);

    await filesystem.writeText("draft/lesson.md", "# Lesson");

    await expect(filesystem.readText("draft/lesson.md")).resolves.toBe("# Lesson");
    await expect(filesystem.writeText("draft/program.exe", "no")).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("refuses an existing symbolic-link path segment", async ({ skip }) => {
    const root = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await mkdir(path.join(root, "draft"));
    await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    try {
      await symlink(outside, path.join(root, "draft", "linked"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); static path rejection cannot be exercised on this host.`);
    }

    const filesystem = new SafeFilesystem(root);
    await expect(filesystem.readText("draft/linked/secret.md")).rejects.toBeInstanceOf(UnsafePathError);
  });
});
