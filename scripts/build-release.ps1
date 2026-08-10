[CmdletBinding()]
param(
  [ValidateSet("slim", "full", "all")]
  [string]$Mode = "all",
  [string]$CacheRoot = "",
  [string]$OutputRoot = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $CacheRoot) { $CacheRoot = Join-Path $env:LOCALAPPDATA "CourseAgent\release-cache" }
if (-not $OutputRoot) { $OutputRoot = Join-Path $repoRoot "release" }
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$workRoot = Join-Path $CacheRoot "work"
$lock = Get-Content -LiteralPath (Join-Path $repoRoot "release-lock.json") -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$requirementsFile = Join-Path $repoRoot "requirements-release-win-x64.txt"
$fixedTimestamp = [DateTimeOffset]::Parse("2000-01-01T00:00:00Z")

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
  throw "Windows x64 releases must be built on Windows x64."
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ExpectedFile([string]$Path, [string]$Sha256, [Nullable[long]]$Size) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if ($null -ne $Size -and (Get-Item -LiteralPath $Path).Length -ne [long]$Size) { return $false }
  return (Get-Sha256 $Path) -eq $Sha256.ToLowerInvariant()
}

function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$Sha256, [Nullable[long]]$Size = $null) {
  if (Assert-ExpectedFile $Destination $Sha256 $Size) { return $Destination }
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $directory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $part = "$Destination.part-$PID-$([Guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part
    if (-not (Assert-ExpectedFile $part $Sha256 $Size)) {
      throw "Downloaded file failed length or SHA-256 verification: $Url"
    }
    Move-Item -LiteralPath $part -Destination $Destination
  }
  finally {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  }
  if (-not (Assert-ExpectedFile $Destination $Sha256 $Size)) { throw "Cached download verification failed: $Destination" }
  return $Destination
}

function Invoke-External([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = $repoRoot) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $Command" }
  }
  finally { Pop-Location }
}

function Copy-Directory([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $null = & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -gt 7) { throw "Failed to copy $Source to $Destination (robocopy $LASTEXITCODE)." }
}

function Test-PythonVersion([string]$Python) {
  if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { return $false }
  $output = @(& $Python -c "import platform; print(platform.python_version())" 2>$null)
  return $LASTEXITCODE -eq 0 -and $output.Count -gt 0 -and $output[-1].Trim() -eq [string]$lock.python.version
}

function Test-PythonRuntimeComplete([string]$Runtime) {
  $python = Join-Path $Runtime "python.exe"
  $pdfResource = Join-Path $Runtime "Lib\site-packages\docling_parse\pdf_resources\glyphs\standard\additional.dat"
  return (Test-PythonVersion $python) -and (Test-Path -LiteralPath $pdfResource -PathType Leaf)
}

function Find-RegisteredPython {
  $minor = ([string]$lock.python.version).Split('.')[0..1] -join '.'
  $keys = @(
    "Registry::HKEY_CURRENT_USER\Software\Python\PythonCore\$minor\InstallPath",
    "Registry::HKEY_LOCAL_MACHINE\Software\Python\PythonCore\$minor\InstallPath",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Python\PythonCore\$minor\InstallPath"
  )
  foreach ($key in $keys) {
    try {
      $properties = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
      $executableProperty = $properties.PSObject.Properties["ExecutablePath"]
      $defaultProperty = $properties.PSObject.Properties["(default)"]
      $candidates = @()
      if ($null -ne $executableProperty) { $candidates += [string]$executableProperty.Value }
      if ($null -ne $defaultProperty) { $candidates += Join-Path ([string]$defaultProperty.Value) "python.exe" }
      foreach ($candidate in $candidates) {
        if (Test-PythonVersion $candidate) { return Split-Path -Parent $candidate }
      }
    }
    catch { continue }
  }
  return $null
}

function Initialize-NodeRuntime {
  $archive = Join-Path $CacheRoot "downloads\node-v$($lock.node.version)-win-x64.zip"
  Get-VerifiedDownload $lock.node.url $archive $lock.node.sha256 | Out-Null
  $runtime = Join-Path $CacheRoot "runtime\node-$($lock.node.version)-win-x64"
  $node = Join-Path $runtime "node.exe"
  if (Test-Path -LiteralPath $node) { return $runtime }
  $temporary = "$runtime.part-$PID-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $archive -DestinationPath $temporary
    $inner = @(Get-ChildItem -LiteralPath $temporary -Directory)
    if ($inner.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $inner[0].FullName "node.exe"))) {
      throw "Unexpected Node archive layout."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $runtime) -Force | Out-Null
    Move-Item -LiteralPath $inner[0].FullName -Destination $runtime
  }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
  return $runtime
}

