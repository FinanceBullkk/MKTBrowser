param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("CheckProfiles", "CheckOwner", "Install", "Uninstall", "Verify", "VerifyAbsent")]
  [string]$Mode,
  [string]$CloakBrowserPath,
  [string]$OwnedRuleInventoryPath
)

# Why the rule blocks all outbound UDP except 53 and 443.
#
# WebRTC's STUN/TURN and its media streams sit on 3478 and on ephemeral high ports, and stay
# blocked. Two ports are left open, each for its own measured reason. Do not "tidy" either one
# away: closing 53 does not harden anything, it stops the browser from starting at all.
#
# 53, because blocking it broke the browser. Blocking every UDP port also blocked DNS, and
# Chromium resolves names itself rather than calling the OS resolver, so it could not look up its
# own licence host and exited reporting the licence server as unreachable -- on a machine whose
# network was fine, with a key the server confirmed valid. The message sent the operator to check
# their key and their connection, neither of which was wrong.
#
# Measured in order on 19 August 2026: all UDP blocked exits 78; the same rule with
# --disable-features=AsyncDns exits 76, which is the licence server answering through the OS
# resolver; the rule rebuilt with 53 open exits 76 with no flag at all. An earlier attempt that
# opened only 443 still exited 78, which is what ruled QUIC out as the cause.
#
# 443, because never using it is itself a tell. A real Chrome negotiates HTTP/3 where it is
# offered, and one that never can is deviating from what it claims to be -- visible to exactly the
# sites this tool exists to blend into.
#
# TURN relayed over UDP 443 slips through this gap, so the firewall is not the only layer:
# profiles launch with --fingerprint-webrtc-ip, which replaces the address WebRTC would report at
# the source. A browser that refuses to start protects nothing at all.
#
# This prose used to live in scripts/generate-windows-firewall-commands.cjs because the script was
# embedded in an NSIS define capped at 8192 characters, and forty lines of comment once pushed it
# over that limit and broke every install with an unintelligible code. The installer now runs this
# file directly with -File, so that cap is gone and the reasoning belongs next to the rule.

# Why every read here goes through the NetSecurity cmdlets and not HNetCfg.FwPolicy2.
#
# Microsoft Defender quarantined the 23 August installer candidate mid-install as
# `Behavior:Win32/PShellCobStager.A` -- a *behavioural* detection, not a signature match, whose name
# is literally "PowerShell COM stager". The installer's shape matched it: an unsigned executable
# dropped .ps1 files into a temp directory, ran them with -ExecutionPolicy Bypass, elevated one of
# them through runas, and that script built `New-Object -ComObject HNetCfg.FwPolicy2` to touch the
# firewall. Defender remediated, the install stopped at 129 files with no Relay and zero rules, and
# the clean combined-install gate was invalidated.
#
# The writes in this file already used the NetSecurity cmdlets; only the reads used COM, for no
# reason beyond convenience. So the COM object buys nothing and costs the product its ability to
# install. Removing it does not by itself prove Defender is satisfied -- the dropped-script and
# elevation shape remain, and signing is still the real fix -- but it removes the one trigger the
# signature is named after.
#
# Do not reintroduce `New-Object -ComObject` here. It reads as tidier and it is measurably not.
$ErrorActionPreference = "Stop"
$group = "MKT Browser WebRTC Protection"
$prefix = "MKT Browser WebRTC UDP Block"

# Every rule lookup below is written inline as `@(Get-NetFirewallRule ... -ErrorAction
# SilentlyContinue)`, never behind a helper that returns the array.
#
# Two reasons, both load-bearing. `Get-NetFirewallRule` throws when nothing matches and this script
# runs under -ErrorAction Stop, so a missing rule -- a normal answer at almost every call site --
# has to be asked for quietly. And a function that does `return @(...)` has its array unrolled by
# the pipeline on the way out, so a single match arrives at the caller as a bare object whose
# `.Count` is $null. `$null -ne 1` is true, which reads as "wrong number of rules"; worse,
# `$null -ne 0` is false, which would have let VerifyAbsent report a still-present rule as removed.
# A fail-closed check must not depend on that subtlety, so the @() stays at the assignment.
function Assert-Rule([string]$Name, [string]$Program) {
  $rules = @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
  if ($rules.Count -ne 1) { throw "rule-count" }
  $rule = $rules[0]

  $application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule
  if ([string]::IsNullOrWhiteSpace($application.Program) -or
      $application.Program -eq "Any" -or
      -not [IO.Path]::GetFullPath($application.Program).Equals(
        $Program,
        [StringComparison]::OrdinalIgnoreCase
      )) { throw "program-invalid" }

  $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
  if ("$($port.Protocol)" -ne "UDP") { throw "protocol-invalid" }
  # A wildcard remote port is the old block-everything rule; it must read as invalid so an upgrade
  # replaces it instead of judging it correct. COM reported that as "*", the cmdlets as "Any".
  if ("$($port.RemotePort)" -eq "Any" -or "$($port.RemotePort)" -eq "*") { throw "ports-invalid" }

  # Every one of these is compared as a string on purpose: the cmdlets return enum values whose
  # numeric backing differs from the COM constants this replaced, and "$(...)" pins the comparison
  # to the documented names rather than to an ordinal that could shift.
  if ("$($rule.Enabled)" -ne "True" -or
      "$($rule.Direction)" -ne "Outbound" -or
      "$($rule.Action)" -ne "Block") { throw "rule-invalid" }

  # The COM check was `($rule.Profiles -band 7) -ne 7` -- all of Domain, Private and Public. The
  # cmdlets report either "Any" or a comma-separated subset, so all three must be named unless the
  # rule applies to every profile.
  $profileValue = "$($rule.Profile)"
  if ($profileValue -ne "Any") {
    foreach ($required in @("Domain", "Private", "Public")) {
      if ($profileValue -notmatch "(^|,\s*)$required(\s*,|$)") { throw "rule-invalid" }
    }
  }

  Assert-FirewallProfiles
}

