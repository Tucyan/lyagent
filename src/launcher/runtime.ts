import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DoclingDevice, RuntimeDescriptor } from "./supervisor.js";

export const DOCLING_SERVE_VERSION = "1.28.0";

export interface LaunchSpec { command: string; args: string[]; env?: NodeJS.ProcessEnv }

export function defaultWorkspaceRoot(environment: NodeJS.ProcessEnv): string {
  const local = environment.LOCALAPPDATA;
  if (!local) throw new Error("无法确定本地应用数据目录（LOCALAPPDATA）。");
  return path.resolve(local, "CourseAgent", "workspace");
}

export function doclingLaunchSpec(releaseRoot: string, input: { port: number; device: DoclingDevice; artifactsPath: string }): LaunchSpec {
  return {
    command: path.join(releaseRoot, "runtime", "python", "Scripts", "docling-serve.exe"),
    args: ["run"],
    env: {
      UVICORN_HOST: "127.0.0.1",
      UVICORN_PORT: String(input.port),
      UVICORN_WORKERS: "1",
      DOCLING_SERVE_ARTIFACTS_PATH: input.artifactsPath,
      DOCLING_DEVICE: input.device,
    },
  };
}

export function appLaunchSpec(releaseRoot: string, input: { workspaceRoot: string; appPort: number; converterPort: number; device: DoclingDevice; ownerToken?: string }): LaunchSpec {
  return {
    command: path.join(releaseRoot, "runtime", "node", "node.exe"),
    args: [path.join(releaseRoot, "app", "dist", "src", "main.js")],
    env: {
      PORT: String(input.appPort),
      COURSE_AGENT_WORKSPACE: input.workspaceRoot,
      COURSE_AGENT_CONVERTER_PORT: String(input.converterPort),
      COURSE_AGENT_DOCLING_DEVICE: input.device,
      COURSE_AGENT_DOCLING_VERSION: DOCLING_SERVE_VERSION,
      COURSE_AGENT_SUPERVISED: "1",
      ...(input.ownerToken ? { COURSE_AGENT_RUNTIME_OWNER: input.ownerToken } : {}),
    },
  };
}

export async function writeRuntimeDescriptor(filename: string, descriptor: RuntimeDescriptor): Promise<void> {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.runtime-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, filename);
}
