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

function Assert-Path-Not-Reparse([string]$Path, [string]$Failure) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw $Failure }
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

function Assert-RelayExecutable-Available([string]$ExpectedRelayPath) {
  if (-not (Test-Path -LiteralPath $ExpectedRelayPath -PathType Leaf)) { throw "relay-executable-missing" }
  Assert-Path-Not-Reparse (Split-Path -Parent $ExpectedRelayPath) "relay-parent-not-owned"
  Assert-Path-Not-Reparse $ExpectedRelayPath "relay-not-owned"
}

function Assert-RelayShortcut(
  [string]$Link,
  [string]$ExpectedLauncherPath,
  [string]$ExpectedRelayPath,
  [bool]$AllowLegacyDirectTarget
) {
  if (-not (Test-Path -LiteralPath $Link)) { return }
  if ((Get-Item -LiteralPath $Link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "shortcut-link-not-owned" }
  $shortcut = $shell.CreateShortcut($Link)
  try {
    if ($shortcut.Arguments -cne "") { throw "shortcut-target-not-owned" }
    if (Same-Path $shortcut.TargetPath $ExpectedLauncherPath) {
      Assert-Path-Not-Reparse (Split-Path -Parent $ExpectedLauncherPath) "relay-launcher-parent-not-owned"
      if (-not (Test-Path -LiteralPath $ExpectedLauncherPath -PathType Leaf)) { throw "relay-launcher-missing" }
      Assert-Path-Not-Reparse $ExpectedLauncherPath "relay-launcher-not-owned"
      Assert-RelayExecutable-Available $ExpectedRelayPath
      return
    }
    # Only setup preflight may recognize the exact historical direct target so its payload can replace it.
    if ($AllowLegacyDirectTarget -and (Same-Path $shortcut.TargetPath $ExpectedRelayPath)) {
      Assert-Path-Not-Reparse (Split-Path -Parent $ExpectedRelayPath) "relay-parent-not-owned"
      Assert-Path-Not-Reparse $ExpectedRelayPath "relay-not-owned"
      return
    }
    throw "shortcut-target-not-owned"
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  }
}

function Assert-RelayLauncher-Available([string]$ExpectedLauncherPath) {
  if (-not (Test-Path -LiteralPath $ExpectedLauncherPath -PathType Leaf)) { throw "relay-launcher-missing" }
  Assert-Path-Not-Reparse (Split-Path -Parent $ExpectedLauncherPath) "relay-launcher-parent-not-owned"
  Assert-Path-Not-Reparse $ExpectedLauncherPath "relay-launcher-not-owned"
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
  if (-not (Test-Path -LiteralPath $StartupDirectory -PathType Container)) {
    if ($Mode -eq "RemoveBrowser" -and -not (Test-Path -LiteralPath $StartupDirectory)) { exit 0 }
    throw "startup-directory-missing"
  }
  if ((Get-Item -LiteralPath $StartupDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "startup-directory-not-owned" }
  $browserLink = Join-Path $StartupDirectory "MKT Browser.lnk"
  $relayLink = Join-Path $StartupDirectory "MKTTool Relay.lnk"
  $relayLauncher = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($ExpectedRelayPath))) "start-mkttool-relay.cmd"
  $shell = New-Object -ComObject WScript.Shell
  if ($Mode -eq "Preflight") {
    # A legacy direct Relay target is permitted only here, before the bundled payload upgrades it.
    Assert-RelayShortcut $relayLink $relayLauncher $ExpectedRelayPath $true
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
  } elseif ($Mode -eq "RemoveBrowser") {
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
    if (Test-Path -LiteralPath $browserLink) { Remove-Item -LiteralPath $browserLink -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $browserLink) { throw "browser-startup-removal-not-verified" }
  } elseif ($Mode -eq "Takeover") {
    # The old direct target is only a pre-payload compatibility shape. Takeover requires its safe replacement.
    Assert-RelayShortcut $relayLink $relayLauncher $ExpectedRelayPath $false
    Assert-OwnedShortcut $browserLink $ExpectedBrowserPath @("", "--background")
    if (-not (Test-Path -LiteralPath $ExpectedBrowserPath -PathType Leaf)) { throw "browser-missing" }
    Assert-RelayLauncher-Available $relayLauncher
    Assert-RelayExecutable-Available $ExpectedRelayPath
    Save-Shortcut $browserLink $ExpectedBrowserPath "--background"
    # Recheck after saving Browser startup; only the exact safe wrapper target may be removed.
    Assert-RelayShortcut $relayLink $relayLauncher $ExpectedRelayPath $false
    if (Test-Path -LiteralPath $relayLink) { Remove-Item -LiteralPath $relayLink -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $relayLink) { throw "relay-startup-removal-not-verified" }
  } else {
    Assert-RelayShortcut $relayLink $relayLauncher $ExpectedRelayPath $false
    # A retained Relay is restored only through the wrapper, and only after both artifacts exist.
    if ((Test-Path -LiteralPath $ExpectedRelayPath -PathType Leaf) -and
         (Test-Path -LiteralPath $relayLauncher -PathType Leaf) -and
         -not (Test-Path -LiteralPath $relayLink)) {
      Assert-RelayLauncher-Available $relayLauncher
      Assert-RelayExecutable-Available $ExpectedRelayPath
      Save-Shortcut $relayLink $relayLauncher ""
      Assert-RelayShortcut $relayLink $relayLauncher $ExpectedRelayPath $false
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
