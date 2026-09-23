const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const desktopRoot = join(__dirname, "..");
const installer = readFileSync(join(desktopRoot, "build", "installer.nsh"), "utf8");
const detector = readFileSync(
  join(desktopRoot, "build", "windows-install-conflict-detection.ps1"),
  "utf8",
);
const assistedInstallerTemplate = readFileSync(
  join(desktopRoot, "node_modules", "app-builder-lib", "templates", "nsis", "assistedInstaller.nsh"),
  "utf8",
);
const installSectionTemplate = readFileSync(
  join(desktopRoot, "node_modules", "app-builder-lib", "templates", "nsis", "installSection.nsh"),
  "utf8",
);
const installerBuilder = readFileSync(
  join(desktopRoot, "electron-builder-installer.yml"),
  "utf8",
);

function macroBody(name) {
  const match = installer.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`));
  assert.ok(match, `missing ${name} macro`);
  return match[1];
}

function functionBody(name) {
  const match = installer.match(new RegExp(`Function ${name}\\b([\\s\\S]*?)FunctionEnd`));
  assert.ok(match, `missing ${name} function`);
  return match[1];
}

test("runs conflict inspection before any install mutation", () => {
  const logicLibAt = installer.indexOf('!include "LogicLib.nsh"');
  const uninstallKeyAt = installer.indexOf("!define /ifndef UNINSTALL_REGISTRY_KEY");
  const firstConditionalAt = installer.indexOf("${If}");
  const pageHookAt = assistedInstallerTemplate.indexOf("customPageAfterChangeDir");
  const installPageAt = assistedInstallerTemplate.indexOf("MUI_PAGE_INSTFILES");
  const uninstallAt = installSectionTemplate.indexOf("uninstallOldVersion");
  const customInstallAt = installSectionTemplate.indexOf("customInstall");

  assert.ok(uninstallKeyAt >= 0 && logicLibAt > uninstallKeyAt && firstConditionalAt > logicLibAt);
  assert.ok(pageHookAt >= 0 && installPageAt > pageHookAt);
  assert.ok(uninstallAt >= 0 && customInstallAt > uninstallAt);
  assert.match(installer, /Page custom MktBrowserInspectBeforeInstall/);
  assert.match(installer, /Function MktBrowserNormalizeInstallPath/);
  const silentPreflight = macroBody("customInit");
  const interactivePreflight = functionBody("MktBrowserInspectBeforeInstall");
  assert.match(silentPreflight, /\$\{If\} \$\{Silent\}/);
  assert.match(installer, /-ExpectedBrowserPath "\$INSTDIR\\\$\{APP_FILENAME\}\.exe"/);
  assert.doesNotMatch(installer, /APP_EXECUTABLE_FILENAME/);
  assert.match(installer, /-RepairOwnedShortcuts/);
  assert.doesNotMatch(macroBody("customInstall"), /windows-install-conflict-detection/);

  for (const preflight of [silentPreflight, interactivePreflight]) {
    const detectionAt = preflight.indexOf("Call MktBrowserInspectInstallConflicts");
    const repairRegistryAt = preflight.indexOf("preserveRelayOwnershipForUpgrade");
    assert.ok(detectionAt >= 0 && repairRegistryAt > detectionAt);
  }
  assert.ok(
    interactivePreflight.indexOf("Call MktBrowserNormalizeInstallPath") <
      interactivePreflight.indexOf("Call MktBrowserInspectInstallConflicts"),
  );
  assert.doesNotMatch(silentPreflight, /MktBrowserNormalizeInstallPath/);
});

test("detects fixed-port, running Browser path, MultiZen, and startup conflicts without privileged CIM", () => {
  assert.match(detector, /MKTBrowser\.exe/);
  assert.match(detector, /MKTTool-Relay\.exe/);
  assert.match(detector, /start-mkttool-relay\.cmd/);
  assert.match(detector, /MultiZen/);
  assert.match(detector, /Assert-Listener \$listeners 47821/);
  assert.match(detector, /Assert-Listener \$listeners 47822/);
  assert.match(detector, /Duplicate .* startup entries/);
  assert.match(detector, /Get-Process/);
  assert.match(detector, /netstat\.exe/);
  assert.match(detector, /\[switch\]\$RuntimeInspection/);
  assert.match(detector, /\$allowExpectedBrowser = \$RuntimeInspection\.IsPresent/);
  assert.match(detector, /choose Quit MKT Browser from its system tray menu/);
  assert.doesNotMatch(detector, /Get-CimInstance|Get-NetTCPConnection/);
  assert.doesNotMatch(detector, /Exception\.Message|Detail:/);
  for (const code of [20, 21, 22, 23, 24, 27, 28]) {
    assert.match(detector, new RegExp(` ${code} \\"`));
  }
  assert.match(detector, /\) 25 "MKT Browser"/);
  assert.match(detector, /\) 26 "MKTTool Relay"/);
});

