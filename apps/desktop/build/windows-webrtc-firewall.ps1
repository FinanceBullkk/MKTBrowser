param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("CheckProfiles", "CheckOwner", "Install", "Uninstall", "Verify", "VerifyAbsent")]
  [string]$Mode,
  [string]$CftPath,
  [string]$CloakBrowserPath,
  [string]$OwnedRuleInventoryPath
)

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
  # A rule that blocks every outbound UDP port also blocks QUIC on 443, which is
  # how CloakBrowser reaches its licence server — the browser then refuses to
  # start and blames the licence. Earlier installs created exactly that rule, so
  # a wildcard port set must read as invalid here or the upgrade would inspect
  # it, find it "correct", and leave the machine unable to open any profile.
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
    # Every outbound UDP port except 53 and 443. WebRTC's STUN/TURN and its
    # media streams live on 3478 and on ephemeral high ports, all still blocked.
    #
    # 53 is the one that mattered. Blocking every UDP port also blocked DNS, and
    # Chromium resolves names itself over UDP 53 rather than calling the OS
    # resolver, so the browser could not look up its own licence host and exited
    # reporting the licence server as unreachable. Measured: with all UDP
    # blocked the launch exits 78; forcing the OS resolver with
    # --disable-features=AsyncDns under the same rule exits 76, which is the
    # licence server answering. The firewall was the cause, DNS was the path.
    #
    # 443 stays open for a different reason. A real Chrome negotiates HTTP/3
    # with hosts that offer it; one that never can is deviating from the
    # behaviour it claims, and that deviation is visible to the sites this tool
    # exists to blend into.
    #
    # TURN relayed over UDP 443 slips through this gap, so the firewall is not
    # the only layer: profiles already launch with --fingerprint-webrtc-ip,
    # which replaces the address WebRTC would report at the source. A browser
    # that refuses to start protects nothing at all.
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
