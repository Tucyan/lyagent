import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const defaultExtensions = new Set([".md", ".markdown", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export class UnsafePathError extends Error {
  constructor(public readonly unsafePath: string, reason: string) {
    super(`Unsafe path ${JSON.stringify(unsafePath)}: ${reason}`);
    this.name = "UnsafePathError";
  }
}

export interface SafeFilesystemOptions {
  allowedExtensions?: ReadonlySet<string>;
}

/**
 * The only filesystem adapter used by M1 services. Paths are always relative
 * to this root and every existing component is checked before it is used.
 */
export class SafeFilesystem {
  public readonly root: string;
  private readonly allowedExtensions: ReadonlySet<string>;

  constructor(root: string, options: SafeFilesystemOptions = {}) {
    this.root = path.resolve(root);
    this.allowedExtensions = options.allowedExtensions ?? defaultExtensions;
  }

  async readText(relativePath: string): Promise<string> {
    const resolved = await this.resolveExisting(relativePath);
    return readFile(resolved, "utf8");
  }

  async readBytes(relativePath: string): Promise<Buffer> {
    const resolved = await this.resolveExisting(relativePath);
    return readFile(resolved);
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const resolved = await this.resolveForWrite(relativePath);
    await this.atomicWrite(resolved, content);
  }

  async writeBytes(relativePath: string, content: Uint8Array): Promise<void> {
    const resolved = await this.resolveForWrite(relativePath);
    await this.atomicWrite(resolved, content);
  }

  async removeFile(relativePath: string): Promise<void> {
    const resolved = await this.resolveExisting(relativePath);
    await rm(resolved);
  }

  async removeDirectory(relativePath: string): Promise<void> {
    const resolved = this.parseRelativePath(relativePath, { allowDirectory: true });
    await this.assertSafeExistingPath(resolved, relativePath);
    const stat = await lstat(resolved);
    if (!stat.isDirectory()) throw new UnsafePathError(relativePath, "target is not a directory");
    await rm(resolved, { recursive: true, force: false });
  }

  async copyInto(sourceAbsolutePath: string, targetRelativePath: string): Promise<void> {
    const target = await this.resolveForWrite(targetRelativePath);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await copyFile(sourceAbsolutePath, temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async ensureDirectory(relativePath = "."): Promise<string> {
    if (relativePath === ".") {
      await mkdir(this.root, { recursive: true });
      await this.assertNotLink(this.root, relativePath);
      return this.root;
    }
    const resolved = this.parseRelativePath(relativePath, { allowDirectory: true });
    const relative = path.relative(this.root, resolved);
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = this.root;
    await mkdir(current, { recursive: true });
    await this.assertNotLink(current, relativePath);
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await this.tryLstat(current);
      if (stat) {
        if (stat.isSymbolicLink()) throw new UnsafePathError(relativePath, "contains a reparse point");
        if (!stat.isDirectory()) throw new UnsafePathError(relativePath, "directory component is a file");
      } else {
        await mkdir(current);
        await this.assertNotLink(current, relativePath);
      }
    }
    return resolved;
  }

  async listFiles(relativePath: string): Promise<string[]> {
    const resolved = this.parseRelativePath(relativePath, { allowDirectory: true });
    try {
      await this.assertSafeExistingPath(resolved, relativePath);
      const stat = await lstat(resolved);
      if (!stat.isDirectory()) throw new UnsafePathError(relativePath, "target is not a directory");
      return (await readdir(resolved, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private parseRelativePath(relativePath: string, options: { allowDirectory: boolean }): string {
    if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
      throw new UnsafePathError(String(relativePath), "path is empty or invalid");
    }
    if (
      path.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath)
      || path.posix.isAbsolute(relativePath)
      || relativePath.startsWith("\\\\")
      || relativePath.startsWith("//")
    ) {
      throw new UnsafePathError(relativePath, "absolute, UNC, or device paths are not allowed");
    }

    const separatorsNormalized = relativePath.replaceAll("\\", "/");
    const segments = separatorsNormalized.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))) {
      throw new UnsafePathError(relativePath, "traversal, empty components, and alternate streams are not allowed");
    }
    if (!options.allowDirectory) {
      const extension = path.extname(relativePath).toLowerCase();
      if (!this.allowedExtensions.has(extension)) {
        throw new UnsafePathError(relativePath, `extension ${extension || "(none)"} is not allowed`);
      }
    }

    const resolved = path.resolve(this.root, ...segments);
    const relation = path.relative(this.root, resolved);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw new UnsafePathError(relativePath, "path escapes the controlled root");
    }
    return resolved;
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    const resolved = this.parseRelativePath(relativePath, { allowDirectory: false });
    await this.assertSafeExistingPath(resolved, relativePath);
    const stat = await lstat(resolved);
    if (!stat.isFile()) throw new UnsafePathError(relativePath, "target is not a file");
    return resolved;
  }

  private async resolveForWrite(relativePath: string): Promise<string> {
    const resolved = this.parseRelativePath(relativePath, { allowDirectory: false });
    const parent = path.dirname(resolved);
    const parentRelative = path.relative(this.root, parent);
    await this.ensureDirectory(parentRelative === "" ? "." : parentRelative);
    await this.assertSafeExistingPath(parent, relativePath);
    const target = await this.tryLstat(resolved);
    if (target?.isSymbolicLink()) throw new UnsafePathError(relativePath, "target is a reparse point");
    if (target && !target.isFile()) throw new UnsafePathError(relativePath, "target is not a regular file");
    return resolved;
  }

  private async assertSafeExistingPath(resolved: string, requestedPath: string): Promise<void> {
    const relative = path.relative(this.root, resolved);
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = this.root;
    await this.assertNotLink(current, requestedPath);
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await this.tryLstat(current);
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new UnsafePathError(requestedPath, "contains a reparse point");
    }
  }

  private async assertNotLink(target: string, requestedPath: string): Promise<void> {
    const stat = await this.tryLstat(target);
    if (stat?.isSymbolicLink()) throw new UnsafePathError(requestedPath, "controlled root is a reparse point");
  }

  private async tryLstat(target: string) {
    try {
      return await lstat(target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async atomicWrite(target: string, content: string | Uint8Array): Promise<void> {
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
