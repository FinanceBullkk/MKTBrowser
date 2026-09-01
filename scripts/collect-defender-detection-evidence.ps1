<#
.SYNOPSIS
  Capture exactly what Microsoft Defender detected during an installer run, and which stage caused it.

.DESCRIPTION
  The 24 August clean-guest attempt recorded `Behavior:Win32/PShellCobStager.A` "twice" and nothing
  about which of the installer's five PowerShell stages produced it. That missing detail is what
  decides which script to change next, and re-running a clean VM to learn a yes/no answer wastes the
  most expensive thing in this release cycle.

  With code signing ruled out by owner decision on 24 August 2026, reducing the installer's
  behavioural shape is the only remaining lever, and it will likely take more than one attempt. Each
  attempt has to come back with the triggering process, the file path, and the detection source, not
  just a verdict.

  Run `-Mark` before launching the installer, then `-Collect` afterwards. `-Collect` reads both the
  Defender cmdlet history and the Operational event log, because the two disagree usefully: the
  cmdlets keep remediated threats, the event log keeps the process and command line that caused them.

.PARAMETER Mark
  Write a baseline timestamp so `-Collect` reports only this run.

.PARAMETER Collect
  Report detections recorded since the mark (or since -SinceMinutes if no mark exists).

.PARAMETER SinceMinutes
  Fallback window when no mark file is present. Default 60.

.PARAMETER OutFile
  Also write the report here, for pasting into a plan report.

.NOTES
  Needs an elevated shell: Get-MpThreatDetection and the Defender Operational log both require it.
  Never disables Defender and never adds an exclusion. A detection that is suppressed teaches
  nothing, and an installer that only works with Defender weakened is not a shippable installer.
#>
[CmdletBinding()]
param(
  [switch]$Mark,
  [switch]$Collect,
  [int]$SinceMinutes = 60,
  [string]$OutFile
)

$ErrorActionPreference = "Stop"
$markFile = Join-Path $env:TEMP "mkt-defender-evidence-mark.txt"
$lines = New-Object System.Collections.Generic.List[string]

function Emit([string]$Text) {
  $lines.Add($Text)
  Write-Host $Text
}

function Assert-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Not elevated. Get-MpThreatDetection and the Defender Operational log will be empty or partial."
  }
}

if ($Mark) {
  $now = (Get-Date).ToUniversalTime().ToString("o")
  Set-Content -LiteralPath $markFile -Value $now -Encoding utf8
  Write-Host "marked $now"
  Write-Host "Now run the installer. Then re-run this script with -Collect."
  return
}

if (-not $Collect) {
  Write-Host "Usage: -Mark before the installer, then -Collect after it."
  return
}

Assert-Elevated

$since = (Get-Date).AddMinutes(-$SinceMinutes)
if (Test-Path -LiteralPath $markFile) {
  try {
    $since = [datetime]::Parse((Get-Content -LiteralPath $markFile -Raw).Trim()).ToLocalTime()
  } catch {
    Write-Warning "Mark file unreadable; falling back to -SinceMinutes $SinceMinutes."
  }
}

Emit "# Defender detection evidence"
Emit ""
Emit "Window start : $($since.ToUniversalTime().ToString('o'))"
Emit "Collected at : $((Get-Date).ToUniversalTime().ToString('o'))"
Emit "Machine      : $env:COMPUTERNAME"

# Defender's own state matters as much as the detections: a report from a machine with real-time
# protection off proves nothing about a machine that has it on.
try {
  $status = Get-MpComputerStatus
  Emit "RealTimeProtection=$($status.RealTimeProtectionEnabled) BehaviorMonitor=$($status.BehaviorMonitorEnabled) Engine=$($status.AMEngineVersion) Signatures=$($status.AntivirusSignatureVersion)"
} catch {
  Emit "Defender status unavailable: $($_.Exception.Message)"
}
Emit ""

Emit "## Threat detections (Get-MpThreatDetection)"
Emit ""
$detections = @()
try {
  $detections = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -ge $since })
} catch {
  Emit "unavailable: $($_.Exception.Message)"
}
if ($detections.Count -eq 0) {
  Emit "None in window."
} else {
  foreach ($d in $detections) {
    Emit "- $($d.InitialDetectionTime.ToUniversalTime().ToString('o'))"
    Emit "    ThreatID       : $($d.ThreatID)"
    Emit "    Action         : $($d.ActionSuccess) / cleaning=$($d.CleaningActionID)"
    Emit "    ProcessName    : $($d.ProcessName)"
    Emit "    DomainUser     : $($d.DomainUser)"
    foreach ($resource in @($d.Resources)) { Emit "    Resource       : $resource" }
  }
}
Emit ""

# The event log is the part that names the stage. 1116 is the detection, 1117 the action taken, and
# both carry Process Name and Path -- which is the field that says whether the elevated firewall
# script or an earlier unelevated one tripped it.
Emit "## Defender Operational log (1116 detected / 1117 actioned)"
Emit ""
$events = @()
try {
  $events = @(Get-WinEvent -FilterHashtable @{
    LogName   = "Microsoft-Windows-Windows Defender/Operational"
    Id        = 1116, 1117
    StartTime = $since
  } -ErrorAction SilentlyContinue)
} catch {
  Emit "unavailable: $($_.Exception.Message)"
}
if ($events.Count -eq 0) {
  Emit "None in window. If Get-MpThreatDetection also showed none, the installer ran without a detection."
} else {
  foreach ($e in $events) {
    Emit "- $($e.TimeCreated.ToUniversalTime().ToString('o'))  EventID=$($e.Id)"
    # The interesting fields are buried in the rendered message; keep the ones that identify the
    # stage and drop the boilerplate so the report stays readable in a plan file.
    foreach ($line in ($e.Message -split "`r?`n")) {
      $trimmed = $line.Trim()
      if ($trimmed -match '^(Name|Severity|Category|Path|Process Name|Detection Origin|Detection Type|Detection Source|Action|Status|Signature Version|Engine Version):') {
        Emit "    $trimmed"
      }
    }
  }
}
Emit ""

Emit "## Reading this"
Emit ""
# Single-quoted throughout: a backtick inside a double-quoted PowerShell string is an escape
# character, and the first draft of these lines was full of them.
Emit 'The Path and Process Name fields decide the next change:'
Emit '  - a Temp path with an NSIS plugin directory in it means a staged script tripped it'
Emit '  - which stage follows from the script name in that path'
Emit '  - powershell.exe as Process Name with a \Temp\ path is the stager shape itself,'
Emit '    not any one script content, which would mean relocating the scripts out of temp'
Emit '    rather than editing them'
Emit ""

if ($OutFile) {
  Set-Content -LiteralPath $OutFile -Value ($lines -join "`r`n") -Encoding utf8
  Write-Host ""
  Write-Host "written to $OutFile"
}
