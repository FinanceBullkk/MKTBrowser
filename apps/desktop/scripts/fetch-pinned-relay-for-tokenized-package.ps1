$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string]$Message) {
  throw $Message
}

$desktopRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $desktopRoot "relay-release.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  Fail "Pinned Relay manifest is unavailable."
}

try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
  Fail "Pinned Relay manifest is not valid JSON."
}
if (
  -not ($manifest.version -is [int] -or $manifest.version -is [long]) -or $manifest.version -le 0 -or
  -not ($manifest.sizeBytes -is [int] -or $manifest.sizeBytes -is [long]) -or $manifest.sizeBytes -le 0 -or
  [string]$manifest.sha256 -notmatch "^[0-9a-f]{64}$"
) {
  Fail "Pinned Relay manifest is incomplete."
}
$canonicalRelayOrigin = "https://mkttool-web-production.up.railway.app"
$expectedRelayUrl = "$canonicalRelayOrigin/api/relay/download/v$($manifest.version)"
if ([string]$manifest.url -cne $expectedRelayUrl) {
  Fail "Pinned Relay URL must equal the canonical immutable Relay release URL."
}
$uri = [Uri]$expectedRelayUrl

$payloadDirectory = Join-Path $desktopRoot ".relay-payload"
$finalPath = Join-Path $payloadDirectory "MKTTool-Relay-v$($manifest.version).zip"
$partialPath = "$finalPath.partial"
New-Item -ItemType Directory -Force -Path $payloadDirectory | Out-Null

$releaseToken = $null

function Test-PinnedArchive([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -ne [int64]$manifest.sizeBytes) { return $false }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sha256
}

try {
  if (Test-PinnedArchive $finalPath) {
    Write-Output "Verified Relay v$($manifest.version): $finalPath"
    exit 0
  }
  Remove-Item -LiteralPath $finalPath, $partialPath -Force -ErrorAction SilentlyContinue

  $localArchive = ([string]$env:MKTTOOL_RELAY_ARCHIVE).Trim()
  if ($localArchive) {
    if (-not (Test-PinnedArchive $localArchive)) {
      Fail "Local Relay archive does not match the pinned size and SHA-256."
    }
    Copy-Item -LiteralPath $localArchive -Destination $partialPath -Force
  } else {
    # This is the only token-bearing process. It does not invoke Node, Corepack, Yarn, or a package script.
    $releaseToken = ([string]$env:MKTTOOL_RELEASE_TOKEN).Trim()
    if (-not $releaseToken) {
      Fail "A Relay release token is required for the isolated Relay fetch."
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Method = "GET"
    $request.AllowAutoRedirect = $false
    $request.Headers["Authorization"] = "Bearer $releaseToken"
    $response = $null
    try {
      $response = [Net.HttpWebResponse]$request.GetResponse()
    } catch {
      Fail "Pinned Relay download failed closed."
    }
    try {
      if ([int]$response.StatusCode -ne 200) { Fail "Pinned Relay download failed closed." }
      $input = $response.GetResponseStream()
      try {
        $output = [IO.File]::Open($partialPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
      } finally {
        if ($input) { $input.Dispose() }
      }
    } finally {
      if ($response) { $response.Dispose() }
    }
  }

  if (-not (Test-PinnedArchive $partialPath)) {
    Fail "Pinned Relay bytes did not match the reviewed size and SHA-256."
  }
  Move-Item -LiteralPath $partialPath -Destination $finalPath -Force
  $handoffPath = ([string]$env:MKT_BROWSER_RELAY_HANDOFF_PATH).Trim()
  if ($handoffPath) {
    $resolvedFinalPath = (Resolve-Path -LiteralPath $finalPath -ErrorAction Stop).Path
    [IO.File]::WriteAllText($handoffPath, $resolvedFinalPath, [Text.UTF8Encoding]::new($false))
  }
  Write-Output "Verified Relay v$($manifest.version): $finalPath"
} finally {
  $releaseToken = $null
  Remove-Variable -Name releaseToken -ErrorAction SilentlyContinue
}
