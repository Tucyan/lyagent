import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const realpathOverrides = vi.hoisted(() => new Map<string, string>());
const realpathQueues = vi.hoisted(() => new Map<string, string[]>());
const fileOpenControl = vi.hoisted(() => ({
  replaceTarget: undefined as string | undefined,
  closeTarget: undefined as string | undefined,
  closeCount: 0,
}));
const hiddenLinkPaths = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const pathModule = await import("node:path");
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (!hiddenLinkPaths.has(pathModule.resolve(String(args[0])))) return stat;
      return new Proxy(stat, {
        get(current, property) {
          if (property === "isSymbolicLink") return () => false;
          const value = Reflect.get(current, property, current) as unknown;
          return typeof value === "function" ? value.bind(current) : value;
        },
      });
    },
    realpath: async (target: Parameters<typeof actual.realpath>[0], ...args: unknown[]) => {
      const resolved = pathModule.resolve(target.toString());
      const queued = realpathQueues.get(resolved);
      const override = queued?.length ? queued.shift() : realpathOverrides.get(resolved);
      return override ?? actual.realpath(target, ...(args as []));
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const target = pathModule.resolve(String(args[0]));
      if (target === fileOpenControl.closeTarget) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          fileOpenControl.closeCount += 1;
          await close();
        };
      }
      if (target === fileOpenControl.replaceTarget) {
        fileOpenControl.replaceTarget = undefined;
        const displaced = `${target}.displaced`;
        await actual.rename(target, displaced);
        await actual.writeFile(target, "replacement after open", "utf8");
      }
      return handle;
    },
  };
});

