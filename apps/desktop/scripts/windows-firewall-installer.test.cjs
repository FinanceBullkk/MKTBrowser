const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const desktopRoot = join(__dirname, "..");
const installer = readFileSync(join(desktopRoot, "build", "installer.nsh"), "utf8");
const firewall = readFileSync(
  join(desktopRoot, "build", "windows-webrtc-firewall.ps1"),
  "utf8",
);
const relayCleanup = readFileSync(
  join(desktopRoot, "build", "windows-relay-cleanup.ps1"),
  "utf8",
);
const relayInstall = readFileSync(
  join(desktopRoot, "build", "windows-install-relay-payload.ps1"),
  "utf8",
);
const config = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
const installerConfig = readFileSync(
  join(desktopRoot, "electron-builder-installer.yml"),
  "utf8",
);

test("runs installer PowerShell from explicit script files instead of a staged command", () => {
  assert.match(config, /perMachine:\s*false/);
  assert.match(installer, /ExecShellWait "runas"/);
  assert.match(
    installer,
    /File \/oname=\$PLUGINSDIR\\windows-webrtc-firewall\.ps1[\s\S]*build\\windows-webrtc-firewall\.ps1/,
  );
  assert.match(
    installer,
    /File \/oname=\$PLUGINSDIR\\windows-install-relay-payload\.ps1[\s\S]*build\\windows-install-relay-payload\.ps1/,
  );
  assert.doesNotMatch(installer, /-EncodedCommand/);
  assert.doesNotMatch(installer, /\s-Command\s/);
  assert.doesNotMatch(installer, /ScriptBlock.*Create|GzipStream/);
  for (const mode of [
    "CheckProfiles",
    "CheckOwner",
    "Install",
    "Uninstall",
    "Verify",
    "VerifyAbsent",
  ]) {
    assert.match(installer, new RegExp(`windows-webrtc-firewall\\.ps1[^\\r\\n]*-Mode ${mode}`));
  }
  assert.doesNotMatch(installer, /SetEnvironmentVariable/);
  for (const engine of ["cft", "cloakbrowser"]) {
    assert.match(
      installer,
      new RegExp(`chromium\\\\${engine}\\\\runtime\\\\chrome\\.exe`, "i"),
    );
  }
  assert.match(firewall, /New-NetFirewallRule/);
  assert.match(firewall, /Direction Outbound/);
  assert.match(firewall, /Action Block/);
  assert.match(firewall, /Protocol UDP/);
  assert.match(firewall, /Profile Any/);
  // All three Windows firewall profiles must be named, or the rule must apply to every profile.
  // Replaces the COM bitmask check `($rule.Profiles -band 7) -ne 7`.
  assert.match(firewall, /foreach \(\$required in @\("Domain", "Private", "Public"\)\)/);
  assert.match(firewall, /firewall-profile-disabled/);
  // Defender quarantined the 23 Aug candidate as Behavior:Win32/PShellCobStager.A -- a behavioural
  // detection named for PowerShell COM staging. The elevated firewall script must never build a
  // COM object again; the NetSecurity cmdlets read the same state.
  // Asserted against code only: the file carries a comment telling the next reader not to bring
  // COM back, and a guard that trips on its own warning is a guard nobody keeps.
  const firewallCode = firewall.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(firewallCode, /New-Object\s+-ComObject/);
  assert.doesNotMatch(firewallCode, /HNetCfg\.FwPolicy2/);
  assert.match(firewall, /Get-NetFirewallApplicationFilter/);
  assert.match(firewall, /Get-NetFirewallPortFilter/);
  assert.match(firewall, /Get-NetFirewallProfile/);
  assert.match(firewall, /Assert-FirewallOwnership/);
  assert.match(firewall, /different-user-owner/);
  assert.match(installer, /verification failed \(code \$0\)/);
  assert.match(installer, /Windows Security > Firewall & network protection/);
});

