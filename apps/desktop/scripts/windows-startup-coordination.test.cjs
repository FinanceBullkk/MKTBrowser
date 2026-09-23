const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const desktop = join(__dirname, "..");
const script = join(desktop, "build", "windows-startup-coordination.ps1");
const q = (value) => `'${value.replaceAll("'", "''")}'`;

function runFixture(t, actions) {
  const root = mkdtempSync(join(tmpdir(), "mkt-startup-coordination-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const startup = join(root, "Startup");
  mkdirSync(startup);
  const browser = join(root, "MKTBrowser.exe");
  const relay = join(root, "MKTTool-Relay.exe");
  const relayLauncher = join(root, "start-mkttool-relay.cmd");
  writeFileSync(browser, "fixture, never executable");
  writeFileSync(relay, "fixture, never executable");
  writeFileSync(relayLauncher, "@echo off\r\n", "ascii");
  const wrapper = join(root, "fixture.ps1");
  writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$script = ${q(script)}
$startup = ${q(startup)}
$browser = ${q(browser)}
$relay = ${q(relay)}
$relayLauncher = ${q(relayLauncher)}
$browserLink = Join-Path $startup 'MKT Browser.lnk'
$relayLink = Join-Path $startup 'MKTTool Relay.lnk'
$shell = New-Object -ComObject WScript.Shell
function Link([string]$Path, [string]$Target, [string]$Arguments) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.Save()
}
function Run([string]$Mode) {
  & $script -Mode $Mode -ExpectedBrowserPath $browser -ExpectedRelayPath $relay -StartupDirectory $startup
  return $LASTEXITCODE
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
${actions}
`, "utf8");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
}

test("upgrades a legacy direct Relay entry and restores only the safe wrapper", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Link $relayLink $relay ''
$desktopLink = Join-Path $startup 'Unrelated.lnk'
Link $desktopLink $browser ''
# Setup preflight may admit the exact legacy target, but the Relay payload must replace it first.
Assert ((Run 'Preflight')[-1] -eq 0) 'legacy preflight failed'
Link $relayLink $relayLauncher ''
Assert ((Run 'Takeover')[-1] -eq 0) 'takeover failed'
Assert (-not (Test-Path -LiteralPath $relayLink)) 'direct Relay login remains'
Assert ($shell.CreateShortcut($browserLink).TargetPath -eq $browser) 'Browser target changed'
Assert ($shell.CreateShortcut($browserLink).Arguments -ceq '--background') 'Browser not background'
Assert (Test-Path -LiteralPath $desktopLink) 'unrelated link changed'
Assert ((Run 'Takeover')[-1] -eq 0) 'repeat takeover failed'
Assert ((Run 'Restore')[-1] -eq 0) 'restore failed'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $relayLauncher) 'Relay wrapper not restored'
Assert ($shell.CreateShortcut($relayLink).Arguments -ceq '') 'Relay arguments changed'
Assert ((Run 'Restore')[-1] -eq 0) 'repeat restore failed'
Assert ((Run 'RemoveBrowser')[-1] -eq 0) 'Browser removal failed'
Assert (-not (Test-Path -LiteralPath $browserLink)) 'Browser startup remains'
Assert (Test-Path -LiteralPath $relayLink) 'retained Relay startup removed'
`);
});

