import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MineruBackend, RuntimeDescriptor } from "./supervisor.js";

export interface LaunchSpec { command: string; args: string[]; env?: NodeJS.ProcessEnv }

export function defaultWorkspaceRoot(environment: NodeJS.ProcessEnv): string {
  const local = environment.LOCALAPPDATA;
  if (!local) throw new Error("无法确定本地应用数据目录（LOCALAPPDATA）。");
  return path.resolve(local, "CourseAgent", "workspace");
}

export function mineruLaunchSpec(releaseRoot: string, port: number): LaunchSpec {
  return { command: path.join(releaseRoot, "runtime", "python", "Scripts", "mineru-api.exe"), args: ["--host", "127.0.0.1", "--port", String(port)] };
}

export function appLaunchSpec(releaseRoot: string, input: { workspaceRoot: string; appPort: number; mineruPort: number; backend: MineruBackend; ownerToken?: string }): LaunchSpec {
  return {
    command: path.join(releaseRoot, "runtime", "node", "node.exe"), args: [path.join(releaseRoot, "app", "dist", "src", "main.js")],
    env: { PORT: String(input.appPort), COURSE_AGENT_WORKSPACE: input.workspaceRoot, COURSE_AGENT_MINERU_PORT: String(input.mineruPort), COURSE_AGENT_MINERU_BACKEND: input.backend, COURSE_AGENT_SUPERVISED: "1", ...(input.ownerToken ? { COURSE_AGENT_RUNTIME_OWNER: input.ownerToken } : {}) },
  };
}

export async function writeRuntimeDescriptor(filename: string, descriptor: RuntimeDescriptor): Promise<void> {
  const directory = path.dirname(filename); const temporary = path.join(directory, `.runtime-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, filename);
}
