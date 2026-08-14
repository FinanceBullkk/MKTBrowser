$ErrorActionPreference = "Stop"

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is unavailable."
}

$relayExe = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "MKTTool-Relay\MKTTool-Relay.exe")
)
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
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
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

Remove-Item -LiteralPath $relayExe -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $relayExe) {
  throw "The owned MKTTool Relay executable is still present."
}
