param(
    [Parameter(Mandatory = $true)][string]$ExpectedBrowserPath,
    [Parameter(Mandatory = $true)][string]$ExpectedRelayPath,
    [Parameter(Mandatory = $true)][string]$StartupDirectory,
    [switch]$RepairOwnedShortcuts,
    [switch]$RuntimeInspection,
    [string]$InventoryPath
)

$ErrorActionPreference = "Stop"

function Normalize-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals(
        (Normalize-Path $Left),
        (Normalize-Path $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Stop-With([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine($Message)
    exit $Code
}

<#
  NSIS is a 32-bit application, so the powershell.exe it launches is the 32-bit host under WOW64.
  `System.Diagnostics.Process.Path` reads the target's module list, which a 32-bit process cannot do
  for a 64-bit process: it throws. This script had only that source and read the throw as "no
  path", so the running 64-bit Relay resolved to nothing and every repair or upgrade over a normal
  installation stopped with "MKTTool Relay is running, but its executable ownership could not be
  verified" — refusing a Relay this script is explicitly told to allow (Assert-Named-Processes is
  called for it with $AllowExpectedPath true). Installing starts the Relay, so operators met this on
  the ordinary path. Under the 64-bit host it passed, which is why no gate caught it.

  QueryFullProcessImageName asks the kernel for the image path instead of reading the target's
  modules, so it is bitness independent, and PROCESS_QUERY_LIMITED_INFORMATION is available to the
  same user without elevation. That matters here: this preflight deliberately avoids privileged CIM
  (see the netstat parsing above), and must keep working for a standard user.

  A process neither source can resolve is still treated as unverified and still refused. Ownership
  that cannot be proved is not ownership.
#>
Add-Type -Namespace MktBrowser -Name NativeProcessPath -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(int access, bool inherit, int processId);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool QueryFullProcessImageNameW(IntPtr handle, int flags, System.Text.StringBuilder path, ref int size);
'@

function Native-Process-Path([int]$ProcessId) {
    $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    try {
        $handle = [MktBrowser.NativeProcessPath]::OpenProcess(
            $PROCESS_QUERY_LIMITED_INFORMATION, $false, $ProcessId
        )
    } catch {
        return $null
    }
    if ($handle -eq [IntPtr]::Zero) { return $null }
    try {
        $size = 1024
        $buffer = New-Object System.Text.StringBuilder $size
        if ([MktBrowser.NativeProcessPath]::QueryFullProcessImageNameW($handle, 0, $buffer, [ref]$size)) {
            return $buffer.ToString()
        }
        return $null
    } catch {
        return $null
    } finally {
        [void][MktBrowser.NativeProcessPath]::CloseHandle($handle)
    }
}

function Process-Path([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace($process.Path)) { return $process.Path }
    } catch {
        # 32-bit host cannot read a 64-bit target's module list; fall through to the kernel query.
    }
    return Native-Process-Path $ProcessId
}

function Assert-Named-Processes(
    [string]$ExecutableName,
    [string]$ExpectedPath,
    [bool]$AllowExpectedPath,
    [int]$Code,
    [string]$Label,
    [object]$Inventory
) {
    if ($null -ne $Inventory) {
        $processes = @($Inventory.Processes | Where-Object {
            [IO.Path]::GetFileName($_.Path) -ieq $ExecutableName
        })
    } else {
        $processName = [IO.Path]::GetFileNameWithoutExtension($ExecutableName)
        $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
    }
    foreach ($process in $processes) {
        $executablePath = if ($null -ne $Inventory) { $process.Path } else { Process-Path $process.Id }
        if ([string]::IsNullOrWhiteSpace($executablePath)) {
            Stop-With $Code "$Label is running, but its executable ownership could not be verified. Safe action: close it in Task Manager, then retry."
        }
        if (-not (Same-Path $executablePath $ExpectedPath)) {
            Stop-With $Code "A different $Label installation is running. Safe action: close that process; do not delete its files, then retry."
        }
        if (-not $AllowExpectedPath) {
            if ($Label -eq "MKT Browser") {
                Stop-With $Code "MKT Browser is running. Safe action: choose Quit MKT Browser from its system tray menu, then retry. Closing its window only keeps it running in the background; profiles and data will be preserved."
            }
            Stop-With $Code "$Label is running. Safe action: close it, then retry. Its profiles and data will be preserved."
        }
    }
}

function Has-Named-Process([string]$ExecutableName, [object]$Inventory) {
    if ($null -ne $Inventory) {
        return @($Inventory.Processes | Where-Object {
            [IO.Path]::GetFileName($_.Path) -ieq $ExecutableName
        }).Count -gt 0
    }
    $processName = [IO.Path]::GetFileNameWithoutExtension($ExecutableName)
    return @(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count -gt 0
}

function Tcp-Listeners([object]$Inventory) {
    if ($null -ne $Inventory) { return @($Inventory.Listeners) }
    if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        throw "SystemRoot is unavailable."
    }
    $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    $lines = @(& $netstat -ano -p tcp 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "netstat exited with code $LASTEXITCODE."
    }

    return @($lines | ForEach-Object {
        $fields = $_.ToString().Trim() -split '\s+'
        if ($fields.Count -lt 5 -or $fields[0] -ine "TCP" -or $fields[3] -ine "LISTENING") {
            return
        }

        $portMatch = [regex]::Match($fields[1], ':(\d+)$')
        if (-not $portMatch.Success) { return }

        $processId = 0
        if (-not [int]::TryParse($fields[4], [ref]$processId)) { return }
        [pscustomobject]@{
            LocalPort = [int]$portMatch.Groups[1].Value
            OwningProcess = $processId
        }
    })
}

function Assert-Listener(
    [object[]]$Listeners,
    [int]$Port,
    [string]$ExpectedPath,
    [bool]$AllowExpectedPath,
    [int]$Code,
    [string]$Label
) {
    $listeners = @($Listeners | Where-Object { $_.LocalPort -eq $Port })
    foreach ($listener in $listeners) {
        $ownerPath = if ($null -ne $listener.OwnerPath) {
            $listener.OwnerPath
        } else {
            Process-Path $listener.OwningProcess
        }
        if (-not $ownerPath -or -not $AllowExpectedPath -or -not (Same-Path $ownerPath $ExpectedPath)) {
            Stop-With $Code "Port $Port is already used by an unverified process, so the $Label layer cannot start safely. Safe action: identify and close that listener, then retry."
        }
    }
}

function Shortcut-Targets([string]$Directory, [object]$Inventory) {
    if ($null -ne $Inventory) { return @($Inventory.Shortcuts) }
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    $shell = New-Object -ComObject WScript.Shell
    try {
        return @(Get-ChildItem -LiteralPath $Directory -Filter '*.lnk' -File | ForEach-Object {
            $shortcut = $shell.CreateShortcut($_.FullName)
            [pscustomobject]@{ Link = $_.FullName; Target = $shortcut.TargetPath }
        })
    } finally {
        if ([Runtime.InteropServices.Marshal]::IsComObject($shell)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
}

function Assert-Shortcuts(
    [object[]]$Shortcuts,
    [string]$ExecutableName,
    [string]$ExpectedPath,
    [string]$CanonicalLink,
    [int]$Code,
    [string]$Label
) {
    $matches = @($Shortcuts | Where-Object {
        [IO.Path]::GetFileName($_.Target) -ieq $ExecutableName
    })
    $unexpected = @($matches | Where-Object { -not (Same-Path $_.Target $ExpectedPath) })
    if ($unexpected.Count -gt 0) {
        Stop-With $Code "A startup entry points to a different $Label installation. Safe action: disable that entry in Windows Startup Apps, then retry."
    }

    $ownedDuplicates = @($matches | Where-Object {
        (Same-Path $_.Target $ExpectedPath) -and -not (Same-Path $_.Link $CanonicalLink)
    })
    if (-not $RepairOwnedShortcuts -and ($ownedDuplicates.Count -gt 0 -or $matches.Count -gt 1)) {
        Stop-With $Code "Duplicate $Label startup entries were found. Safe action: run installer repair, then retry."
    }
    return $ownedDuplicates
}

function Repair-OwnedShortcuts([object[]]$Duplicates, [string]$Label) {
    foreach ($duplicate in $Duplicates) {
        try {
            Remove-Item -LiteralPath $duplicate.Link -Force -ErrorAction Stop
        } catch {
            Stop-With 28 "An owned duplicate $Label startup entry could not be repaired. Safe action: close Startup Apps or Explorer windows, then run the installer again."
        }
    }
}

try {
    $inventory = $null
    if (-not [string]::IsNullOrWhiteSpace($InventoryPath)) {
        $inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
        if ($null -eq $inventory.Processes -or
            $null -eq $inventory.Listeners -or
            $null -eq $inventory.Shortcuts) {
            throw "invalid inventory"
        }
    }
    $allowExpectedBrowser = $RuntimeInspection.IsPresent
    Assert-Named-Processes "MKTBrowser.exe" $ExpectedBrowserPath $allowExpectedBrowser 20 "MKT Browser" $inventory
    Assert-Named-Processes "MKTTool-Relay.exe" $ExpectedRelayPath $true 21 "MKTTool Relay" $inventory

    if (Has-Named-Process "MultiZen.exe" $inventory) {
        Stop-With 24 "MultiZen is running. Safe action: close MultiZen first; its profiles and data will be preserved."
    }

    $listeners = @(Tcp-Listeners $inventory)
    Assert-Listener $listeners 47821 $ExpectedRelayPath $true 22 "Relay"
    Assert-Listener $listeners 47822 $ExpectedBrowserPath $allowExpectedBrowser 23 "Browser MCP"

    $shortcuts = Shortcut-Targets $StartupDirectory $inventory
    $browserDuplicates = @(Assert-Shortcuts $shortcuts "MKTBrowser.exe" $ExpectedBrowserPath (Join-Path $StartupDirectory "MKT Browser.lnk") 25 "MKT Browser")
    $relayDuplicates = @(Assert-Shortcuts $shortcuts "MKTTool-Relay.exe" $ExpectedRelayPath (Join-Path $StartupDirectory "MKTTool Relay.lnk") 26 "MKTTool Relay")

    if ($RepairOwnedShortcuts) {
        Repair-OwnedShortcuts $browserDuplicates "MKT Browser"
        Repair-OwnedShortcuts $relayDuplicates "MKTTool Relay"
    }
} catch {
    Stop-With 27 "Windows installation conflicts could not be inspected safely. Safe action: close MKT Browser, Relay, and MultiZen, then retry."
}

Write-Output "Existing-install inspection passed; MultiZen data was not modified."
exit 0