test("read-only preflight verifies canonical targets and arguments before any link can be overwritten", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Link $relayLink $relay ''
Link $browserLink $browser '--background'
$relayBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($relayLink))
$browserBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($browserLink))
Assert ((Run 'Preflight')[-1] -eq 0) 'valid preflight failed'
Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($relayLink)) -ceq $relayBytes) 'preflight changed Relay link'
Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($browserLink)) -ceq $browserBytes) 'preflight changed Browser link'
$shortcut = $shell.CreateShortcut($relayLink)
$shortcut.TargetPath = $relayLauncher
$shortcut.Arguments = ''
$shortcut.Save()
Assert ((Run 'Preflight')[-1] -eq 0) 'safe Relay wrapper preflight failed'
$foreign = Join-Path (Split-Path $relay) 'notepad.exe'
Link $relayLink $foreign ''
Assert ((Run 'Preflight')[-1] -eq 1) 'canonical Relay alias with foreign basename accepted'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $foreign) 'foreign Relay link overwritten'
Link $relayLink $relay '--unexpected'
Assert ((Run 'Preflight')[-1] -eq 1) 'canonical Relay arguments accepted'
Assert ($shell.CreateShortcut($relayLink).Arguments -ceq '--unexpected') 'Relay arguments changed'
Link $relayLink $relayLauncher '--unexpected'
Assert ((Run 'Preflight')[-1] -eq 1) 'safe Relay wrapper arguments accepted'
Assert ($shell.CreateShortcut($relayLink).Arguments -ceq '--unexpected') 'Relay wrapper arguments changed'
Link $relayLink $relay ''
Link $browserLink $foreign ''
Assert ((Run 'Preflight')[-1] -eq 1) 'canonical Browser alias with foreign basename accepted'
Assert ($shell.CreateShortcut($browserLink).TargetPath -eq $foreign) 'foreign Browser link overwritten'
Link $browserLink $browser '--unexpected'
Assert ((Run 'Preflight')[-1] -eq 1) 'canonical Browser arguments accepted'
Remove-Item -LiteralPath $browserLink, $relayLink, $browser, $relay -Force
Assert ((Run 'Preflight')[-1] -eq 0) 'fresh install with missing targets rejected'
Remove-Item -LiteralPath $startup -Force
Assert ((Run 'Preflight')[-1] -eq 0) 'fresh install with missing Startup directory rejected'
Assert (-not (Test-Path -LiteralPath $startup)) 'read-only preflight created Startup directory'
`);
});

test("foreign, direct, or malformed Relay startup entries prevent takeover before Browser shortcut mutation", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Link $relayLink ($relay + '.foreign.exe') ''
$failure = Run 'Takeover'
Assert ($failure[-1] -eq 1) 'foreign Relay accepted'
Assert (-not (Test-Path -LiteralPath $browserLink)) 'Browser entry changed before validation'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq ($relay + '.foreign.exe')) 'foreign link overwritten'
Link $relayLink $relay '--unexpected'
Assert ((Run 'Takeover')[-1] -eq 1) 'Relay arguments accepted'
Assert ($shell.CreateShortcut($relayLink).Arguments -ceq '--unexpected') 'arguments overwritten'
Link $relayLink $relay ''
Assert ((Run 'Takeover')[-1] -eq 1) 'legacy direct Relay target accepted after payload'
Assert (-not (Test-Path -LiteralPath $browserLink)) 'Browser entry changed before unsafe direct rejection'
Link $relayLink $relayLauncher ''
Remove-Item -LiteralPath $relayLauncher -Force
Assert ((Run 'Takeover')[-1] -eq 1) 'missing safe wrapper accepted'
Assert (Test-Path -LiteralPath $relayLink) 'Relay link removed without a safe wrapper'
`);
});

test("a safe Relay wrapper requires its expected executable before setup can take over startup", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Link $relayLink $relayLauncher ''
Remove-Item -LiteralPath $relay -Force
Assert ((Run 'Preflight')[-1] -eq 1) 'wrapper with no Relay executable passed preflight'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $relayLauncher) 'preflight changed the wrapper shortcut'
Assert ((Run 'Takeover')[-1] -eq 1) 'wrapper with no Relay executable allowed takeover'
Assert (-not (Test-Path -LiteralPath $browserLink)) 'Browser startup changed before Relay executable verification'
`);
});

test("foreign Browser startup or foreign retained Relay entry is never overwritten", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Link $relayLink $relayLauncher ''
Link $browserLink ($browser + '.foreign.exe') ''
Assert ((Run 'Takeover')[-1] -eq 1) 'foreign Browser accepted'
Assert (Test-Path -LiteralPath $relayLink) 'Relay removed after Browser conflict'
Link $relayLink ($relayLauncher + '.foreign.cmd') ''
Assert ((Run 'Restore')[-1] -eq 1) 'foreign restore accepted'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq ($relayLauncher + '.foreign.cmd')) 'foreign Relay overwritten'
Assert ((Run 'RemoveBrowser')[-1] -eq 1) 'foreign Browser removal accepted'
Assert ($shell.CreateShortcut($browserLink).TargetPath -eq ($browser + '.foreign.exe')) 'foreign Browser removed'
`);
});

