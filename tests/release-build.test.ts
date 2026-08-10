import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Windows release inputs", () => {
  it("pins every bundled runtime with a complete SHA-256 lock", async () => {
    const lock = JSON.parse(await text("release-lock.json")) as {
      platform: string;
      architecture: string;
      node: { version: string; url: string; sha256: string };
      python: { version: string; url: string; sha256: string; size: number };
      docling: { version: string; wheelUrl: string; sha256: string };
      doclingServe: { version: string; wheelUrl: string; sha256: string };
    };

    expect(lock).toMatchObject({
      platform: "win32",
      architecture: "x64",
      node: { version: "24.11.1", sha256: "5355ae6d7c49eddcfde7d34ac3486820600a831bf81dc3bdca5c8db6a9bb0e76" },
      python: { version: "3.12.10", sha256: "67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb", size: 26_964_224 },
      docling: { version: "2.118.0", sha256: "fd4962c9a54229bae1eb9b49f7fadb7e7b8affabf7e4fba1aac8cb335f558c8f" },
      doclingServe: { version: "1.28.0", sha256: "189595e0689bb2ca59dbdc24dc6c8bfabbe891652735c83dcbb8bce3140619b8" },
    });
    for (const item of [lock.node, lock.python, lock.docling, lock.doclingServe]) {
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(new URL("url" in item ? item.url : item.wheelUrl).protocol).toBe("https:");
    }
  });

  it("locks the complete Python dependency graph without local paths", async () => {
    const requirements = await text("requirements-release-win-x64.txt");
    const lines = requirements.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    expect(lines).toContain("docling==2.118.0");
    expect(lines).toContain("docling-serve==1.28.0");
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.every((line) => /^[A-Za-z0-9_.-]+==[^\s]+$/.test(line))).toBe(true);
    expect(requirements).not.toMatch(/(?:file:|@\s|[A-Z]:\\|\\\\)/i);
  });
});

describe("Windows release builder", () => {
  it("supports reproducible slim/full/all builds with atomic verified downloads", async () => {
    const script = await text("scripts/build-release.ps1");
    expect(script).toContain("[ValidateSet(\"slim\", \"full\", \"all\")]");
    expect(script).toContain("[string]$CacheRoot");
    expect(script).toContain("[string]$OutputRoot");
    expect(script).toContain(".part");
    expect(script).toContain("Get-FileHash");
    expect(script).not.toContain("$Size.Value");
    expect(script).toContain("Move-Item");
    expect(script).toContain('$inner = @(Get-ChildItem -LiteralPath $temporary -Directory)');
    expect(script).toContain('$artifacts = @(Get-ChildItem -LiteralPath $models -Recurse -File)');
    expect(script).toContain("Find-RegisteredPython");
    expect(script).toContain(String.raw`Lib\site-packages`);
    expect(script).toContain(String.raw`docling_parse\pdf_resources\glyphs\standard\additional.dat`);
    expect(script).toContain("Test-PythonRuntimeComplete");
    expect(script).toContain('"-m", "ensurepip", "--upgrade"');
    expect(script).toContain('Invoke-External $python @("-m", "pip", "check") $repoRoot | Out-Null');
    expect(script).toContain("npm ci --omit=dev");
    expect(script).toContain('"--ignore-scripts"');
    expect(script).toContain('node_modules\\prebuild-install\\bin.js');
    expect(script).toContain("Invoke-External $bundledNode @($prebuildInstall");
    expect(script).toContain('Join-Path $PythonRuntime "python.exe"');
    expect(script).toContain('HF_HUB_DISABLE_XET');
    expect(script).toMatch(/@\("-m",\s*"docling\.cli\.tools",\s*"models",\s*"download",\s*"--output-dir"/);
    expect(script).toMatch(/docling\.cli\.tools[\s\S]*\| Out-Host/);
    expect(script).toContain("Initialize-DoclingModelCache");
    expect(script).toContain("Copy-Directory $modelCache $models");
  });

  it("stages only runtime inputs and emits manifests, package hashes, and mode metadata", async () => {
    const script = await text("scripts/build-release.ps1");
    expect(script).toContain("release-manifest.json");
    expect(script).toContain("SHA256SUMS.txt");
    expect(script).toContain("THIRD_PARTY_NOTICES.md");
    expect(script).toContain('packageMode = $PackageMode');
    expect(script).toContain('modelsIncluded = ($PackageMode -eq "full")');
    expect(script).toContain("New-DeterministicZip");
    expect(script).toContain("LastWriteTime = $fixedTimestamp");
    expect(script).toContain("Assert-PackageIsClean");
    expect(script).toMatch(/\$segments -notcontains "node_modules"/);
    expect(script).toContain('if ($segments[0] -eq "app" -and $segments -notcontains "node_modules" -and $forbiddenSegments');
    expect(script).toMatch(/workspace|logs|api.?key|secrets/i);
  });

  it("checks the bundled Node ABI against better-sqlite3 with the bundled executable", async () => {
    const build = await text("scripts/build-release.ps1");
    const verify = await text("scripts/verify-release.ps1");
    for (const script of [build, verify]) {
      expect(script).toContain("better-sqlite3");
      expect(script).toContain("process.versions.modules");
      expect(script).toContain("node.exe");
    }
    expect(build).toContain('Push-Location (Join-Path $PackageRoot "app")');
  });

  it("verifies package content without reading or writing secret values", async () => {
    const script = await text("scripts/verify-release.ps1");
    expect(script).toContain("release-manifest.json");
    expect(script).toContain("SHA256SUMS.txt");
    expect(script).toContain("packageMode");
    expect(script).toContain("modelsIncluded");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("VerifyAndExtract");
    expect(script).toContain("ZipArchive");
    expect(script).not.toContain("Expand-Archive");
    expect(script).toContain("Assert-NoForbiddenContent");
    expect(script).toContain(String.raw`runtime\python\Lib\site-packages\docling_parse\pdf_resources\glyphs\standard\additional.dat`);
    expect(script).toMatch(/\$segments -notcontains "node_modules"/);
    expect(script).toMatch(/\^\(api\[-_\]\?key\|secret\|student-material\)/);
    expect(script).not.toMatch(/Get-Content\s+.*(?:secret|api.?key)/i);
  });
});

describe("release launcher", () => {
  it("quotes the package-relative runtime paths and validates both runtimes", async () => {
    const bat = await text("start-course-agent.bat");
    expect(bat).toContain('"%~dp0runtime\\node\\node.exe"');
    expect(bat).toContain('"%~dp0runtime\\python\\python.exe"');
    expect(bat).toContain('"%~dp0runtime\\python\\Lib\\site-packages\\docling_serve"');
    expect(bat).toContain('"%~dp0app\\dist\\src\\launcher.js"');
    expect(bat).not.toMatch(/\bcd\b/i);
  });

  it("exposes the release command through npm", async () => {
    const pkg = JSON.parse(await text("package.json")) as { scripts: Record<string, string> };
    const command = pkg.scripts["release:win"];
    expect(command).toBe("powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-release.ps1");
    if (!command) throw new Error("release:win script is missing");
    expect(createHash("sha256").update(command).digest("hex")).toHaveLength(64);
  });
});
