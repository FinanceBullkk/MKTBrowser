param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$StagingDirectory
)

$ErrorActionPreference = "Stop"
$archive = [IO.Path]::GetFullPath($ArchivePath)
$staging = [IO.Path]::GetFullPath($StagingDirectory)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"

if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
  throw "relay-archive-missing"
}
if (-not $archive.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) {
  throw "relay-archive-invalid"
}
if (-not ($staging + "\").StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "relay-staging-outside-temp"
}

<#
  Re-verify the payload against its pinned manifest before anything is extracted or executed.

  Every earlier link in this chain is hash-pinned: `fetch-pinned-relay.cjs` checks the download,
  `verify-relay-executable-pin.cjs` hashes MKTTool-Relay.exe inside the archive without extracting
  it, and `package-windows.cjs` re-hashes the staged copy. This script is the last link and the
  only one that runs on the operator's machine, and it used to trust whatever bytes sat at
  $ArchivePath.

  The install directory is per-user and ordinarily writable, so anything running as that user could
  swap the archive and have `& install-relay.ps1` below execute its replacement. That is not a
  privilege boundary the installer can hold on its own -- such code already has the user's token --
  but the guarantee the rest of the pipeline spends so much effort establishing should not stop one
  step short of the machine it is meant to protect. It also removes the only way a partially copied
  or corrupted archive reaches Expand-Archive.

  The manifest ships beside the archive (see extraResources in electron-builder-installer.yml), so
  no new input is needed. Only the fields that pin the bytes are read; the manifest is not a
  substitute for the build-time verification, it is the same pin restated where it can be rechecked.
#>
$manifestPath = Join-Path ([IO.Path]::GetDirectoryName($archive)) "relay-release.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "relay-manifest-missing"
}

try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  throw "relay-manifest-invalid"
}

$expectedSize = $manifest.sizeBytes -as [long]
$expectedSha256 = [string]$manifest.sha256
if (-not $expectedSize -or $expectedSize -le 0 -or $expectedSha256 -notmatch "^[0-9a-f]{64}$") {
  throw "relay-manifest-invalid"
}

# Size first: it is free, and a mismatch makes hashing a large file pointless.
$actualSize = (Get-Item -LiteralPath $archive).Length
if ($actualSize -ne $expectedSize) {
  throw "relay-archive-size-mismatch"
}
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try {
  $stream = [IO.File]::OpenRead($archive)
  try {
    $actualSha256 = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
} finally {
  $hashAlgorithm.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
  throw "relay-archive-checksum-mismatch"
}

<#
  Extract entry by entry, refusing any entry that resolves outside the staging directory.

  `Expand-Archive` was used here and does not make that guarantee: a crafted entry name can walk out
  of the destination and write anywhere the installer can reach. The app side already moved off
  unchecked extraction -- `verify-packaged-runtime-contract.cjs` asserts extract-zip is gone from
  app.asar in favour of yauzl behind `safe-archive-extraction` -- and this is the same product
  extracting the same kind of input, so the two halves should not disagree about it.

  With the hash check above in place this is defence in depth rather than the primary control: a
  traversal entry can only reach here inside an archive that matches the pinned digest, which means
  a compromised build input rather than a swapped file on the operator's disk. It is cheap, and the
  order matters -- validate the whole archive's paths before writing any of it, so a rejected
  archive leaves no partial extraction behind.
#>
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stagingPrefix = $staging.TrimEnd("\") + "\"
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $planned = New-Object System.Collections.Generic.List[object]
  foreach ($entry in $zip.Entries) {
    # A directory entry has an empty Name; it needs no file written, only its path allowed.
    $destination = [IO.Path]::GetFullPath([IO.Path]::Combine($staging, $entry.FullName))
    if (-not $destination.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "relay-archive-entry-escapes-staging"
    }
    if ($entry.Name) {
      $planned.Add([pscustomobject]@{ Entry = $entry; Destination = $destination })
    }
  }

  foreach ($item in $planned) {
    $directory = [IO.Path]::GetDirectoryName($item.Destination)
    if ($directory -and -not (Test-Path -LiteralPath $directory -PathType Container)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $item.Destination, $true)
  }
} finally {
  $zip.Dispose()
}

$installer = Join-Path $staging "install-relay.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "relay-installer-missing"
}

$env:RELAY_SKIP_BROWSER = "1"
& $installer
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
