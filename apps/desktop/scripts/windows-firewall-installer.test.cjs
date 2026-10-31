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
  // -ExecutionPolicy Bypass is the flag malware reaches for, and Defender's behavioural engine
  // weighs it. RemoteSigned permits a locally written unsigned script just the same -- NSIS `File`
  // extraction carries no Mark-of-the-Web -- and was measured to run this script to exit 0.
  assert.doesNotMatch(installer, /-ExecutionPolicy Bypass/);
  assert.match(installer, /-ExecutionPolicy RemoteSigned/);
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
  // CloakBrowser is the only engine; the retired cft path must not come back.
  assert.doesNotMatch(installer, /chromium\\cft\\runtime\\chrome\.exe/i);
  assert.match(installer, /chromium\\cloakbrowser\\runtime\\chrome\.exe/i);
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

test("clears the engine cache last and never aborts uninstall over it", () => {
  const uninstallMacro = installer.match(/!macro customUnInstall[\s\S]*?!macroend/)?.[0];
  assert.ok(uninstallMacro);
  assert.match(uninstallMacro, /-File "\$PLUGINSDIR\\windows-engine-cache-cleanup\.ps1"/);

  // Last, so a failure cannot interfere with a fail-closed step that has yet to run.
  const startupRemovalAt = uninstallMacro.indexOf("-Mode RemoveBrowser");
  const engineCacheAt = uninstallMacro.indexOf("windows-engine-cache-cleanup.ps1");
  assert.ok(startupRemovalAt >= 0 && engineCacheAt > startupRemovalAt);

  // Every other step aborts on failure; this one reports and continues, because a retained cache is
  // disk usage and is what earlier versions left behind. Regressing that would make uninstall fail
  // for a reason no previous version failed for.
  const engineCacheBlock = uninstallMacro.slice(engineCacheAt);
  assert.doesNotMatch(engineCacheBlock, /Abort/);
  assert.match(engineCacheBlock, /can be deleted manually/);
});

test("keeps the engine cache when the uninstaller is running as part of an upgrade", () => {
  // electron-builder installs a new version by running the PREVIOUS version's uninstaller, so
  // customUnInstall fires on every upgrade as well. Unguarded, that discards the operator's engine
  // download on each new version. The 0.3.21 clean-VM run caught it: a repair over an existing
  // install removed a staged engine cache while leaving profiles and the pin intact.
  const uninstallMacro = installer.match(/!macro customUnInstall[\s\S]*?!macroend/)?.[0];
  assert.ok(uninstallMacro);

  const guardAt = uninstallMacro.indexOf("${ifNot} ${isUpdated}");
  const engineCacheAt = uninstallMacro.indexOf("windows-engine-cache-cleanup.ps1");
  assert.ok(guardAt >= 0, "the engine cache cleanup must be guarded by isUpdated");
  assert.ok(engineCacheAt > guardAt, "the guard must open before the cleanup runs");

  // Only this block is guarded. Firewall, Relay and Startup cleanup must still run on an upgrade,
  // because ownership state has to be handed over rather than stranded.
  const firewallAt = uninstallMacro.indexOf("-Mode Uninstall");
  const relayAt = uninstallMacro.indexOf("windows-relay-cleanup.ps1");
  const startupAt = uninstallMacro.indexOf("-Mode RemoveBrowser");
  for (const [name, at] of [["firewall", firewallAt], ["relay", relayAt], ["startup", startupAt]]) {
    assert.ok(at >= 0 && at < guardAt, `${name} cleanup must stay outside the isUpdated guard`);
  }
});

test("rejects another Windows user's firewall ownership before any mutation", () => {
  const ownerCheckAt = firewall.indexOf("Assert-FirewallOwnership $cloak");
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
  // Both process sources are required, and the reason is not stylistic. NSIS is 32-bit, so the
  // powershell.exe it launches is the WOW64 host, where Process.Path throws for a 64-bit target;
  // WMI is bitness independent but empty when the WMI service is off. An earlier revision asserted
  // that Get-CimInstance was absent, which pinned the Get-Process-only shape that could not stop
  // the Relay from the host NSIS actually uses.
  assert.match(relayCleanup, /Get-Process -ErrorAction SilentlyContinue/);
  assert.match(relayCleanup, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(relayCleanup, /Stop-Process -Id \$processId -Force -ErrorAction SilentlyContinue/);
  // Ownership that cannot be proved must stay untouched.
  assert.match(relayCleanup, /not ownership, and killing an unidentified process/);
  assert.match(relayCleanup, /Remove-Item -LiteralPath \$_\.FullName -Force -ErrorAction Stop/);
  assert.match(relayCleanup, /Ownership is unknown, so preserve the shortcut/);
  assert.match(relayCleanup, /owned MKTTool Relay shortcut could not be removed/);
  assert.match(relayCleanup, /function Remove-OwnedRelayArtifact\(\[string\]\$Path, \[string\]\$Label\)/);
  assert.match(relayCleanup, /Remove-Item -LiteralPath \$Path -Force -ErrorAction SilentlyContinue/);
  assert.match(relayCleanup, /Remove-OwnedRelayArtifact \$relayExe "executable"/);
  assert.match(relayCleanup, /Remove-OwnedRelayArtifact \$relayLauncher "startup wrapper"/);
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
  // Extraction stays inside the script file rather than an inline NSIS -Command, and refuses any
  // entry resolving outside the staging directory. Behaviour is covered by
  // windows-install-relay-payload.test.cjs; this only pins that the guarded path is the shipped one.
  assert.match(relayInstall, /\[IO\.Compression\.ZipFile\]::OpenRead\(\$archive\)/);
  assert.match(relayInstall, /relay-archive-entry-escapes-staging/);
  // Matches an invocation (a following switch), not the comment explaining why it was replaced.
  assert.doesNotMatch(relayInstall, /Expand-Archive\s+-/);
  // The payload is re-verified against its pinned manifest before anything is extracted or run.
  assert.match(relayInstall, /relay-archive-checksum-mismatch/);
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

test("ships the fork MIT license beside every packaged executable", () => {
  assert.match(
    config,
    /extraFiles:[\s\S]*from: \.\.\/\.\.\/LICENSE\s+to: LICENSE-MKTBrowser\.txt/,
  );
  assert.match(
    config,
    /copyright: Copyright \(c\) 2023 oboshto and MKTTool contributors/,
  );
});
