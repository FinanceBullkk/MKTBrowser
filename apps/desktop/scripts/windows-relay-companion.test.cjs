const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const desktop = join(__dirname, "..");
const source = readFileSync(join(desktop, "build", "windows-relay-companion.ps1"), "utf8");
const q = (value) => `'${value.replaceAll("'", "''")}'`;

test("complete packaged helper scripts parse under Windows PowerShell without executing them", { skip: process.platform !== "win32" }, () => {
  for (const script of ["windows-relay-companion.ps1", "windows-startup-coordination.ps1"]) {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$tokens = $null; $errors = $null; $null = [Management.Automation.Language.Parser]::ParseFile(${q(join(desktop, "build", script))}, [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { throw 'Invalid packaged PowerShell syntax' }`],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  }
});

test("isolated PowerShell orchestration waits, starts once, rejects conflicts and refuses recreated direct login", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-companion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installer = join(root, "installer");
  const resources = join(root, "relay");
  const local = join(root, "local");
  const relayDirectory = join(local, "MKTTool-Relay");
  const startup = join(root, "Startup");
  for (const directory of [installer, resources, relayDirectory, startup]) mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from("synthetic fixture only; never launched");
  const relay = join(relayDirectory, "MKTTool-Relay.exe");
  const relayLauncher = join(relayDirectory, "start-mkttool-relay.cmd");
  writeFileSync(relay, bytes);
  writeFileSync(relayLauncher, "@echo off\r\n", "ascii");
  writeFileSync(join(resources, "relay-release.json"), JSON.stringify({ executableSizeBytes: bytes.length,
    executableSha256: createHash("sha256").update(bytes).digest("hex") }));
  writeFileSync(join(installer, "windows-install-conflict-detection.ps1"), "exit 0\n");
  // Exercise production orchestration/functions with a fake process table and launch sink.
  // The outer mutex entrypoint is separately checked below; no installed process is queried or run.
  const functions = source.slice(source.indexOf('$ErrorActionPreference = "Stop"'), source.indexOf("$mutex = $null"));
  const wrapper = join(installer, "fixture.ps1");
  writeFileSync(wrapper, `
$ExpectedBrowserPath = ${q(join(root, "MKTBrowser.exe"))}
$ExpectedBrowserProcessId = 1234
$StartupDirectory = ${q(startup)}
$env:LOCALAPPDATA = ${q(local)}
$fixtureRelay = ${q(relay)}
$fixtureRelayLauncher = ${q(relayLauncher)}
${functions}
$script:present = $false
$script:listening = $false
$script:foreign = $false
$script:browserGone = $false
$script:starts = 0
function Get-Process {
  [CmdletBinding()] param([string]$Name, [int]$Id)
  if ($Id -eq 1234) {
    if ($script:browserGone) { throw 'Browser exited' }
    return [pscustomobject]@{ Path = $ExpectedBrowserPath; Id = 1234 }
  }
  if ($script:present) {
    return [pscustomobject]@{ Path = $(if ($script:foreign) { $fixtureRelay + '.foreign' } else { $fixtureRelay }); Id = 55 }
  }
}
function Relay-Listener([string]$ExpectedPath) { return $script:listening }
function Start-Process {
  [CmdletBinding()] param([string]$FilePath, [string]$WorkingDirectory, [string]$WindowStyle)
  if ($FilePath -ne $fixtureRelayLauncher -or $WindowStyle -ne 'Hidden') { throw 'unexpected launch' }
  if ($env:RELAY_HOME -or $env:NODE_OPTIONS -or $env:NODE_EXTRA_CA_CERTS -or $env:NODE_USE_SYSTEM_CA -or $env:NODE_TLS_REJECT_UNAUTHORIZED -or $env:ELECTRON_RUN_AS_NODE) { throw 'unsafe inherited environment' }
  $script:starts += 1
  $script:present = $true
  $script:listening = $true
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$env:RELAY_HOME = 'wrong identity directory'
$env:NODE_OPTIONS = 'untrusted injection'
$env:NODE_EXTRA_CA_CERTS = 'untrusted CA path'
$env:NODE_USE_SYSTEM_CA = '1'
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
Assert ((Invoke-Companion) -eq 'started') 'fresh launch failed'
Assert ($script:starts -eq 1) 'fresh launch was not exactly once'
Assert ((Invoke-Companion) -eq 'running') 'existing owned listener failed'
Assert ($script:starts -eq 1) 'running Relay relaunched'
$script:listening = $false
Assert ((Invoke-Companion) -eq 'starting') 'starting process did not remain starting'
Assert ($script:starts -eq 1) 'starting process relaunched'
$script:foreign = $true
$rejected = $false
try { $null = Invoke-Companion } catch { $rejected = $true }
Assert $rejected 'foreign process was accepted'
Assert ($script:starts -eq 1) 'foreign process triggered launch'
$script:foreign = $false
$script:present = $false
$shell = New-Object -ComObject WScript.Shell
$link = Join-Path $StartupDirectory 'MKTTool Relay.lnk'
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $fixtureRelay
$shortcut.Arguments = ''
$shortcut.Save()
Assert ((Invoke-Companion) -eq 'blocked') 'direct startup allowed a new launch'
Assert ($script:starts -eq 1) 'direct startup triggered launch'
Remove-Item -LiteralPath $link -Force
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $fixtureRelayLauncher
$shortcut.Arguments = ''
$shortcut.Save()
Assert ((Invoke-Companion) -eq 'started') 'safe startup wrapper was not accepted'
Assert ($script:starts -eq 2) 'safe startup wrapper did not launch Relay'
$script:present = $false
$script:listening = $false
Remove-Item -LiteralPath $fixtureRelayLauncher -Force
Assert ((Invoke-Companion) -eq 'blocked') 'missing startup wrapper was accepted'
Assert ($script:starts -eq 2) 'missing startup wrapper triggered launch'
[IO.File]::WriteAllText($fixtureRelayLauncher, "@echo off" + [Environment]::NewLine, [Text.Encoding]::ASCII)
$script:present = $false
$script:listening = $false
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $fixtureRelayLauncher
$shortcut.Arguments = '--unsafe'
$shortcut.Save()
Assert ((Invoke-Companion) -eq 'blocked') 'wrapper arguments allowed a new launch'
Assert ($script:starts -eq 2) 'unsafe wrapper arguments triggered launch'
Remove-Item -LiteralPath $link -Force
$script:browserGone = $true
$rejected = $false
try { $null = Invoke-Companion } catch { $rejected = $true }
Assert $rejected 'exited Browser accepted'
Assert ($script:starts -eq 2) 'exited Browser triggered launch'
$script:browserGone = $false
[IO.File]::WriteAllText($fixtureRelay, 'changed bytes')
Assert ((Invoke-Companion) -eq 'blocked') 'wrong executable pin accepted'
Assert ($script:starts -eq 2) 'wrong pin triggered launch'
Remove-Item -LiteralPath $fixtureRelay -Force
Assert ((Invoke-Companion) -eq 'not-installed') 'missing Relay not reported'
Write-Output 'isolated-launcher-fixtures-passed'
`, "utf8");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
    encoding: "utf8", windowsHide: true, timeout: 25_000,
  });
  assert.match(output, /isolated-launcher-fixtures-passed/);
});

test("launcher is packaged, bounded, path/hash guarded and never mutates Relay identity", () => {
  const builder = readFileSync(join(desktop, "electron-builder-installer.yml"), "utf8");
  assert.match(builder, /from: build\/windows-relay-companion\.ps1[\s\S]*to: installer\/windows-relay-companion\.ps1/);
  assert.match(source, /Local\\MKTBrowser\.RelayCompanion\.\$sid/);
  assert.match(source, /\$mutex\.WaitOne\(0\)/);
  assert.match(source, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(source, /\(File-Sha256 \$relay\) -cne \$manifest\.executableSha256/);
  assert.match(source, /Get-Process -Id \$ExpectedBrowserProcessId/);
  assert.match(source, /Same-Path \$process\.Path \$ExpectedPath/);
  assert.match(source, /\$fields\[1\] -ne "127\.0\.0\.1:47821"/);
  assert.match(source, /Has-UnsafeRelayStartup \$relayLauncher/);
  assert.match(source, /start-mkttool-relay\.cmd/);
  assert.match(source, /Start-Process -FilePath \$relayLauncher -WorkingDirectory \$relayDirectory -WindowStyle Hidden/);
  assert.doesNotMatch(source, /Start-Process -FilePath \$relay\b/);
  assert.match(source, /\$shortcut\.Arguments -ceq ""/);
  assert.match(source, /AddSeconds\(8\)/);
  assert.match(source, /windows-install-conflict-detection\.ps1/);
  for (const variable of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
    assert.match(source, new RegExp(`\\$env:${variable} = \\$null`));
  }
  assert.doesNotMatch(source, /Stop-Process|taskkill|relay-config|device-key|Set-Content|New-Item|Remove-Item/);
  const manifest = JSON.parse(readFileSync(join(desktop, "relay-release.json"), "utf8"));
  assert.match(manifest.executableSha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.executableSizeBytes) && manifest.executableSizeBytes > 0);
  const packager = readFileSync(join(desktop, "scripts", "package-windows.cjs"), "utf8");
  assert.match(packager, /await verifyRelayExecutablePin\(archivePath, manifest\);\s+stageVerifiedRelayPayload/);
});
