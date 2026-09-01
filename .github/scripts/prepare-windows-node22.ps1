$ErrorActionPreference = "Stop"

if (-not $env:GITHUB_ENV -or -not $env:GITHUB_PATH) {
  throw "GITHUB_ENV and GITHUB_PATH are required to pin the workflow Node.js executable."
}

# actions/setup-node prepends its selected toolcache directory to PATH. Resolve it once, verify the
# contract, and persist the absolute executables so later PowerShell steps never fall back to a
# machine-wide Node.js installation or lose the action-managed PATH. A runner can drop the
# action-managed PATH while starting a new PowerShell process, so the toolcache is an explicit
# fallback rather than guessing from a machine-wide `node.exe`.
$nodeExecutable = $null
$toolCacheRoots = @($env:RUNNER_TOOL_CACHE, $env:AGENT_TOOLSDIRECTORY) |
  Where-Object { $_ } |
  Select-Object -Unique
$pathCandidates = @()
$pathNodes = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)
foreach ($pathNode in $pathNodes) {
  $pathCandidate = (Resolve-Path -LiteralPath $pathNode.Source).Path
  $pathVersion = (& $pathCandidate -p "process.versions.node").Trim()
  if ($LASTEXITCODE -eq 0 -and $pathVersion -match '^22\.') {
    $pathCandidates += $pathCandidate
  }
}

function Test-UnderToolCache([string]$candidate) {
  foreach ($toolCacheRoot in $toolCacheRoots) {
    $nodeRoot = [IO.Path]::GetFullPath((Join-Path $toolCacheRoot "node"))
    if ($candidate.StartsWith("$nodeRoot\", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

# Prefer a Node 22 path that setup-node placed in the toolcache. This excludes a coincidental
# machine-wide Node 22 when the action-managed PATH was lost but the cache is still available.
$nodeExecutable = $pathCandidates |
  Where-Object { Test-UnderToolCache $_ } |
  Select-Object -First 1

if (-not $nodeExecutable) {
  $toolCacheCandidates = foreach ($toolCacheRoot in $toolCacheRoots) {
    $nodeRoot = Join-Path $toolCacheRoot "node"
    if (Test-Path -LiteralPath $nodeRoot -PathType Container) {
      Get-ChildItem -LiteralPath $nodeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
          try { $_.VersionInfo.ProductVersion -match '^22\.' } catch { $false }
        }
    }
  }
  $nodeExecutable = $toolCacheCandidates |
    Sort-Object { [version]$_.VersionInfo.ProductVersion } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $nodeExecutable -and $toolCacheRoots.Count -eq 0) {
  # A runner installation may not expose a toolcache variable. In that case the verified
  # major-22 PATH candidate is still safer than invoking an unvalidated `node` later in the job.
  $nodeExecutable = $pathCandidates | Select-Object -First 1
}

if (-not $nodeExecutable) {
  throw "actions/setup-node did not leave a Node.js 22 executable on PATH or in the runner toolcache."
}

$nodeVersion = (& $nodeExecutable -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) {
  throw "The Node.js executable selected by setup-node could not report its version."
}

$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -ne 22) {
  throw "The Windows pipeline requires Node.js 22; setup-node resolved $nodeVersion at $nodeExecutable."
}

$nodeDirectory = Split-Path -Parent $nodeExecutable
$corepackCommand = Join-Path $nodeDirectory "corepack.cmd"
$corepackEntrypoint = Join-Path $nodeDirectory "node_modules\corepack\dist\corepack.js"
if (-not (Test-Path -LiteralPath $corepackEntrypoint -PathType Leaf)) {
  throw "The Node.js 22 toolcache does not contain the bundled Corepack entrypoint beside node.exe."
}

$nodeSha256 = (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MKT_BROWSER_NODE22_EXE=$nodeExecutable"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "NODE22_BIN=$nodeExecutable"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MKT_BROWSER_COREPACK22_CMD=$corepackCommand"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MKT_BROWSER_COREPACK22_ENTRYPOINT=$corepackEntrypoint"
Add-Content -LiteralPath $env:GITHUB_PATH -Value $nodeDirectory

Write-Host "Pinned Node.js $nodeVersion executable at $nodeExecutable ($nodeSha256)."