test("removes only owned stale rules after verification and on uninstall", () => {
  assert.match(firewall, /MKT Browser WebRTC Protection/);
  assert.match(firewall, /Where-Object \{ \$_\.DisplayName -like 'MKT Browser WebRTC UDP Block \*'/);
  const finalVerificationAt = firewall.lastIndexOf("Assert-Rule $entry.Final $entry.Program");
  const staleCleanupAt = firewall.lastIndexOf("Get-NetFirewallRule -Group $group");
  assert.ok(finalVerificationAt >= 0 && staleCleanupAt > finalVerificationAt);
  assert.match(installer, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode Install/);
  assert.match(installer, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode CheckOwner/);
  assert.match(installer, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode Uninstall/);
  assert.match(installer, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode Verify/);
  assert.match(installer, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode VerifyAbsent/);
  const uninstallMacro = installer.match(/!macro customUnInstall[\s\S]*?!macroend/)?.[0];
  assert.ok(uninstallMacro);
  const firewallUninstallAt = uninstallMacro.indexOf("-Mode Uninstall");
  const relayCleanupAt = uninstallMacro.indexOf("windows-relay-cleanup.ps1");
  assert.ok(firewallUninstallAt >= 0 && relayCleanupAt > firewallUninstallAt);
  assert.match(installer, /pre-launch check refuses to run without the exact firewall rules/);
});

test("rejects another Windows user's firewall ownership before any mutation", () => {
  const ownerCheckAt = firewall.indexOf("Assert-FirewallOwnership $cft $cloak");
  const firstMutationAt = Math.min(
    firewall.indexOf("Remove-NetFirewallRule"),
    firewall.indexOf("New-NetFirewallRule"),
  );
  const preflight = installer.match(/Function MktBrowserInspectInstallConflicts[\s\S]*?FunctionEnd/)?.[0];
  assert.ok(preflight);
  assert.ok(ownerCheckAt >= 0 && firstMutationAt > ownerCheckAt);
  assert.match(preflight, /windows-webrtc-firewall\.ps1[^\r\n]*-Mode CheckOwner/);
  assert.match(preflight, /already installed for another Windows user/);
  assert.match(installer, /\$0 == 17[\s\S]*firewall protection was not changed/);
});

test("runs Relay uninstall cleanup from a parser-safe script file", () => {
  assert.match(installer, /File \/oname=\$PLUGINSDIR\\windows-relay-cleanup\.ps1/);
  assert.match(installer, /-File "\$PLUGINSDIR\\windows-relay-cleanup\.ps1"/);
  assert.doesNotMatch(installer, /GetFolderPath\(\$\\"Startup/);

  assert.match(relayCleanup, /GetFolderPath\("Startup"\)/);
  assert.match(relayCleanup, /GetFolderPath\("Desktop"\)/);
  assert.match(relayCleanup, /\.Equals\(\s*\$relayExe,\s*\[StringComparison\]::OrdinalIgnoreCase/s);
  assert.match(relayCleanup, /Get-Process -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(relayCleanup, /Get-CimInstance/);
  assert.match(relayCleanup, /Stop-Process -Id \$process\.Id -Force -ErrorAction Stop/);
  assert.match(relayCleanup, /Remove-Item -LiteralPath \$_\.FullName -Force -ErrorAction Stop/);
  assert.match(relayCleanup, /Ownership is unknown, so preserve the shortcut/);
  assert.match(relayCleanup, /owned MKTTool Relay shortcut could not be removed/);
  assert.match(relayCleanup, /Remove-Item -LiteralPath \$relayExe/);
  assert.doesNotMatch(relayCleanup, /relay-config\.json/);
});

test("Relay installer failures remain retryable without uninstalling local state", () => {
  const installMacro = installer.match(/!macro customInstall[\s\S]*?!macroend/)?.[0];
  assert.ok(installMacro);
  assert.match(installMacro, /windows-install-relay-payload\.ps1/);
  assert.match(installMacro, /-File "\$PLUGINSDIR\\windows-install-relay-payload\.ps1"/);
  assert.doesNotMatch(installMacro, /Expand-Archive|\s-Command\s/);
  assert.match(installMacro, /MKTTool Relay installation failed/);
  assert.doesNotMatch(installMacro, /windows-relay-cleanup/);
  assert.doesNotMatch(installMacro, /relay-config\.json/);
  assert.match(relayInstall, /Expand-Archive -LiteralPath \$archive/);
  assert.match(relayInstall, /relay-staging-outside-temp/);
  assert.match(relayInstall, /Test-Path -LiteralPath \$installer -PathType Leaf/);
  assert.match(relayInstall, /\$env:RELAY_SKIP_BROWSER = "1"/);
});

test("repairs an installed legacy uninstaller without losing Relay ownership", () => {
  assert.match(installer, /!macro customInit/);
  assert.match(installer, /MKT_BROWSER_INSTALLER_REPAIR_KEY/);
  assert.match(
    installer,
    /WriteRegDWORD HKEY_CURRENT_USER "\$\{UNINSTALL_REGISTRY_KEY\}" "RelayOwned" 0/,
  );
  const installAt = installer.indexOf("Installing verified MKTTool Relay payload");
  const restoreAt = installer.indexOf(
    'WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned" $2',
  );
  const cleanupAt = installer.indexOf(
    'DeleteRegKey HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}"',
  );
  assert.ok(installAt >= 0 && restoreAt > installAt && cleanupAt > restoreAt);
});

test("inherits the companion resource once and adds only installer payloads", () => {
  assert.match(config, /from: resources\/companion\s+to: companion/);
  assert.doesNotMatch(installerConfig, /resources\/companion/);
  assert.match(installerConfig, /from: \.relay-payload\/MKTTool-Relay\.zip/);
});
