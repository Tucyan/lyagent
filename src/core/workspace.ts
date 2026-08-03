import { mkdir } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(relativePath: string) {
    super(`Path is outside the workspace: ${relativePath}`);
    this.name = "WorkspacePathError";
  }
}

export class Workspace {
  public readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(relativePath = "."): string {
    if (path.isAbsolute(relativePath)) {
      throw new WorkspacePathError(relativePath);
    }

    const resolved = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspacePathError(relativePath);
    }
    return resolved;
  }

  async ensure(relativePath = "."): Promise<string> {
    const resolved = this.resolve(relativePath);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }
}
