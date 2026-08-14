const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");
const { buildEncodedFirewallCommands } = require("./generate-windows-firewall-commands.cjs");

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
const config = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
const installerConfig = readFileSync(
  join(desktopRoot, "electron-builder-installer.yml"),
  "utf8",
);
const encodedCommands = buildEncodedFirewallCommands(firewall);
const elevatedCommands = Object.values(encodedCommands).map((command) =>
  Buffer.from(command, "base64").toString("utf16le"),
);

function embeddedScript(command) {
  const payload = command.match(/\$z='([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(payload, "Elevated command does not contain its firewall payload.");
  return gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
}

test("keeps per-user install and elevates only the firewall transaction", () => {
  assert.match(config, /perMachine:\s*false/);
  assert.match(installer, /ExecShellWait "runas"/);
  for (const commandName of [
    "CHECK_PROFILES",
    "INSTALL",
    "UNINSTALL",
    "VERIFY",
    "VERIFY_ABSENT",
  ]) {
    assert.match(installer, new RegExp(`MKT_BROWSER_FIREWALL_${commandName}_COMMAND`));
  }
  assert.doesNotMatch(installer, /SetEnvironmentVariable/);
  assert.equal(elevatedCommands.length, 5);
  for (const command of elevatedCommands) {
    assert.equal(embeddedScript(command), firewall);
    assert.match(command, /GzipStream/);
    assert.match(command, /ScriptBlock.*Create/);
  }
  for (const engine of ["cft", "cloakbrowser"]) {
    assert.match(
      Buffer.from(encodedCommands.install, "base64").toString("utf16le"),
      new RegExp(`'chromium','${engine}','runtime','chrome\\.exe'`, "i"),
    );
  }
  assert.match(firewall, /New-NetFirewallRule/);
  assert.match(firewall, /Direction Outbound/);
  assert.match(firewall, /Action Block/);
  assert.match(firewall, /Protocol UDP/);
  assert.match(firewall, /Profile Any/);
  assert.match(firewall, /\(\$rule\.Profiles -band 7\) -ne 7/);
  assert.match(firewall, /firewall-profile-disabled/);
  assert.match(firewall, /HNetCfg\.FwPolicy2/);
  assert.match(installer, /verification failed \(code \$0\)/);
  assert.match(installer, /Windows Security > Firewall & network protection/);
});

test("removes only owned stale rules after verification and on uninstall", () => {
  assert.match(firewall, /MKT Browser WebRTC Protection/);
  assert.match(firewall, /Where-Object \{ \$_\.DisplayName -like 'MKT Browser WebRTC UDP Block \*'/);
  const finalVerificationAt = firewall.lastIndexOf("Assert-Rule $entry.Final $entry.Program");
  const staleCleanupAt = firewall.lastIndexOf("Get-NetFirewallRule -Group $group");
  assert.ok(finalVerificationAt >= 0 && staleCleanupAt > finalVerificationAt);
  assert.match(Buffer.from(encodedCommands.install, "base64").toString("utf16le"), /-Mode Install/);
  assert.match(Buffer.from(encodedCommands.uninstall, "base64").toString("utf16le"), /-Mode Uninstall/);
  assert.match(Buffer.from(encodedCommands.verify, "base64").toString("utf16le"), /-Mode Verify/);
  assert.match(
    Buffer.from(encodedCommands.verifyAbsent, "base64").toString("utf16le"),
    /-Mode VerifyAbsent/,
  );
  const uninstallMacro = installer.match(/!macro customUnInstall[\s\S]*?!macroend/)?.[0];
  assert.ok(uninstallMacro);
  assert.ok(
    uninstallMacro.indexOf("MKT_BROWSER_FIREWALL_UNINSTALL_COMMAND") <
      uninstallMacro.indexOf("windows-relay-cleanup.ps1"),
  );
  assert.match(installer, /pre-launch check refuses to run without the exact firewall rules/);
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
  assert.match(installMacro, /Expand-Archive[\s\S]*install-relay\.ps1/);
  assert.match(installMacro, /MKTTool Relay installation failed/);
  assert.doesNotMatch(installMacro, /windows-relay-cleanup/);
  assert.doesNotMatch(installMacro, /relay-config\.json/);
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
