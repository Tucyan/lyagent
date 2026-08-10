[CmdletBinding()]
param(
  [string]$ReleaseRoot = "",
  [string[]]$PackagePath = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $ReleaseRoot) { $ReleaseRoot = Join-Path $repoRoot "release" }
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$lock = Get-Content -LiteralPath (Join-Path $repoRoot "release-lock.json") -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not ('CourseAgent.ArchiveVerifier' -as [type])) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $compressionAssemblies = @([IO.Compression.ZipArchive].Assembly.Location, [IO.Compression.ZipFile].Assembly.Location)
  Add-Type -ReferencedAssemblies $compressionAssemblies -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace CourseAgent {
  public static class ArchiveVerifier {
    public static void VerifyAndExtract(string archivePath, string destination) {
      var destinationRoot = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      using (var archive = ZipFile.OpenRead(archivePath)) {
        ZipArchiveEntry sumsEntry = null;
        foreach (var entry in archive.Entries) {
          if (String.Equals(Normalize(entry.FullName), "SHA256SUMS.txt", StringComparison.Ordinal)) {
            if (sumsEntry != null) throw new InvalidDataException("Duplicate package SHA256SUMS.txt entry.");
            sumsEntry = entry;
          }
        }
        if (sumsEntry == null) throw new InvalidDataException("Package SHA256SUMS.txt is missing.");

        var expected = ReadExpected(sumsEntry);
        var seenEntries = new HashSet<string>(StringComparer.Ordinal);
        var verified = new HashSet<string>(StringComparer.Ordinal);
        var buffer = new byte[1024 * 1024];

        foreach (var entry in archive.Entries) {
          var relative = Normalize(entry.FullName);
          if (!seenEntries.Add(relative)) throw new InvalidDataException("Duplicate archive entry: " + relative);
          var target = SafeTarget(destinationRoot, relative);
          if (relative.EndsWith("/", StringComparison.Ordinal)) {
            Directory.CreateDirectory(target);
            continue;
          }

          var parent = Path.GetDirectoryName(target);
          if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
          using (var input = entry.Open())
          using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, buffer.Length, FileOptions.SequentialScan))
          using (var sha = SHA256.Create()) {
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
              output.Write(buffer, 0, count);
              sha.TransformBlock(buffer, 0, count, buffer, 0);
            }
            sha.TransformFinalBlock(new byte[0], 0, 0);
            if (!String.Equals(relative, "SHA256SUMS.txt", StringComparison.Ordinal)) {
              string expectedHash;
              if (!expected.TryGetValue(relative, out expectedHash)) throw new InvalidDataException("Package hash list does not cover: " + relative);
              var actualHash = Hex(sha.Hash);
              if (!String.Equals(actualHash, expectedHash, StringComparison.Ordinal)) throw new InvalidDataException("Package hash mismatch: " + relative);
              verified.Add(relative);
            }
          }
        }

        if (verified.Count != expected.Count) throw new InvalidDataException("Package SHA256SUMS.txt contains missing archive entries.");
      }
    }

    private static Dictionary<string, string> ReadExpected(ZipArchiveEntry entry) {
      var expected = new Dictionary<string, string>(StringComparer.Ordinal);
      using (var stream = entry.Open())
      using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), true)) {
        string line;
        while ((line = reader.ReadLine()) != null) {
          var match = Regex.Match(line, "^([a-f0-9]{64})  (.+)$", RegexOptions.CultureInvariant);
          if (!match.Success) throw new InvalidDataException("Malformed package SHA256SUMS.txt line.");
          var relative = Normalize(match.Groups[2].Value);
          if (String.Equals(relative, "SHA256SUMS.txt", StringComparison.Ordinal) || expected.ContainsKey(relative)) {
            throw new InvalidDataException("Duplicate or invalid package hash entry: " + relative);
          }
          expected.Add(relative, match.Groups[1].Value);
        }
      }
      return expected;
    }

    private static string SafeTarget(string destinationRoot, string relative) {
      if (String.IsNullOrWhiteSpace(relative) || relative.StartsWith("/", StringComparison.Ordinal) || relative.IndexOf(':') >= 0) {
        throw new InvalidDataException("Unsafe archive path: " + relative);
      }
      var target = Path.GetFullPath(Path.Combine(destinationRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
      if (!target.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsafe archive path: " + relative);
      return target;
    }

    private static string Normalize(string value) {
      return value.Replace('\\', '/');
    }

    private static string Hex(byte[] bytes) {
      return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }
  }
}
'@
}

