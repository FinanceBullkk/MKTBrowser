<#
  Remove the downloaded Chromium engine cache during uninstall.

  Uninstall preserves the operator's data on purpose -- profiles.db, settings.json and the Relay
  device identity all survive, and the 0.3.19 clean-VM run verified that. The engine cache is not
  operator data. It is a few hundred megabytes of re-downloadable Chromium (578 MB on the owner's
  host) that used to be left behind with no uninstaller step, no checkbox and no documented way to
  remove it, so an operator who uninstalled the product still paid for it.

  Two boundaries this deliberately does NOT cross:

  - Only `<product root>\chromium` is removed. profiles.db, settings.json, profile-shutdown.log and
    every other file directly under the product root are operator data and stay.
  - The engine *pin* lives in `%LOCALAPPDATA%\MKTTool\compatibility-updater\active-engine.json`,
    a sibling of the product root rather than a child, so it is untouched by this path. A reinstall
    still knows which engine it is supposed to fetch.

  Failure is reported, never fatal. Every other step in customUnInstall aborts when it cannot
  finish, because leaving a firewall rule, a foreign shortcut or a half-removed Relay behind is a
  correctness problem. A retained engine cache is disk usage, and it is exactly what every earlier
  version left behind -- so failing the uninstall over it would turn a cleanup improvement into a
  new way for uninstall to break. A running browser holding its own image is the ordinary case here.
#>
$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is unavailable."
}

$localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\")
$engineCache = [IO.Path]::GetFullPath((Join-Path $localAppData "MKTTool\MKTBrowser\chromium"))

# The target is built from LOCALAPPDATA rather than passed in, so the containment check is the one
# thing that can still catch a hostile or malformed LOCALAPPDATA before a recursive delete runs.
if (-not $engineCache.StartsWith($localAppData + "\", [StringComparison]::OrdinalIgnoreCase)) {
  Write-Output "engine-cache-outside-localappdata"
  exit 1
}

if (-not (Test-Path -LiteralPath $engineCache -PathType Container)) {
  Write-Output "engine-cache-absent"
  exit 0
}

# A scanner or a just-exited browser can hold a handle briefly, so retry rather than deciding on the
# first attempt -- the same pattern the Relay executable removal uses.
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ($true) {
  Remove-Item -LiteralPath $engineCache -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $engineCache)) {
    Write-Output "engine-cache-removed"
    exit 0
  }
  if ([DateTime]::UtcNow -ge $deadline) {
    Write-Output "engine-cache-retained"
    exit 1
  }
  Start-Sleep -Milliseconds 250
}
