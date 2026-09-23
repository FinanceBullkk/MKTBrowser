$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is unavailable."
}

$relayDirectory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "MKTTool-Relay"))
$relayExe = [IO.Path]::GetFullPath((Join-Path $relayDirectory "MKTTool-Relay.exe"))
$relayLauncher = [IO.Path]::GetFullPath((Join-Path $relayDirectory "start-mkttool-relay.cmd"))

function Same-Path([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}

function Is-Reparse-Path([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $false }
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

if (Is-Reparse-Path $relayDirectory) {
  throw "The owned MKTTool Relay directory could not be verified safely."
}
foreach ($path in @($relayExe, $relayLauncher)) {
  if (Is-Reparse-Path $path) {
    throw "An owned MKTTool Relay artifact could not be verified safely."
  }
}

<#
  Resolving which processes are the owned Relay needs two independent sources, because each one
  fails on its own in a situation the uninstaller actually meets.

  NSIS is a 32-bit application, so the powershell.exe it launches is the 32-bit host under WOW64.
  `System.Diagnostics.Process.Path` reads the target's module list, which a 32-bit process cannot do
  for a 64-bit process: it throws. The earlier version had only that source and read the throw as
  "not the Relay", so the Relay was never stopped, the delete below failed against a running image,
  and every ordinary uninstall aborted naming an executable it believed it had handled. Running the
  script under the 64-bit host passed, which is why no gate caught it.

  Win32_Process.ExecutablePath comes through WMI and is bitness independent, but it yields nothing
  when the WMI service is unavailable. So: ask both, and act on the union.

  A process whose path neither source can resolve is left alone. Ownership that cannot be proved is
  not ownership, and killing an unidentified process would break the guarantee that a Relay this
  installer does not own is never touched.
#>
$ownedProcessIds = New-Object System.Collections.Generic.HashSet[int]

Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
  ForEach-Object {
    if ($_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
      $relayExe,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      [void]$ownedProcessIds.Add([int]$_.ProcessId)
    }
  }

Get-Process -ErrorAction SilentlyContinue |
  ForEach-Object {
    $process = $_
    try {
      $processPath = $process.Path
    } catch {
      $processPath = $null
    }
    if ($processPath -and [IO.Path]::GetFullPath($processPath).Equals(
      $relayExe,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      [void]$ownedProcessIds.Add([int]$process.Id)
    }
  }

foreach ($processId in $ownedProcessIds) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

# Stop-Process only signals termination; Windows keeps the image locked until the process has gone.
# Waiting on process identity rather than on the file keeps the failure message specific when a
# process refuses to die.
$exitDeadline = [DateTime]::UtcNow.AddSeconds(15)
foreach ($processId in $ownedProcessIds) {
  while ($true) {
    $stillRunning = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $stillRunning) {
      break
    }
    if ([DateTime]::UtcNow -ge $exitDeadline) {
      throw "The owned MKTTool Relay process $processId did not exit after being stopped."
    }
    Start-Sleep -Milliseconds 200
  }
}

$shell = New-Object -ComObject WScript.Shell
$shortcutFolders = @(
  [Environment]::GetFolderPath("Startup"),
  [Environment]::GetFolderPath("Desktop")
)

try {
  foreach ($folder in $shortcutFolders) {
    if (-not (Test-Path -LiteralPath $folder) -or (Is-Reparse-Path $folder)) { continue }
    Get-ChildItem -LiteralPath $folder -Filter "*.lnk" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        $isOwned = $false
        $shortcut = $null
        try {
          if (-not (Is-Reparse-Path $_.FullName)) {
            $shortcut = $shell.CreateShortcut($_.FullName)
            $target = $shortcut.TargetPath
            $targetIsOwned = (Same-Path $target $relayExe) -or (Same-Path $target $relayLauncher)
            $targetParent = if ($target) { Split-Path -Parent $target } else { "" }
            $isOwned = $targetIsOwned -and
              $shortcut.Arguments -ceq "" -and
              -not (Is-Reparse-Path $targetParent) -and
              -not (Is-Reparse-Path $target)
          }
        } catch {
          # Ownership is unknown, so preserve the shortcut.
          $isOwned = $false
        } finally {
          if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        }
        if ($isOwned) {
          try {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
          } catch {
            throw "An owned MKTTool Relay shortcut could not be removed."
          }
        }
      }
  }
} finally {
  if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Remove-OwnedRelayArtifact([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ((Get-Item -LiteralPath $Path -Force).PSIsContainer -or (Is-Reparse-Path $Path)) {
    throw "The owned MKTTool Relay $Label could not be verified safely."
  }

  # A scanner or loader can hold a briefly surviving handle after process exit. Retry, but fail closed.
  $removeDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($true) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ([DateTime]::UtcNow -ge $removeDeadline) {
      throw "The owned MKTTool Relay $Label is still present."
    }
    Start-Sleep -Milliseconds 250
  }
}

Remove-OwnedRelayArtifact $relayExe "executable"
Remove-OwnedRelayArtifact $relayLauncher "startup wrapper"