function Assert-FirewallProfiles {
  # Domain, Private and Public -- the COM bitmask 1, 2, 4 this replaced.
  foreach ($name in @("Domain", "Private", "Public")) {
    $profile = Get-NetFirewallProfile -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $profile -or "$($profile.Enabled)" -ne "True") {
      throw "firewall-profile-disabled"
    }
  }
}

function Owned-Rules {
  if (-not [string]::IsNullOrWhiteSpace($OwnedRuleInventoryPath)) {
    if ($Mode -ne "CheckOwner") { throw "inventory-not-allowed" }
    $inventory = Get-Content -LiteralPath $OwnedRuleInventoryPath -Raw | ConvertFrom-Json
    return @($inventory.Rules)
  }
  # Shaped to carry `ApplicationName` so the inventory branch above and this one stay
  # interchangeable for `Assert-FirewallOwnership`.
  return @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      ApplicationName = (Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $_).Program
    }
  })
}

function Assert-FirewallOwnership([string]$Cloak) {
  foreach ($rule in @(Owned-Rules)) {
    # "Any" is the cmdlets' word for a rule bound to no program at all. It must fail closed exactly
    # like a blank did under COM, and never reach GetFullPath, which would resolve it against the
    # working directory and compare a nonsense path.
    if ([string]::IsNullOrWhiteSpace($rule.ApplicationName) -or
        $rule.ApplicationName -eq "Any") { throw "different-user-owner" }
    $program = [IO.Path]::GetFullPath($rule.ApplicationName)
    if (-not $program.Equals($Cloak, [StringComparison]::OrdinalIgnoreCase)) {
      throw "different-user-owner"
    }
  }
}

try {
  if ($Mode -eq "CheckProfiles") {
    Assert-FirewallProfiles
    exit 0
  }

  if ($Mode -eq "VerifyAbsent") {
    $owned = @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue)
    if ($owned.Count -ne 0) { throw "rule-still-present" }
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($CloakBrowserPath)) { throw "unexpected-runtime-path" }
  $cloak = [IO.Path]::GetFullPath($CloakBrowserPath)
  if (-not $cloak.EndsWith("\chromium\cloakbrowser\runtime\chrome.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "unexpected-runtime-path"
  }
  Assert-FirewallOwnership $cloak

  if ($Mode -eq "CheckOwner") { exit 0 }

  if ($Mode -eq "Uninstall") {
    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    exit 0
  }

  # The Uninstall branch above removes every rule in the group, including the
  # "(Chrome for Testing)" rule older installers created; the sweep at the end
  # of this branch drops any survivor that does not match the one candidate.
  $candidates = @(
    @{ Candidate = "$prefix Candidate (CloakBrowser)"; Final = "$prefix (CloakBrowser)"; Program = $cloak }
  )

  if ($Mode -eq "Verify") {
    foreach ($entry in $candidates) { Assert-Rule $entry.Final $entry.Program }
    exit 0
  }

  foreach ($entry in $candidates) {
    try {
      Assert-Rule $entry.Final $entry.Program
      continue
    } catch {}
    Get-NetFirewallRule -DisplayName $entry.Candidate -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # Block all outbound UDP except DNS and HTTP/3.
    New-NetFirewallRule -DisplayName $entry.Candidate -Group $group -Enabled True `
      -Direction Outbound -Action Block -Program $entry.Program -Protocol UDP `
      -RemotePort @("1-52", "54-442", "444-65535") -Profile Any | Out-Null
    Assert-Rule $entry.Candidate $entry.Program
  }

  foreach ($entry in $candidates) {
    try {
      Assert-Rule $entry.Final $entry.Program
      Get-NetFirewallRule -DisplayName $entry.Candidate -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    } catch {
      Get-NetFirewallRule -DisplayName $entry.Final -ErrorAction SilentlyContinue | Remove-NetFirewallRule
      Set-NetFirewallRule -DisplayName $entry.Candidate -NewDisplayName $entry.Final | Out-Null
      Assert-Rule $entry.Final $entry.Program
    }
  }

  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'MKT Browser WebRTC UDP Block *' -and
      $_.DisplayName -notin @($candidates.Final) -and $_.DisplayName -notin @($candidates.Candidate) } |
    Remove-NetFirewallRule
  exit 0
} catch {
  switch ($_.Exception.Message) {
    "unexpected-runtime-path" { exit 10 }
    "rule-count" { exit 11 }
    "program-invalid" { exit 12 }
    "protocol-invalid" { exit 13 }
    "rule-invalid" { exit 14 }
    "firewall-profile-disabled" { exit 15 }
    "rule-still-present" { exit 16 }
    "different-user-owner" { exit 17 }
    default { exit 29 }
  }
}