function Assert-NoForbiddenContent([string]$Root) {
  $forbiddenSegments = @("workspace", "logs", "secrets", ".git", "tests", "test")
  $forbiddenNames = @("app.json", ".env", ".env.local", "grading.sqlite", "summary.csv")
  foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -Force) {
    $relative = $item.FullName.Substring($Root.Length).TrimStart('\')
    $segments = $relative -split '[\\/]'
    if ($forbiddenSegments -contains $segments[0].ToLowerInvariant()) { throw "Forbidden path in release: $relative" }
    $isDependency = $segments -notcontains "node_modules" -and $segments[0].ToLowerInvariant() -ne "runtime"
    if ($isDependency) {
      if ($forbiddenNames -contains $item.Name.ToLowerInvariant()) { throw "Forbidden file in release: $relative" }
      foreach ($segment in $segments) {
        if ($forbiddenSegments -contains $segment.ToLowerInvariant()) { throw "Forbidden path in release: $relative" }
      }
      if ($item.Name -match '(?i)^(api[-_]?key|secret|student-material)(?:\.[^.]+)?$') { throw "Potentially sensitive file in release: $relative" }
    }
  }

  $applicationFiles = Get-ChildItem -LiteralPath (Join-Path $Root "app\dist") -Recurse -File -Include *.js,*.json,*.html,*.css,*.map
  foreach ($file in $applicationFiles) {
    $content = [IO.File]::ReadAllText($file.FullName)
    if ($content -match '(?i)\bsk-[A-Za-z0-9_-]{24,}\b') { throw "Potential API credential in $($file.Name)." }
  }
}

function Test-BetterSqliteAbi([string]$Root) {
  $node = Join-Path $Root "runtime\node\node.exe"
  $probe = "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('create table ok(value)');db.close();console.log(process.versions.modules)"
  Push-Location -LiteralPath (Join-Path $Root "app")
  try { $output = @(& $node -e $probe 2>&1) } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or -not ($output -match '^\d+$')) { throw "Bundled Node ABI cannot load better-sqlite3." }
  return ($output | Select-Object -Last 1).Trim()
}

