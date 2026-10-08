[CmdletBinding()]
param(
  [string]$ReleaseRoot = "",
  [string[]]$PackagePath = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
if (-not $ReleaseRoot) { $ReleaseRoot = Join-Path $PSScriptRoot "..\release" }
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)

# Verify only the supplied archive against the external checksum; never extract it.
function Get-ArchiveSha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

$checksumPath = Join-Path $ReleaseRoot "SHA256SUMS.txt"
if (-not [IO.File]::Exists($checksumPath)) { throw "External SHA256SUMS.txt is required. Obtain it from the release publisher before verification." }
$expected = @{}
foreach ($line in [IO.File]::ReadAllLines($checksumPath)) {
  if (-not $line.Trim()) { continue }
  if ($line -notmatch '^([a-fA-F0-9]{64})  ([^\\/]+\.zip)$') { throw "Malformed external SHA256SUMS.txt line." }
  $name = $Matches[2]
  if ($expected.ContainsKey($name)) { throw "Duplicate archive checksum: $name" }
  $expected[$name] = $Matches[1].ToLowerInvariant()
}
if ($PackagePath.Count -eq 0) {
  $PackagePath = @([IO.Directory]::GetFiles($ReleaseRoot, 'course-agent-v*-win-x64-*.zip', [IO.SearchOption]::TopDirectoryOnly))
}
if ($PackagePath.Count -eq 0) { throw "No Windows release archives were found." }
foreach ($archive in $PackagePath) {
  $archive = [IO.Path]::GetFullPath($archive)
  $name = [IO.Path]::GetFileName($archive)
  if (-not [IO.File]::Exists($archive)) { throw "Release archive does not exist: $name" }
  if (-not $expected.ContainsKey($name)) { throw "External checksum is missing for $name" }
  if ($expected[$name] -ne (Get-ArchiveSha256 $archive)) { throw "Archive SHA-256 mismatch: $name. Download the archive and its matching checksum again; do not overwrite the expected value." }
  Write-Host "Archive SHA-256 verified: $name"
}
Write-Host "Archive verification complete. Extract separately with WinRAR, then validate actual startup and use."