function Initialize-PythonRuntime {
  $installer = Join-Path $CacheRoot "downloads\python-$($lock.python.version)-amd64.exe"
  Get-VerifiedDownload $lock.python.url $installer $lock.python.sha256 ([long]$lock.python.size) | Out-Null
  $doclingWheel = Join-Path $CacheRoot "downloads\docling-$($lock.docling.version)-py3-none-any.whl"
  $serveWheel = Join-Path $CacheRoot "downloads\docling_serve-$($lock.doclingServe.version)-py3-none-any.whl"
  Get-VerifiedDownload $lock.docling.wheelUrl $doclingWheel $lock.docling.sha256 | Out-Null
  Get-VerifiedDownload $lock.doclingServe.wheelUrl $serveWheel $lock.doclingServe.sha256 | Out-Null

  $runtimeName = "python-$($lock.python.version)-docling-$($lock.docling.version)-serve-$($lock.doclingServe.version)"
  $runtime = Join-Path $CacheRoot "runtime\$runtimeName"
  $marker = Join-Path $runtime ".course-agent-runtime.json"
  if (Test-Path -LiteralPath $marker) {
    try {
      $saved = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ($saved.python -eq $lock.python.version -and $saved.docling -eq $lock.docling.version -and $saved.doclingServe -eq $lock.doclingServe.version -and (Test-PythonRuntimeComplete $runtime)) {
        return $runtime
      }
    }
    catch { }
  }

  $temporary = "$runtime.part-$PID-$([Guid]::NewGuid().ToString('N'))"
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    $expected = Get-Content -LiteralPath $requirementsFile | Where-Object { $_ -and -not $_.StartsWith("#") } | Sort-Object
    $arguments = "/quiet InstallAllUsers=0 Include_pip=1 Include_test=0 Include_launcher=0 PrependPath=0 Shortcuts=0 TargetDir=`"$temporary`""
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Python installer failed with exit code $($process.ExitCode)." }
    $python = Join-Path $temporary "python.exe"
    if (-not (Test-PythonVersion $python)) {
      # The official installer enters maintenance mode when the same patch
      # version is already registered and then ignores a new TargetDir.
      $registered = Find-RegisteredPython
      if (-not $registered) { throw "Python runtime was not installed and no exact registered runtime was found." }
      Copy-Directory $registered $temporary
      $python = Join-Path $temporary "python.exe"
      if (-not (Test-PythonVersion $python)) { throw "Registered Python runtime did not match the release lock." }
    }
    $sitePackages = Join-Path $temporary "Lib\site-packages"
    $scripts = Join-Path $temporary "Scripts"
    if (Test-Path -LiteralPath $sitePackages) { Remove-Item -LiteralPath $sitePackages -Recurse -Force }
    if (Test-Path -LiteralPath $scripts) { Remove-Item -LiteralPath $scripts -Recurse -Force }
    New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    Invoke-External $python @("-m", "ensurepip", "--upgrade") $repoRoot | Out-Null
    Invoke-External $python @("-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--requirement", $requirementsFile, $doclingWheel, $serveWheel) $repoRoot | Out-Null
    Invoke-External $python @("-m", "pip", "check") $repoRoot | Out-Null
    $actual = @(& $python -m pip freeze --disable-pip-version-check) | Sort-Object
    if ($LASTEXITCODE -ne 0 -or (Compare-Object $expected $actual)) { throw "Installed Python dependency graph differs from the release lock." }
    if (-not (Test-PythonRuntimeComplete $temporary)) { throw "Installed Python runtime is missing required Docling PDF resources." }
    $runtimeMarker = [ordered]@{ schemaVersion = 1; python = [string]$lock.python.version; docling = [string]$lock.docling.version; doclingServe = [string]$lock.doclingServe.version }
    [IO.File]::WriteAllText((Join-Path $temporary ".course-agent-runtime.json"), ($runtimeMarker | ConvertTo-Json) + "`n", (New-Object Text.UTF8Encoding($false)))
    New-Item -ItemType Directory -Path (Split-Path -Parent $runtime) -Force | Out-Null
    if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
    Move-Item -LiteralPath $temporary -Destination $runtime
  }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
  return $runtime
}

function Test-DoclingModelCache([string]$ModelRoot) {
  $marker = Join-Path $ModelRoot ".course-agent-docling.json"
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  try {
    $saved = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($saved.schemaVersion -ne 1 -or $saved.provider -ne "docling" -or $saved.doclingServeVersion -ne [string]$lock.doclingServe.version -or $saved.mode -ne "full" -or $saved.complete -ne $true) { return $false }
    return @(Get-ChildItem -LiteralPath $ModelRoot -Recurse -File | Where-Object { $_.FullName -ne $marker }).Count -gt 0
  }
  catch { return $false }
}