const { SafeFilesystem, UnsafePathError } = await import("../src/core/safe-filesystem.js");
const { MaterialService } = await import("../src/services/material-service.js");
const { KnowledgeService } = await import("../src/services/knowledge-service.js");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "course-agent-realpath-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  realpathOverrides.clear();
  realpathQueues.clear();
  hiddenLinkPaths.clear();
  fileOpenControl.replaceTarget = undefined;
  fileOpenControl.closeTarget = undefined;
  fileOpenControl.closeCount = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SafeFilesystem real path and handle checks", () => {
  it("rejects a path whose lstat is ordinary but realpath escapes the root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const redirectedPath = path.join(root, "redirected");
    await mkdir(redirectedPath);
    await writeFile(path.join(redirectedPath, "secret.md"), "inside filesystem", "utf8");
    realpathOverrides.set(path.resolve(redirectedPath), outside);
    const filesystem = new SafeFilesystem(root);

    await expect(filesystem.readText("redirected/secret.md")).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("reads from the opened file object when the path is replaced after open", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "lesson.md");
    await writeFile(target, "original opened object", "utf8");
    fileOpenControl.replaceTarget = path.resolve(target);
    fileOpenControl.closeTarget = path.resolve(target);
    fileOpenControl.closeCount = 0;
    const filesystem = new SafeFilesystem(root);

    await expect(filesystem.readText("lesson.md")).resolves.toBe("original opened object");
    expect(fileOpenControl.replaceTarget).toBeUndefined();
    expect(fileOpenControl.closeCount).toBe(1);
    await expect(readFile(target, "utf8")).resolves.toBe("replacement after open");
  });

  it("rejects a parent that resolves outside after open and closes the handle", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const parent = path.join(root, "documents");
    const target = path.join(parent, "lesson.md");
    await mkdir(parent);
    await writeFile(target, "opened before redirect", "utf8");
    realpathQueues.set(path.resolve(parent), [path.resolve(parent), outside]);
    fileOpenControl.closeTarget = path.resolve(target);
    fileOpenControl.closeCount = 0;
    const filesystem = new SafeFilesystem(root);

    await expect(filesystem.readText("documents/lesson.md")).rejects.toBeInstanceOf(UnsafePathError);
    expect(fileOpenControl.closeCount).toBe(1);
  });

  it("treats missing workspace and parent directories as absent", async () => {
    const parent = await temporaryDirectory();
    const filesystem = new SafeFilesystem(path.join(parent, "not-created"));

    await expect(filesystem.listDirectories("draft")).resolves.toEqual([]);
    await expect(filesystem.directoryExists("draft")).resolves.toBe(false);
    await filesystem.ensureDirectory("draft/nested");
    await expect(filesystem.directoryExists("draft/nested")).resolves.toBe(true);
    await expect(filesystem.directoryExists("draft/missing")).resolves.toBe(false);
    await expect(filesystem.listDirectories("draft/nested")).resolves.toEqual([]);
  });

  it("does not enumerate a redirected directory when lstat hides its junction", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const redirectedPath = path.join(root, "redirected");
    await writeFile(path.join(outside, "external.md"), "outside", "utf8");
    try {
      await symlink(outside, redirectedPath, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); directory enumeration containment cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(redirectedPath));

    await expect(new SafeFilesystem(root).listDirectories("redirected"))
      .rejects.toBeInstanceOf(UnsafePathError);
  });

  it("does not list courses from an external junction hidden from lstat", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const courseId = "00000000-0000-4000-8000-000000000010";
    await mkdir(path.join(outside, courseId), { recursive: true });
    await writeFile(path.join(outside, courseId, "course.json"), JSON.stringify({
      id: courseId, name: "外部课程", createdAt: new Date(0).toISOString(),
    }), "utf8");
    const redirectedPath = path.join(root, "knowledge");
    try {
      await symlink(outside, redirectedPath, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); course listing containment cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(redirectedPath));

    await expect(new MaterialService(root).listCourses()).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("does not list drafts from an external junction hidden from lstat", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const service = new MaterialService(root);
    const course = await service.createCourse("草稿枚举");
    await service.createImport(course.id, [{ relativePath: "source.md", content: "# Lesson\n" }]);
    const redirectedPath = path.join(root, "inbox", "materials");
    await rm(redirectedPath, { recursive: true, force: true });
    try {
      await symlink(outside, redirectedPath, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); draft listing containment cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(redirectedPath));

    await expect(service.listDrafts(course.id)).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("does not list releases from an external junction hidden from lstat", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const service = new MaterialService(root);
    const course = await service.createCourse("发布枚举");
    const redirectedPath = path.join(root, "knowledge", course.id, "releases");
    await mkdir(path.dirname(redirectedPath), { recursive: true });
    await rm(redirectedPath, { recursive: true, force: true });
    try {
      await symlink(outside, redirectedPath, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); release listing containment cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(redirectedPath));

    await expect(service.listReleases(course.id)).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("keeps draft reads inside the MaterialService workspace when lstat hides a staging junction", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const service = new MaterialService(root);
    const course = await service.createCourse("受控读取");
    const imported = await service.createImport(course.id, [{ relativePath: "source.md", content: "# Lesson\n" }]);
    await service.renderPlan(course.id, imported.id, {
      documents: [{ path: "lesson.md", title: "Lesson", sectionIds: ["source.md#0"] }],
    });
    const stagingItem = path.join(root, "knowledge", course.id, "staging", imported.id);
    await rm(stagingItem, { recursive: true, force: true });
    await writeFile(path.join(outside, "lesson.md"), "outside sentinel", "utf8");
    try {
      await symlink(outside, stagingItem, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); staging path rejection cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(stagingItem));

    await expect(service.readDraftContent(course.id, imported.id, "lesson.md")).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("keeps KnowledgeService reads inside its workspace when lstat hides a release junction", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const courseId = "00000000-0000-4000-8000-000000000001";
    const releaseId = "00000000-0000-4000-8000-000000000002";
    const releaseRoot = path.join(root, "knowledge", courseId, "releases", releaseId);
    await mkdir(path.dirname(releaseRoot), { recursive: true });
    await writeFile(path.join(outside, "lesson.md"), "outside sentinel", "utf8");
    try {
      await symlink(outside, releaseRoot, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      skip(`Windows junction fixture is unavailable (${code}); release path rejection cannot be exercised on this host.`);
    }
    hiddenLinkPaths.add(path.resolve(releaseRoot));
    const contentHash = createHash("sha256").update("outside sentinel").digest("hex");
    const snapshotSpy = vi.spyOn(MaterialService.prototype, "getActiveReleaseSnapshot").mockResolvedValue({
      release: {
        id: releaseId,
        courseId,
        importId: "00000000-0000-4000-8000-000000000003",
        manifestHash: "0".repeat(64),
        createdAt: new Date(0).toISOString(),
      },
      tree: [{ path: "lesson.md", title: "Lesson", type: "file", sourceSectionIds: ["source.md#0"] }],
      contentHashes: new Map([["lesson.md", contentHash]]),
    });

    try {
      const knowledge = await new KnowledgeService(root).forCourse(courseId);
      await expect(knowledge.readLines("lesson.md", 1, 1)).rejects.toThrow();
    } finally {
      snapshotSpy.mockRestore();
    }
  });
});
