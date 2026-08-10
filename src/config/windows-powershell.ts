import path from "node:path";

export function windowsPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("Windows system root is required to launch PowerShell");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
