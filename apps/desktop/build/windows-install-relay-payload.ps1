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

Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
$installer = Join-Path $staging "install-relay.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "relay-installer-missing"
}

$env:RELAY_SKIP_BROWSER = "1"
& $installer
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
