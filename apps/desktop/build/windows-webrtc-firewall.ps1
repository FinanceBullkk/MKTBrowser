param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("CheckProfiles", "CheckOwner", "Install", "Uninstall", "Verify", "VerifyAbsent")]
  [string]$Mode,
  [string]$CftPath,
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
$ErrorActionPreference = "Stop"
$group = "MKT Browser WebRTC Protection"
$prefix = "MKT Browser WebRTC UDP Block"

function Assert-Rule([string]$Name, [string]$Program) {
  $policy = New-Object -ComObject HNetCfg.FwPolicy2
  $rules = @($policy.Rules | Where-Object { $_.Name -eq $Name })
  if ($rules.Count -ne 1) { throw "rule-count" }
  $rule = $rules[0]
  if ([string]::IsNullOrWhiteSpace($rule.ApplicationName) -or
      -not [IO.Path]::GetFullPath($rule.ApplicationName).Equals(
        $Program,
        [StringComparison]::OrdinalIgnoreCase
      )) { throw "program-invalid" }
  if ($rule.Protocol -ne 17) { throw "protocol-invalid" }
  # Wildcard ports is the old block-everything rule; it must read as invalid so
  # an upgrade replaces it instead of judging it correct.
  if ($rule.RemotePorts -eq "*") { throw "ports-invalid" }
  if (-not $rule.Enabled -or $rule.Direction -ne 2 -or $rule.Action -ne 0 -or
      ($rule.Profiles -band 7) -ne 7) { throw "rule-invalid" }
  Assert-FirewallProfiles $policy
}

function Assert-FirewallProfiles($Policy = $null) {
  if ($null -eq $Policy) { $Policy = New-Object -ComObject HNetCfg.FwPolicy2 }
  foreach ($profile in @(1, 2, 4)) {
    if (-not $Policy.FirewallEnabled($profile)) { throw "firewall-profile-disabled" }
  }
}

function Owned-Rules {
  if (-not [string]::IsNullOrWhiteSpace($OwnedRuleInventoryPath)) {
    if ($Mode -ne "CheckOwner") { throw "inventory-not-allowed" }
    $inventory = Get-Content -LiteralPath $OwnedRuleInventoryPath -Raw | ConvertFrom-Json
    return @($inventory.Rules)
  }
  $policy = New-Object -ComObject HNetCfg.FwPolicy2
  return @($policy.Rules | Where-Object { $_.Grouping -eq $group })
}

function Assert-FirewallOwnership([string]$Cft, [string]$Cloak) {
  foreach ($rule in @(Owned-Rules)) {
    if ([string]::IsNullOrWhiteSpace($rule.ApplicationName)) { throw "different-user-owner" }
    $program = [IO.Path]::GetFullPath($rule.ApplicationName)
    if (-not $program.Equals($Cft, [StringComparison]::OrdinalIgnoreCase) -and
        -not $program.Equals($Cloak, [StringComparison]::OrdinalIgnoreCase)) {
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
    $policy = New-Object -ComObject HNetCfg.FwPolicy2
    $ownedRules = @($policy.Rules | Where-Object { $_.Grouping -eq $group })
    if ($ownedRules.Count -ne 0) { throw "rule-still-present" }
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($CftPath) -or
      [string]::IsNullOrWhiteSpace($CloakBrowserPath)) { throw "unexpected-runtime-path" }
  $cft = [IO.Path]::GetFullPath($CftPath)
  $cloak = [IO.Path]::GetFullPath($CloakBrowserPath)
  if (-not $cft.EndsWith("\chromium\cft\runtime\chrome.exe", [StringComparison]::OrdinalIgnoreCase) -or
      -not $cloak.EndsWith("\chromium\cloakbrowser\runtime\chrome.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "unexpected-runtime-path"
  }
  Assert-FirewallOwnership $cft $cloak

  if ($Mode -eq "CheckOwner") { exit 0 }

  if ($Mode -eq "Uninstall") {
    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    exit 0
  }

  $candidates = @(
    @{ Candidate = "$prefix Candidate (Chrome for Testing)"; Final = "$prefix (Chrome for Testing)"; Program = $cft },
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
