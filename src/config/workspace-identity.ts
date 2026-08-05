import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceIdentity { canonicalRoot: string; hash: string }

export async function resolveWorkspaceIdentity(workspaceRoot: string): Promise<WorkspaceIdentity> {
  const resolved = path.resolve(workspaceRoot);
  await mkdir(resolved, { recursive: true });
  const canonicalRoot = await realpath(resolved);
  const normalized = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return { canonicalRoot, hash: createHash("sha256").update(normalized, "utf8").digest("hex") };
}
