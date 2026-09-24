param(
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-fA-F0-9]{64}$")]
  [string]$NodeSha256
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Defender can briefly lock prebuild-install's temporary archive and break its final rename.
# Supplying a reviewed local prebuild avoids that race and the unsupported source-build fallback.
$betterSqliteVersion = "12.11.1"
$expectedNodeAbi = "127"
$expectedSha256 = "927b34496e946dc7c9a45636a03a039df72f10191ccc4960b8616d1a9319e45b"

if (-not $env:GITHUB_ENV -or -not $env:RUNNER_TEMP) {
  throw "GITHUB_ENV is required to export native dependency settings."
}

if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw "NodeExecutable must name the pinned Node.js 22 executable."
}

$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$actualNodeSha256 = (Get-FileHash -LiteralPath $NodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeSha256 -ne $NodeSha256.ToLowerInvariant()) {
  throw "NodeExecutable does not match the SHA-256 emitted by the Node.js setup step."
}

if (-not (Select-String -LiteralPath "yarn.lock" -SimpleMatch "resolution: `"better-sqlite3@npm:$betterSqliteVersion`"" -Quiet)) {
  throw "The pinned better-sqlite3 version no longer matches yarn.lock."
}

$nodeAbi = (& $NodeExecutable -p "process.versions.modules").Trim()
$nodePlatform = (& $NodeExecutable -p "process.platform").Trim()
$nodeArch = (& $NodeExecutable -p "process.arch").Trim()
if ($nodeAbi -ne $expectedNodeAbi -or $nodePlatform -ne "win32" -or $nodeArch -ne "x64") {
  throw "No reviewed better-sqlite3 prebuild is pinned for Node ABI $nodeAbi on $nodePlatform-$nodeArch."
}

$npmCache = Join-Path $env:RUNNER_TEMP ("npm-cache-" + [guid]::NewGuid().ToString("N"))
$prebuildRoot = Join-Path $env:RUNNER_TEMP ("native-prebuilds-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $npmCache, $prebuildRoot | Out-Null

$archiveName = "better-sqlite3-v$betterSqliteVersion-node-v$nodeAbi-win32-x64.tar.gz"
$archivePath = Join-Path $prebuildRoot $archiveName
$downloadUrl = "https://github.com/WiseLibs/better-sqlite3/releases/download/v$betterSqliteVersion/$archiveName"
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -MaximumRetryCount 3 -RetryIntervalSec 2

$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "Downloaded better-sqlite3 prebuild failed SHA-256 verification."
}

Add-Content -LiteralPath $env:GITHUB_ENV -Value "npm_config_cache=$npmCache"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "npm_config_better_sqlite3_local_prebuilds=$prebuildRoot"
