$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is unavailable."
}

$relayExe = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "MKTTool-Relay\MKTTool-Relay.exe")
)

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

foreach ($folder in $shortcutFolders) {
  Get-ChildItem -LiteralPath $folder -Filter "*.lnk" -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      $isOwned = $false
      try {
        $target = $shell.CreateShortcut($_.FullName).TargetPath
        $isOwned = $target -and [IO.Path]::GetFullPath($target).Equals(
          $relayExe,
          [StringComparison]::OrdinalIgnoreCase
        )
      } catch {
        # Ownership is unknown, so preserve the shortcut.
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

# A scanner or the loader can hold a briefly surviving handle after the process is gone, so retry
# rather than deciding on the first attempt. The throw still fails the uninstall closed if the file
# genuinely cannot be removed.
$removeDeadline = [DateTime]::UtcNow.AddSeconds(15)
while ($true) {
  Remove-Item -LiteralPath $relayExe -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $relayExe)) {
    break
  }
  if ([DateTime]::UtcNow -ge $removeDeadline) {
    throw "The owned MKTTool Relay executable is still present."
  }
  Start-Sleep -Milliseconds 250
}
