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
  [string]$manifest.sha256 -notmatch "^[0-9a-f]{64}$" -or
  -not ($manifest.minimumProfileActionRelayVersion -is [int] -or $manifest.minimumProfileActionRelayVersion -is [long]) -or
  $manifest.minimumProfileActionRelayVersion -le 0 -or
  [string]::IsNullOrWhiteSpace([string]$manifest.promotionStatus)
) {
  Fail "Pinned Relay manifest is incomplete."
}
if (
  $manifest.version -lt $manifest.minimumProfileActionRelayVersion -or
  [string]$manifest.promotionStatus -cne "eligible"
) {
  Fail "Pinned Relay tuple is not eligible for tokenized Windows packaging."
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
$payloadMutexName = "Local\MKTBrowserRelayPayload-v$($manifest.version)-$($manifest.sha256.Substring(0, 16))"
$payloadMutex = [Threading.Mutex]::new($false, $payloadMutexName)
$payloadMutexHeld = $false

$releaseToken = $null

function Test-PinnedArchive([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -ne [int64]$manifest.sizeBytes) { return $false }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sha256
}

function Write-RelayHandoff([string]$ArchivePath, [string]$HandoffPath) {
  $resolvedHandoffPath = ([string]$HandoffPath).Trim()
  if (-not $resolvedHandoffPath) { return }
  $resolvedArchivePath = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
  # CreateNew prevents a colliding receipt from replacing another invocation's verified archive path.
  $stream = [IO.File]::Open(
    $resolvedHandoffPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $writer = New-Object IO.StreamWriter($stream, [Text.UTF8Encoding]::new($false))
    try {
      $writer.Write($resolvedArchivePath)
    } finally {
      $writer.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

try {
  # A single process owns the shared snapshot cache; each wrapper still receives its own handoff file.
  try {
    $payloadMutexHeld = $payloadMutex.WaitOne(120000)
  } catch [Threading.AbandonedMutexException] {
    $payloadMutexHeld = $true
  }
  if (-not $payloadMutexHeld) {
    Fail "Timed out waiting for another Relay archive staging operation."
  }

  if (Test-PinnedArchive $finalPath) {
    Write-RelayHandoff $finalPath ([string]$env:MKT_BROWSER_RELAY_HANDOFF_PATH)
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
  Write-RelayHandoff $finalPath ([string]$env:MKT_BROWSER_RELAY_HANDOFF_PATH)
  Write-Output "Verified Relay v$($manifest.version): $finalPath"
} finally {
  if ($payloadMutexHeld) {
    try { [void]$payloadMutex.ReleaseMutex() } catch {}
  }
  $payloadMutex.Dispose()
  $releaseToken = $null
  Remove-Variable -Name releaseToken -ErrorAction SilentlyContinue
}
