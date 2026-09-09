param(
  [Parameter(Mandatory = $true)][ValidateSet("Preflight", "Takeover", "Restore", "RemoveBrowser")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$ExpectedBrowserPath,
  [Parameter(Mandatory = $true)][string]$ExpectedRelayPath,
  [Parameter(Mandatory = $true)][string]$StartupDirectory
)

$ErrorActionPreference = "Stop"

function Same-Path([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-OwnedShortcut([string]$Link, [string]$Target, [string[]]$AllowedArguments) {
  if (-not (Test-Path -LiteralPath $Link)) { return }
  if ((Get-Item -LiteralPath $Link).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "shortcut-link-not-owned" }
  $shortcut = $shell.CreateShortcut($Link)
  try {
    if (-not (Same-Path $shortcut.TargetPath $Target) -or $shortcut.Arguments -cnotin $AllowedArguments) {
      throw "shortcut-target-not-owned"
    }
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  }
}

function Save-Shortcut([string]$Link, [string]$Target, [string]$Arguments) {
  $shortcut = $shell.CreateShortcut($Link)
  try {
    $shortcut.TargetPath = $Target
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($Target)
    $shortcut.WindowStyle = 7
    $shortcut.Save()
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  }
  Assert-OwnedShortcut $Link $Target @($Arguments)
  if (-not (Test-Path -LiteralPath $Link -PathType Leaf)) { throw "shortcut-save-not-verified" }
}

$shell = $null
try {
  if ($Mode -eq "Preflight" -and -not (Test-Path -LiteralPath $StartupDirectory)) {
    Write-Output "No existing Startup directory to inspect."
    exit 0
  }
  if (-not (Test-Path -LiteralPath $StartupDirectory -PathType Container)) { throw "startup-directory-missing" }
  if ((Get-Item -LiteralPath $StartupDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "startup-directory-not-owned" }
  $browserLink = Join-Path $StartupDirectory "MKT Browser.lnk"
  $relayLink = Join-Path $StartupDirectory "MKTTool Relay.lnk"
  $shell = New-Object -ComObject WScript.Shell
  if ($Mode -eq "Preflight") {
    # Canonical names may target unrelated executable names; validate before bundled Relay setup.
    Assert-OwnedShortcut $relayLink $ExpectedRelayPath @("")
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
  } elseif ($Mode -eq "RemoveBrowser") {
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
    if (Test-Path -LiteralPath $browserLink) { Remove-Item -LiteralPath $browserLink -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $browserLink) { throw "browser-startup-removal-not-verified" }
  } elseif ($Mode -eq "Takeover") {
    Assert-OwnedShortcut $relayLink $ExpectedRelayPath @("")
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
    if (-not (Test-Path -LiteralPath $ExpectedBrowserPath -PathType Leaf)) { throw "browser-missing" }
    Save-Shortcut $browserLink $ExpectedBrowserPath "--background"
    # Recheck after saving Browser startup; a foreign target must never be removed.
    Assert-OwnedShortcut $relayLink $ExpectedRelayPath @("")
    if (Test-Path -LiteralPath $relayLink) { Remove-Item -LiteralPath $relayLink -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $relayLink) { throw "relay-startup-removal-not-verified" }
  } else {
    Assert-OwnedShortcut $relayLink $ExpectedRelayPath @("")
    # Standalone Relay may already be uninstalled; do not recreate a dangling startup entry.
    if ((Test-Path -LiteralPath $ExpectedRelayPath -PathType Leaf) -and -not (Test-Path -LiteralPath $relayLink)) {
      Save-Shortcut $relayLink $ExpectedRelayPath ""
    }
  }
  Write-Output "Startup coordination verified."
} catch {
  [Console]::Error.WriteLine("Startup coordination could not be changed safely. Inspect current-user Startup entries, then run MKT Browser installer repair.")
  exit 1
} finally {
  if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
exit 0
