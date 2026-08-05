import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CredentialStore {
  getApiKey(providerId: string): Promise<string | undefined>;
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  deleteApiKey(providerId: string): Promise<void>;
  listProviderIds(): Promise<string[]>;
  readProtected(providerId: string): Promise<Buffer | undefined>;
  restoreProtected(providerId: string, value: Buffer | undefined): Promise<void>;
  protectApiKey(apiKey: string): Promise<Buffer>;
}

export interface SecretProtector {
  protect(plaintext: Buffer): Promise<Buffer>;
  unprotect(ciphertext: Buffer): Promise<Buffer>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly root: string, private readonly protector: SecretProtector) {}

  async getApiKey(providerId: string): Promise<string | undefined> {
    try {
      const protectedValue = await readFile(this.filename(providerId));
      return (await this.protector.unprotect(protectedValue)).toString("utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new Error("API key must not be empty");
    await this.restoreProtected(providerId, await this.protectApiKey(apiKey));
  }

  protectApiKey(apiKey: string): Promise<Buffer> { return this.protector.protect(Buffer.from(apiKey, "utf8")); }

  async readProtected(providerId: string): Promise<Buffer | undefined> {
    try { return await readFile(this.filename(providerId)); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async restoreProtected(providerId: string, value: Buffer | undefined): Promise<void> {
    if (!value) return this.deleteApiKey(providerId);
    await mkdir(this.root, { recursive: true });
    const filename = this.filename(providerId);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await rm(this.filename(providerId), { force: true });
  }

  async listProviderIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.root);
      return entries.filter((entry) => entry.endsWith(".bin")).map((entry) => Buffer.from(entry.slice(0, -4), "base64url").toString("utf8")).sort();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private filename(providerId: string): string {
    const normalized = providerId.trim();
    if (!normalized) throw new Error("Provider id is required");
    return path.join(this.root, `${Buffer.from(normalized, "utf8").toString("base64url")}.bin`);
  }
}

const dpapiScript = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "if($env:COURSE_AGENT_DPAPI_OPERATION -eq 'protect'){$output=[System.Security.Cryptography.ProtectedData]::Protect($inputBytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$output=[System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)}",
  "[Console]::Out.Write([Convert]::ToBase64String($output))",
].join(";");

export class WindowsDpapiProtector implements SecretProtector {
  protect(plaintext: Buffer): Promise<Buffer> { return runDpapi("protect", plaintext); }
  unprotect(ciphertext: Buffer): Promise<Buffer> { return runDpapi("unprotect", ciphertext); }
}

export function defaultSecretRoot(localAppData = process.env.LOCALAPPDATA): string {
  if (!localAppData) throw new Error("LOCALAPPDATA is required for secure credential storage");
  return path.join(localAppData, "CourseAgent", "secrets");
}

function runDpapi(operation: "protect" | "unprotect", input: Buffer): Promise<Buffer> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows DPAPI is only available on Windows"));
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", dpapiScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, COURSE_AGENT_DPAPI_OPERATION: operation },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`DPAPI operation failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 200)}`));
      try { resolve(Buffer.from(Buffer.concat(stdout).toString("ascii"), "base64")); } catch { reject(new Error("DPAPI returned invalid output")); }
    });
    child.stdin.end(input.toString("base64"));
  });
}