test("uninstall restores only a verified wrapper and skips a separately removed Relay", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Remove-Item -LiteralPath $relay -Force
Remove-Item -LiteralPath $relayLauncher -Force
Assert ((Run 'Restore')[-1] -eq 0) 'missing standalone Relay blocked Browser uninstall'
Assert (-not (Test-Path -LiteralPath $relayLink)) 'startup recreated for absent Relay'
New-Item -ItemType File -Path $relay | Out-Null
New-Item -ItemType File -Path $relayLauncher | Out-Null
Assert ((Run 'Restore')[-1] -eq 0) 'safe Relay wrapper was not restored'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $relayLauncher) 'unsafe Relay target restored'
Remove-Item -LiteralPath $relayLink -Force
Link $relayLink $relay ''
Assert ((Run 'Restore')[-1] -eq 1) 'legacy direct Relay was accepted during restore'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $relay) 'legacy direct Relay rewritten'
Remove-Item -LiteralPath $relayLink -Force
Link $relayLink $relayLauncher ''
Assert ((Run 'Restore')[-1] -eq 0) 'owned stale shortcut blocked Browser uninstall'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq $relayLauncher) 'owned safe shortcut changed'
Link $relayLink ($relayLauncher + '.foreign.cmd') ''
Assert ((Run 'Restore')[-1] -eq 1) 'missing Relay bypassed foreign link validation'
Assert ($shell.CreateShortcut($relayLink).TargetPath -eq ($relayLauncher + '.foreign.cmd')) 'foreign link changed'
`);
});

test("Browser removal tolerates an absent Startup directory but refuses an existing file", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Remove-Item -LiteralPath $startup -Force
Assert ((Run 'RemoveBrowser')[-1] -eq 0) 'missing Startup blocked uninstall'
Assert (-not (Test-Path -LiteralPath $startup)) 'uninstall recreated Startup'
[IO.File]::WriteAllText($startup, 'unrelated file')
Assert ((Run 'RemoveBrowser')[-1] -eq 1) 'file accepted as absent directory'
Assert ([IO.File]::ReadAllText($startup) -ceq 'unrelated file') 'unrelated file changed'
`);
});

test("Browser removal refuses a Startup junction and preserves the target shortcut", { skip: process.platform !== "win32" }, (t) => {
  runFixture(t, `
Remove-Item -LiteralPath $startup -Force
$target = Join-Path (Split-Path $startup) 'ForeignStartup'
$null = New-Item -ItemType Directory -Path $target
$foreignLink = Join-Path $target 'MKT Browser.lnk'
Link $foreignLink $browser '--background'
$null = New-Item -ItemType Junction -Path $startup -Target $target
Assert ((Run 'RemoveBrowser')[-1] -eq 1) 'junction accepted as owned directory'
Assert (Test-Path -LiteralPath $foreignLink) 'target shortcut removed'
`);
});

test("installer tracks takeover separately from Relay executable cleanup ownership", () => {
  const installer = readFileSync(join(desktop, "build", "installer.nsh"), "utf8");
  const takeOverAt = installer.indexOf('-Mode Takeover');
  const managedAt = installer.indexOf('"RelayStartupManaged" 1');
  assert.ok(takeOverAt > 0 && managedAt > takeOverAt);
  assert.match(installer, /\$2 == 1[\s\S]*windows-relay-cleanup\.ps1[\s\S]*\$\{Else\}[\s\S]*"RelayStartupManaged"[\s\S]*-Mode Restore/);
  const source = readFileSync(script, "utf8");
  assert.match(source, /start-mkttool-relay\.cmd/);
  assert.match(source, /Assert-RelayShortcut \$relayLink \$relayLauncher \$ExpectedRelayPath \$false[\s\S]*Assert-RelayLauncher-Available \$relayLauncher[\s\S]*Save-Shortcut \$browserLink \$ExpectedBrowserPath "--background"[\s\S]*Remove-Item -LiteralPath \$relayLink/);
  assert.match(source, /Save-Shortcut \$relayLink \$relayLauncher ""/);
  assert.doesNotMatch(source, /Save-Shortcut \$relayLink \$ExpectedRelayPath ""/);
  assert.doesNotMatch(source, /Stop-Process|Start-Process|relay-config|Recurse/);
});
