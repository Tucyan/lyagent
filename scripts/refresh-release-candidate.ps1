[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseArchive,
  [Parameter(Mandatory = $true)][string]$OutputArchive
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BaseArchive = [IO.Path]::GetFullPath($BaseArchive)
$OutputArchive = [IO.Path]::GetFullPath($OutputArchive)
$winrar = 'C:\Program Files\WinRAR\WinRAR.exe'
if (-not [IO.File]::Exists($winrar)) { throw 'WinRAR is unavailable. Build the candidate manually.' }
if ([IO.File]::Exists($OutputArchive)) { throw 'Output already exists. Choose a new candidate name.' }
if (-not [IO.File]::Exists($BaseArchive)) { throw 'The previously verified base archive is missing.' }
$baseStream = [IO.File]::OpenRead($BaseArchive)
$baseSha = [Security.Cryptography.SHA256]::Create()
try { $baseHash = ([BitConverter]::ToString($baseSha.ComputeHash($baseStream))).Replace('-', '').ToLowerInvariant() }
finally { $baseSha.Dispose(); $baseStream.Dispose() }
if ($baseHash -ne '863f6e7010baf41ea0e5fdf9a5845ae20c7446550a490003be32d46d24429348') { throw 'This refresh method supports only the recorded historical full archive. Use the normal builder for a different base.' }

# Reuse runtime/dependencies only for a trial candidate whose dependency locks have not changed.
# This is packaging, not extraction or per-file integrity verification.
$stage = Join-Path ([IO.Path]::GetTempPath()) ('course-agent-candidate-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory((Join-Path $stage 'app\dist')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'dist\src') -Destination (Join-Path $stage 'app\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot 'dist\web') -Destination (Join-Path $stage 'app\dist') -Recurse
foreach ($name in @('package.json', 'package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $stage 'app')
}
foreach ($name in @('start-course-agent.bat', 'release-lock.json', 'THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination $stage
}
$releaseReadme = "# Course Agent Windows 试用候选`n`n从[逐步图文使用说明](docs/acceptance/2026-10-08-step-by-step-usage.md)开始。先核对ZIP与外部SHA256SUMS.txt，再使用WinRAR解压到新目录，双击start-course-agent.bat并保持窗口运行。`n`n业务数据默认保存在%LOCALAPPDATA%\CourseAgent\workspace，请保留该目录。首次网页中配置自己的模型；本包不含API密钥或示例Workspace。`n`n这是当前工作树的试用候选，复用历史full包运行时和依赖，并更新当前构建；不是全量重建。来源见release-manifest.json。评分需教师复核确认，模型相同正文的分数一致性尚未保证。`n"
[IO.File]::WriteAllText((Join-Path $stage 'README.md'), $releaseReadme, [Text.UTF8Encoding]::new($false))
[IO.Directory]::CreateDirectory((Join-Path $stage 'docs\acceptance')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\acceptance\2026-10-08-step-by-step-usage.md') -Destination (Join-Path $stage 'docs\acceptance')
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\acceptance\2026-10-08-real-interaction-report.md') -Destination (Join-Path $stage 'docs\acceptance')
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\acceptance\2026-10-07-storage-release-baseline.md') -Destination (Join-Path $stage 'docs\acceptance')
[IO.Directory]::CreateDirectory((Join-Path $stage 'docs\acceptance\screenshots')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\acceptance\screenshots\2026-10-08') -Destination (Join-Path $stage 'docs\acceptance\screenshots') -Recurse
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
$lock = [IO.File]::ReadAllText((Join-Path $repoRoot 'release-lock.json')) | ConvertFrom-Json
$manifest = [ordered]@{
  schemaVersion = 1; name = 'course-agent'; version = '0.1.0'; platform = 'win32'; architecture = 'x64'
  packageMode = 'full'; modelsIncluded = $true
  node = @{ version = $lock.node.version; abi = '137'; archiveSha256 = $lock.node.sha256 }
  python = @{ version = $lock.python.version; installerSha256 = $lock.python.sha256 }
  docling = @{ version = $lock.docling.version; wheelSha256 = $lock.docling.sha256 }
  doclingServe = @{ version = $lock.doclingServe.version; wheelSha256 = $lock.doclingServe.sha256 }
  candidate = @{ sourceBaseCommit = $head; includesUncommittedChanges = $true; createdAt = [DateTime]::UtcNow.ToString('o'); baseArchive = [IO.Path]::GetFileName($BaseArchive); baseArchiveSha256 = '863f6e7010baf41ea0e5fdf9a5845ae20c7446550a490003be32d46d24429348'; method = 'Reuse historical runtime and dependencies; replace current compiled app and trial guide. Not a clean rebuild.' }
}
[IO.File]::WriteAllText((Join-Path $stage 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

function Invoke-BoundedWinRAR([string[]]$Arguments, [string]$WorkingDirectory) {
  $process = Start-Process -FilePath $winrar -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $nextProgress = 60
  while (-not $process.WaitForExit(1000)) {
    if ($clock.Elapsed.TotalSeconds -ge 420) {
      $process.Kill()
      throw 'WinRAR exceeded 420 seconds. Candidate is incomplete; hand this operation to the user. Do not retry with another tool.'
    }
    if ($clock.Elapsed.TotalSeconds -ge $nextProgress) {
      Write-Host ('WinRAR packaging is still running: {0:N0} seconds' -f $clock.Elapsed.TotalSeconds)
      $nextProgress += 60
    }
  }
  if ($process.ExitCode -ne 0) { throw "WinRAR failed with exit code $($process.ExitCode). Candidate is incomplete; hand this operation to the user." }
  Write-Host ('WinRAR step complete: {0:N2} seconds, exit code 0' -f $clock.Elapsed.TotalSeconds)
}

[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputArchive)) | Out-Null
[IO.File]::Copy($BaseArchive, $OutputArchive, $false)
Invoke-BoundedWinRAR @('d', '-r', '-y', '-ibck', '-cfg-', ('"' + $OutputArchive + '"'), 'app\dist\*', 'SHA256SUMS.txt') $stage
Invoke-BoundedWinRAR @('a', '-r', '-afzip', '-m1', '-y', '-ibck', '-cfg-', ('"' + $OutputArchive + '"'), 'app', 'docs', 'README.md', 'start-course-agent.bat', 'release-lock.json', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json') $stage
$archiveStream = [IO.File]::OpenRead($OutputArchive)
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash($archiveStream))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose(); $archiveStream.Dispose() }
$checksum = Join-Path ([IO.Path]::GetDirectoryName($OutputArchive)) 'SHA256SUMS.txt'
if ([IO.File]::Exists($checksum)) { throw 'Checksum output already exists; preserve it and write this candidate checksum separately.' }
[IO.File]::WriteAllText($checksum, ($hash + '  ' + [IO.Path]::GetFileName($OutputArchive) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Trial candidate created: $OutputArchive"
Write-Host "SHA-256: $hash"
Write-Host "Staging files retained at: $stage"
