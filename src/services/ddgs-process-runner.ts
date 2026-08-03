import { spawn } from "node:child_process";
import path from "node:path";
import type { DdgsRunner, DdgsSearchRequest } from "./ddgs-search-service.js";

export type DdgsProcessExecutor = (command: string, args: string[], input: string, timeoutMs: number) => Promise<string>;

export function createDdgsRunner(execute: DdgsProcessExecutor = runProcess, pythonCommand = "python"): DdgsRunner {
  const script = path.resolve("scripts", "ddgs_search.py");
  return async (request: DdgsSearchRequest): Promise<unknown> => {
    const output = await execute(pythonCommand, [script], JSON.stringify(request), 30_000);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("DDGS helper returned invalid JSON");
    }
  };
}

function runProcess(command: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DDGS search timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`DDGS helper failed${stderr ? `: ${stderr.slice(0, 200)}` : ""}`));
    });
    child.stdin.end(input);
  });
}
