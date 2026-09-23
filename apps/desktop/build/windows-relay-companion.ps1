param(
  [Parameter(Mandatory = $true)][string]$ExpectedBrowserPath,
  [Parameter(Mandatory = $true)][int]$ExpectedBrowserProcessId,
  [Parameter(Mandatory = $true)][string]$StartupDirectory
)

$ErrorActionPreference = "Stop"

function Same-Path([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}

function Is-Reparse-Path([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $false }
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function File-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}

function Relay-Processes([string]$ExpectedPath) {
  $owned = @()
  foreach ($process in @(Get-Process -Name "MKTTool-Relay" -ErrorAction SilentlyContinue)) {
    if (-not (Same-Path $process.Path $ExpectedPath)) { throw "unverified-process" }
    $owned += $process
  }
  return $owned
}

function Relay-Listener([string]$ExpectedPath) {
  $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
  $lines = @(& $netstat -ano -p tcp 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "listener-inspection-failed" }
  $found = $false
  foreach ($line in $lines) {
    $fields = $line.ToString().Trim() -split '\s+'
    if ($fields.Count -lt 5 -or $fields[0] -ine "TCP" -or $fields[3] -ine "LISTENING" -or $fields[1] -notmatch ':47821$') { continue }
    $process = Get-Process -Id ([int]$fields[4]) -ErrorAction Stop
    if (-not (Same-Path $process.Path $ExpectedPath)) { throw "unverified-listener" }
    if ($fields[1] -ne "127.0.0.1:47821") { throw "non-loopback-listener" }
    $found = $true
  }
  return $found
}

function Has-UnsafeRelayStartup([string]$ExpectedLauncherPath) {
  if (-not (Test-Path -LiteralPath $StartupDirectory)) { throw "startup-unavailable" }
  if (Is-Reparse-Path $StartupDirectory) { throw "startup-unverified" }
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($link in @(Get-ChildItem -LiteralPath $StartupDirectory -Filter '*.lnk' -File)) {
      if (Is-Reparse-Path $link.FullName) { return $true }
      $shortcut = $shell.CreateShortcut($link.FullName)
      try {
        $target = $shortcut.TargetPath
        $isCanonicalLink = $link.Name -ieq "MKTTool Relay.lnk"
        $targetName = [IO.Path]::GetFileName($target)
        $isRelayTarget = $targetName -ieq "MKTTool-Relay.exe" -or $targetName -ieq "start-mkttool-relay.cmd"
        if (-not ($isCanonicalLink -or $isRelayTarget)) { continue }

        if ($isCanonicalLink -and
            (Same-Path $target $ExpectedLauncherPath) -and
            $shortcut.Arguments -ceq "" -and
            -not (Is-Reparse-Path (Split-Path -Parent $ExpectedLauncherPath)) -and
            -not (Is-Reparse-Path $ExpectedLauncherPath)) {
          continue
        }
        # Direct Relay targets and any mismatched/duplicate wrapper entry are never a safe companion state.
        return $true
      } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
      }
    }
    return $false
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}

function Invoke-Companion {
  if (-not $env:LOCALAPPDATA -or -not $env:SystemRoot) { return "blocked" }
  $relayDirectory = Join-Path $env:LOCALAPPDATA "MKTTool-Relay"
  $relay = Join-Path $relayDirectory "MKTTool-Relay.exe"
  $relayLauncher = Join-Path $relayDirectory "start-mkttool-relay.cmd"
  if (-not (Test-Path -LiteralPath $relay -PathType Leaf)) { return "not-installed" }
  if (-not (Test-Path -LiteralPath $relayLauncher -PathType Leaf)) { return "blocked" }
  foreach ($path in @($relayDirectory, $relay, $relayLauncher)) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { return "blocked" }
  }
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\relay\relay-release.json") -Raw | ConvertFrom-Json
  if ($manifest.executableSha256 -cnotmatch '^[0-9a-f]{64}$' -or $manifest.executableSizeBytes -le 0) { return "blocked" }
  if ((Get-Item -LiteralPath $relay).Length -ne $manifest.executableSizeBytes -or
      (File-Sha256 $relay) -cne $manifest.executableSha256) { return "blocked" }

  $detector = Join-Path $PSScriptRoot "windows-install-conflict-detection.ps1"
  $null = & $detector -ExpectedBrowserPath $ExpectedBrowserPath -ExpectedRelayPath $relay -StartupDirectory $StartupDirectory -RuntimeInspection 2>&1
  if ($LASTEXITCODE -ne 0) { return "blocked" }

  $started = $false
  $processes = @(Relay-Processes $relay)
  if (Relay-Listener $relay) { return "running" }
  if ($processes.Count -eq 0) {
    if (Has-UnsafeRelayStartup $relayLauncher) { return "blocked" }
    $processes = @(Relay-Processes $relay)
    if (Relay-Listener $relay) { return "running" }
    if ($processes.Count -eq 0) {
      $browserProcess = Get-Process -Id $ExpectedBrowserProcessId -ErrorAction Stop
      if (-not (Same-Path $browserProcess.Path $ExpectedBrowserPath)) { return "blocked" }
      # Never inherit development identity or TLS/Node overrides into the installed Relay.
      $env:RELAY_HOME = $null
      $env:NODE_OPTIONS = $null
      $env:NODE_EXTRA_CA_CERTS = $null
      $env:NODE_USE_SYSTEM_CA = $null
      $env:NODE_TLS_REJECT_UNAUTHORIZED = $null
      $env:ELECTRON_RUN_AS_NODE = $null
      Start-Process -FilePath $relayLauncher -WorkingDirectory $relayDirectory -WindowStyle Hidden -ErrorAction Stop
      $started = $true
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    if (Relay-Listener $relay) { if ($started) { return "started" } else { return "running" } }
    $null = @(Relay-Processes $relay)
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  # A timeout is diagnostic, never permission to create a second Relay process.
  return "starting"
}

$mutex = $null
$acquired = $false
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = New-Object Threading.Mutex($false, "Local\MKTBrowser.RelayCompanion.$sid")
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  $status = if ($acquired) { Invoke-Companion } else { "starting" }
  @{ status = $status } | ConvertTo-Json -Compress
} catch {
  @{ status = "blocked" } | ConvertTo-Json -Compress
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