test("canonical shortcut preflight precedes both early mutations and the bundled Relay installer", () => {
  const shortcutCheck = macroBody("inspectStartupShortcutOwnership");
  assert.match(shortcutCheck, /stageStartupCoordinationScript/);
  assert.match(shortcutCheck, /-Mode Preflight/);
  assert.match(shortcutCheck, /-ExpectedBrowserPath "\$INSTDIR\\\$\{APP_FILENAME\}\.exe"/);
  assert.match(shortcutCheck, /-ExpectedRelayPath "\$LOCALAPPDATA\\MKTTool-Relay\\MKTTool-Relay\.exe"/);
  const early = functionBody("MktBrowserInspectInstallConflicts");
  const earlyCheck = early.indexOf("!insertmacro inspectStartupShortcutOwnership");
  assert.ok(earlyCheck >= 0 && earlyCheck < early.indexOf("-Mode CheckOwner"));
  assert.ok(earlyCheck < early.indexOf("-RepairOwnedShortcuts"));
  assert.match(early, /inspectStartupShortcutOwnership\s+\$\{If\} \$0 != 0\s+Return/);
  const install = macroBody("customInstall");
  const installCheck = install.indexOf("!insertmacro inspectStartupShortcutOwnership");
  assert.ok(installCheck >= 0 && installCheck < install.indexOf("stageFirewallScript"));
  assert.ok(installCheck < install.indexOf("stageRelayInstallScript"));
  assert.ok(installCheck < install.indexOf("windows-install-relay-payload.ps1"));
  assert.match(install, /inspectStartupShortcutOwnership\s+\$\{If\} \$0 != 0[\s\S]*?Abort[\s\S]*?\$\{EndIf\}[\s\S]*?stageRelayInstallScript/);
});

test("packages the shared detector for setup-time runtime inspection", () => {
  assert.match(
    installerBuilder,
    /from: build\/windows-install-conflict-detection\.ps1[\s\S]*to: installer\/windows-install-conflict-detection\.ps1/,
  );
});

test("repairs only exact-target owned shortcut duplicates after all conflict checks", () => {
  const browserCheckAt = detector.indexOf("$browserDuplicates = @(");
  const relayCheckAt = detector.indexOf("$relayDuplicates = @(");
  const repairAt = detector.indexOf("Repair-OwnedShortcuts $browserDuplicates");

  assert.ok(browserCheckAt >= 0 && relayCheckAt > browserCheckAt && repairAt > relayCheckAt);
  assert.match(detector, /Same-Path \$_\.Target \$ExpectedPath/);
  assert.match(detector, /start-mkttool-relay\.cmd/);
  assert.match(detector, /function Assert-Relay-Shortcuts/);
  assert.match(detector, /AllowLegacyDirectTarget/);
  assert.match(detector, /\$shortcut\.Arguments/);
  assert.match(detector, /Remove-Item -LiteralPath \$duplicate\.Link -Force -ErrorAction Stop/);
  assert.doesNotMatch(detector, /Stop-Process|taskkill|Remove-Item[^\n]+MultiZen/i);
  assert.match(detector, /MultiZen data was not modified/);
});

test("resolves a 64-bit process path from the 32-bit NSIS host without privileged CIM", () => {
  // Get-Process().Path throws under WOW64 for a 64-bit target, which made the running Relay
  // unverifiable and blocked every repair over a normal installation. QueryFullProcessImageName
  // asks the kernel instead of reading the target's modules, so it is bitness independent, and
  // PROCESS_QUERY_LIMITED_INFORMATION needs no elevation — keeping the no-privileged-CIM rule
  // asserted above intact. Behavioural coverage lives in
  // windows-install-conflict-detection-process-path.test.cjs.
  assert.match(detector, /QueryFullProcessImageNameW/);
  assert.match(detector, /0x1000/);
  assert.match(detector, /function Process-Path/);

  // An unresolvable process must still be refused: unprovable ownership is not ownership.
  const nativeResolver = detector.match(/function Native-Process-Path\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(nativeResolver, "missing Native-Process-Path");
  assert.match(nativeResolver[0], /return \$null/);
  assert.match(
    detector,
    /is running, but its executable ownership could not be verified/,
  );
});
