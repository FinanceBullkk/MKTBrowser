param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("CheckProfiles", "Install", "Uninstall", "Verify", "VerifyAbsent")]
  [string]$Mode,
  [string]$CftPath,
  [string]$CloakBrowserPath
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

try {
  if ($Mode -eq "CheckProfiles") {
    Assert-FirewallProfiles
    exit 0
  }

  if ($Mode -eq "Uninstall") {
    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
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
    New-NetFirewallRule -DisplayName $entry.Candidate -Group $group -Enabled True `
      -Direction Outbound -Action Block -Program $entry.Program -Protocol UDP -Profile Any | Out-Null
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
    default { exit 29 }
  }
}