function Assert-Package([string]$Root, [string]$ArchiveName) {
  foreach ($required in @(
    "start-course-agent.bat", "release-manifest.json", "release-lock.json", "SHA256SUMS.txt", "THIRD_PARTY_NOTICES.md",
    "runtime\node\node.exe", "runtime\python\python.exe", "runtime\python\Lib\site-packages\docling_serve\__main__.py",
    "runtime\python\Lib\site-packages\docling\cli\tools.py", "runtime\python\Lib\site-packages\docling_parse\pdf_resources\glyphs\standard\additional.dat",
    "app\dist\src\launcher.js", "app\dist\src\main.js", "app\dist\web\index.html",
    "app\node_modules\better-sqlite3\package.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) { throw "Release is missing $required." }
  }

  $manifest = Get-Content -LiteralPath (Join-Path $Root "release-manifest.json") -Raw | ConvertFrom-Json
  if ($manifest.version -ne $package.version -or $manifest.platform -ne "win32" -or $manifest.architecture -ne "x64") { throw "Release manifest target does not match the build." }
  if ($manifest.packageMode -notin @("slim", "full")) { throw "Unknown packageMode in release-manifest.json." }
  if ($ArchiveName -notmatch "-$($manifest.packageMode)\.zip$") { throw "Archive name and packageMode differ." }
  if ($manifest.modelsIncluded -ne ($manifest.packageMode -eq "full")) { throw "modelsIncluded conflicts with packageMode." }
  if ($manifest.node.version -ne $lock.node.version -or $manifest.python.version -ne $lock.python.version -or $manifest.docling.version -ne $lock.docling.version -or $manifest.doclingServe.version -ne $lock.doclingServe.version) {
    throw "Release component versions differ from release-lock.json."
  }

  $models = Join-Path $Root "models\docling"
  if ($manifest.packageMode -eq "slim") {
    if (Test-Path -LiteralPath (Join-Path $models ".course-agent-docling.json")) { throw "Slim release contains a Full model marker." }
    if (Test-Path -LiteralPath $models) { throw "Slim release must not contain a models directory." }
  }
  else {
    $modelMarker = Join-Path $models ".course-agent-docling.json"
    if (-not (Test-Path -LiteralPath $modelMarker -PathType Leaf)) { throw "Full release model marker is missing." }
    $marker = Get-Content -LiteralPath $modelMarker -Raw | ConvertFrom-Json
    if ($marker.schemaVersion -ne 1 -or $marker.provider -ne "docling" -or $marker.doclingServeVersion -ne "1.28.0" -or $marker.mode -ne "full" -or $marker.complete -ne $true) { throw "Full release model marker is invalid." }
    if ((Get-ChildItem -LiteralPath $models -Recurse -File | Where-Object { $_.FullName -ne $modelMarker }).Count -eq 0) { throw "Full release has no model artifacts." }
  }

  Assert-NoForbiddenContent $Root
  $abi = Test-BetterSqliteAbi $Root
  if ([string]$manifest.node.abi -ne [string]$abi) { throw "Manifest Node ABI does not match the bundled runtime." }
  $nodeVersion = (& (Join-Path $Root "runtime\node\node.exe") --version).TrimStart('v').Trim()
  $pythonVersion = (& (Join-Path $Root "runtime\python\python.exe") --version).Replace("Python ", "").Trim()
  if ($nodeVersion -ne $lock.node.version -or $pythonVersion -ne $lock.python.version) { throw "Bundled runtime version check failed." }
  & (Join-Path $Root "runtime\python\python.exe") -c "import importlib.metadata as m; import docling.cli.tools, docling_serve; assert m.version('docling') == '$($lock.docling.version)'; assert m.version('docling-serve') == '$($lock.doclingServe.version)'"
  if ($LASTEXITCODE -ne 0) { throw "Bundled Docling version check failed." }
}

if ($PackagePath.Count -eq 0) {
  $PackagePath = @(Get-ChildItem -LiteralPath $ReleaseRoot -Filter "course-agent-v*-win-x64-*.zip" -File | ForEach-Object FullName)
}
if ($PackagePath.Count -eq 0) { throw "No Windows release archives were found." }

$outerSum = Join-Path $ReleaseRoot "SHA256SUMS.txt"
if (Test-Path -LiteralPath $outerSum) {
  $expectedOuter = @{}
  foreach ($line in Get-Content -LiteralPath $outerSum) {
    if ($line -notmatch '^([a-f0-9]{64})  ([^\\/]+\.zip)$') { throw "Malformed outer SHA256SUMS.txt line." }
    $expectedOuter[$Matches[2]] = $Matches[1]
  }
  foreach ($archive in $PackagePath) {
    $name = Split-Path -Leaf $archive
    if (-not $expectedOuter.ContainsKey($name) -or $expectedOuter[$name] -ne (Get-Sha256 $archive)) { throw "Outer archive hash mismatch: $name" }
  }
}

foreach ($archive in $PackagePath) {
  $archive = [IO.Path]::GetFullPath($archive)
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Release archive does not exist: $archive" }
  $temporary = Join-Path ([IO.Path]::GetTempPath()) "course-agent-verify-$PID-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    [CourseAgent.ArchiveVerifier]::VerifyAndExtract($archive, $temporary)
    Assert-Package $temporary (Split-Path -Leaf $archive)
    Write-Host "Verified $archive"
  }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
}