function Initialize-DoclingModelCache([string]$PythonRuntime) {
  $modelCache = Join-Path $CacheRoot "models\docling-$($lock.docling.version)-serve-$($lock.doclingServe.version)"
  if (Test-DoclingModelCache $modelCache) { return $modelCache }
  $temporary = "$modelCache.part-$PID-$([Guid]::NewGuid().ToString('N'))"
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  $savedUtf8 = $env:PYTHONUTF8
  $savedDisableXet = $env:HF_HUB_DISABLE_XET
  try {
    $env:PYTHONUTF8 = "1"
    $env:HF_HUB_DISABLE_XET = "1"
    Invoke-External (Join-Path $PythonRuntime "python.exe") @("-m", "docling.cli.tools", "models", "download", "--output-dir", $temporary) $repoRoot | Out-Host
    if (@(Get-ChildItem -LiteralPath $temporary -Recurse -File).Count -eq 0) { throw "Docling model download produced no artifacts." }
    $modelMarker = [ordered]@{ schemaVersion = 1; provider = "docling"; doclingServeVersion = [string]$lock.doclingServe.version; mode = "full"; complete = $true }
    Write-Utf8 (Join-Path $temporary ".course-agent-docling.json") (($modelMarker | ConvertTo-Json) + "`n")
    New-Item -ItemType Directory -Path (Split-Path -Parent $modelCache) -Force | Out-Null
    if (Test-Path -LiteralPath $modelCache) { Remove-Item -LiteralPath $modelCache -Recurse -Force }
    Move-Item -LiteralPath $temporary -Destination $modelCache
  }
  finally {
    $env:PYTHONUTF8 = $savedUtf8
    $env:HF_HUB_DISABLE_XET = $savedDisableXet
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
  return $modelCache
}

function Assert-PackageIsClean([string]$PackageRoot) {
  $forbiddenSegments = @("workspace", "logs", "secrets", ".git", "tests", "test", "devDependencies")
  $forbiddenNames = @("app.json", ".env", ".env.local", "grading.sqlite", "summary.csv")
  foreach ($item in Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force) {
    $relative = $item.FullName.Substring($PackageRoot.Length).TrimStart('\')
    $segments = $relative -split '[\\/]'
    if ($forbiddenNames -contains $item.Name.ToLowerInvariant()) { throw "Forbidden release file: $relative" }
    foreach ($segment in $segments) {
      if ($segments[0] -eq "app" -and $segments -notcontains "node_modules" -and $forbiddenSegments -contains $segment.ToLowerInvariant()) { throw "Forbidden release path: $relative" }
    }
    if ($segments[0] -eq "app" -and $segments -notcontains "node_modules" -and $item.Name -match '(?i)^(api[-_]?key|secret|student-material)(?:\.[^.]+)?$') { throw "Potentially sensitive release file: $relative" }
  }
  # npm ci --omit=dev is the authoritative dependency boundary. Some
  # production packages legitimately depend on @types/*, so a name-based
  # scan would reject valid transitive runtime dependencies.
}

function Test-BetterSqliteAbi([string]$PackageRoot) {
  $node = Join-Path $PackageRoot "runtime\node\node.exe"
  $script = "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('create table ok(value)');db.close();console.log(process.versions.modules)"
  Push-Location (Join-Path $PackageRoot "app")
  try { $output = @(& $node -e $script 2>&1) } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or -not ($output -match '^\d+$')) { throw "Bundled Node ABI cannot load better-sqlite3." }
  return ($output | Select-Object -Last 1).Trim()
}

function Write-Utf8([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-PackageHashes([string]$PackageRoot) {
  $hashFile = Join-Path $PackageRoot "SHA256SUMS.txt"
  $lines = Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Where-Object { $_.FullName -ne $hashFile } | ForEach-Object {
    $relative = $_.FullName.Substring($PackageRoot.Length + 1).Replace('\', '/')
    "$(Get-Sha256 $_.FullName)  $relative"
  } | Sort-Object
  Write-Utf8 $hashFile (($lines -join "`n") + "`n")
}

function New-DeterministicZip([string]$Source, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
  try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File | Sort-Object FullName) {
        $relative = $file.FullName.Substring($Source.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $fixedTimestamp
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    }
    finally { $archive.Dispose() }
  }
  finally { $stream.Dispose() }
  # Compress-Archive is intentionally avoided because it does not normalize timestamps.
}

function Build-Package([string]$PackageMode, [string]$NodeRuntime, [string]$PythonRuntime) {
  $packageName = "course-agent-v$version-win-x64-$PackageMode"
  $stage = Join-Path $workRoot $packageName
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage "app\dist") -Force | Out-Null
  Copy-Directory (Join-Path $repoRoot "dist\src") (Join-Path $stage "app\dist\src")
  Copy-Directory (Join-Path $repoRoot "dist\web") (Join-Path $stage "app\dist\web")
  Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination (Join-Path $stage "app\package.json")
  Copy-Item -LiteralPath (Join-Path $repoRoot "package-lock.json") -Destination (Join-Path $stage "app\package-lock.json")
  Copy-Item -LiteralPath (Join-Path $repoRoot "start-course-agent.bat") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "THIRD_PARTY_NOTICES.md") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot "release-lock.json") -Destination $stage
  Copy-Item -LiteralPath $requirementsFile -Destination $stage
  Copy-Directory $NodeRuntime (Join-Path $stage "runtime\node")
  Copy-Directory $PythonRuntime (Join-Path $stage "runtime\python")

  $savedPath = $env:PATH
  try {
    $env:PATH = (Join-Path $stage "runtime\node") + ";" + $env:PATH
    $appRoot = Join-Path $stage "app"
    $bundledNode = Join-Path $stage "runtime\node\node.exe"
    # npm adds every ancestor node_modules/.bin to lifecycle PATH. Disable
    # lifecycle scripts so an unrelated user-level Node cannot compile the
    # native module for the wrong ABI, then install it with the bundled Node.
    Invoke-External (Join-Path $stage "runtime\node\npm.cmd") @("ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund") $appRoot
    $prebuildInstall = Join-Path $appRoot "node_modules\prebuild-install\bin.js"
    $betterSqliteRoot = Join-Path $appRoot "node_modules\better-sqlite3"
    Invoke-External $bundledNode @($prebuildInstall, "--force") $betterSqliteRoot
  }
  finally { $env:PATH = $savedPath }

  if ($PackageMode -eq "full") {
    $modelCache = Initialize-DoclingModelCache $PythonRuntime
    $models = Join-Path $stage "models\docling"
    Copy-Directory $modelCache $models
    $artifacts = @(Get-ChildItem -LiteralPath $models -Recurse -File)
    if ($artifacts.Count -eq 0) { throw "Docling model download produced no artifacts." }
  }
  elseif (Test-Path -LiteralPath (Join-Path $stage "models")) {
    throw "Slim release must not contain Docling models."
  }

  $abi = Test-BetterSqliteAbi $stage
  Assert-PackageIsClean $stage
  $manifest = [ordered]@{
    schemaVersion = 1
    name = "course-agent"
    version = $version
    platform = "win32"
    architecture = "x64"
    packageMode = $PackageMode
    modelsIncluded = ($PackageMode -eq "full")
    node = [ordered]@{ version = [string]$lock.node.version; abi = $abi; archiveSha256 = [string]$lock.node.sha256 }
    python = [ordered]@{ version = [string]$lock.python.version; installerSha256 = [string]$lock.python.sha256 }
    docling = [ordered]@{ version = [string]$lock.docling.version; wheelSha256 = [string]$lock.docling.sha256 }
    doclingServe = [ordered]@{ version = [string]$lock.doclingServe.version; wheelSha256 = [string]$lock.doclingServe.sha256 }
  }
  Write-Utf8 (Join-Path $stage "release-manifest.json") (($manifest | ConvertTo-Json -Depth 5) + "`n")
  Write-PackageHashes $stage
  New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
  $zip = Join-Path $OutputRoot "$packageName.zip"
  New-DeterministicZip $stage $zip
  return $zip
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

Invoke-External "npm.cmd" @("ci", "--no-audit", "--no-fund") $repoRoot
Invoke-External "npm.cmd" @("run", "build") $repoRoot
$nodeRuntime = Initialize-NodeRuntime
$pythonRuntime = Initialize-PythonRuntime
$modes = if ($Mode -eq "all") { @("slim", "full") } else { @($Mode) }
foreach ($packageMode in $modes) { Build-Package $packageMode $nodeRuntime $pythonRuntime | Write-Host }

$outerHashes = Get-ChildItem -LiteralPath $OutputRoot -Filter "course-agent-v*-win-x64-*.zip" -File | Sort-Object Name | ForEach-Object { "$(Get-Sha256 $_.FullName)  $($_.Name)" }
Write-Utf8 (Join-Path $OutputRoot "SHA256SUMS.txt") (($outerHashes -join "`n") + "`n")
Write-Host "Windows release build completed: $OutputRoot"
