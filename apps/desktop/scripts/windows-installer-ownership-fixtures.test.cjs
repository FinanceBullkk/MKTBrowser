const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
const test = require("node:test");

const desktopRoot = join(__dirname, "..");
const detector = join(desktopRoot, "build", "windows-install-conflict-detection.ps1");
const firewall = join(desktopRoot, "build", "windows-webrtc-firewall.ps1");
const cleanupSource = readFileSync(
  join(desktopRoot, "build", "windows-relay-cleanup.ps1"),
  "utf8",
);
const windowsOnly = { skip: process.platform !== "win32" };

function runPowerShell(args, options = {}) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
    { encoding: "utf8", ...options },
  );
}

function createShortcut(linkPath, targetPath) {
  runPowerShell([
    "-Command",
    [
      "$shell = New-Object -ComObject WScript.Shell",
      `$shortcut = $shell.CreateShortcut(${JSON.stringify(linkPath)})`,
      `$shortcut.TargetPath = ${JSON.stringify(targetPath)}`,
      "$shortcut.Save()",
    ].join("; "),
  ]);
}

function detectorArgs(root, browserPath, relayPath, repair = false, runtime = false, inventoryPath) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    detector,
    "-ExpectedBrowserPath",
    browserPath,
    "-ExpectedRelayPath",
    relayPath,
    "-StartupDirectory",
    root,
    ...(repair ? ["-RepairOwnedShortcuts"] : []),
    ...(runtime ? ["-RuntimeInspection"] : []),
    ...(inventoryPath ? ["-InventoryPath", inventoryPath] : []),
  ];
}

function writeInventory(inventoryPath, inventory) {
  writeFileSync(inventoryPath, JSON.stringify({ Processes: [], Listeners: [], Shortcuts: [], ...inventory }));
}

test("standard-user conflict inspection and owned shortcut repair stay non-destructive", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "mktbrowser-conflict-fixture-"));
  try {
    const browserPath = join(root, "expected", "MKTBrowser.exe");
    const relayPath = join(root, "expected", "MKTTool-Relay.exe");
    const relayLauncherPath = join(root, "expected", "start-mkttool-relay.cmd");
    const inventoryPath = join(root, "inventory.json");
    mkdirSync(join(root, "expected"), { recursive: true });
    writeFileSync(relayLauncherPath, "@echo off\r\n", "ascii");
    writeFileSync(relayPath, "fixture", "ascii");
    writeInventory(inventoryPath, {});

    const probe = spawnSync("powershell.exe", detectorArgs(root, browserPath, relayPath, false, false, inventoryPath), {
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);

    writeInventory(inventoryPath, {
      Listeners: [{ LocalPort: 47822, OwnerPath: join(root, "other", "MKTBrowser.exe") }],
    });
    const listenerConflict = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, false, false, inventoryPath),
      { encoding: "utf8" },
    );
    assert.equal(listenerConflict.status, 23, listenerConflict.stderr || listenerConflict.stdout);

    writeInventory(inventoryPath, { Processes: [{ Path: browserPath }] });

    const installMode = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, false, false, inventoryPath),
      { encoding: "utf8" },
    );
    assert.equal(installMode.status, 20, installMode.stderr || installMode.stdout);

    const runtimeMode = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, false, true, inventoryPath),
      { encoding: "utf8" },
    );
    assert.equal(runtimeMode.status, 0, runtimeMode.stderr || runtimeMode.stdout);

    const canonical = join(root, "MKT Browser.lnk");
    const ownedDuplicate = join(root, "Owned Browser Duplicate.lnk");
    writeFileSync(canonical, "fixture", "utf8");
    writeFileSync(ownedDuplicate, "fixture", "utf8");
    writeInventory(inventoryPath, {
      Shortcuts: [
        { Link: canonical, Target: browserPath },
        { Link: ownedDuplicate, Target: browserPath },
      ],
    });

    const repair = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, true, false, inventoryPath),
      { encoding: "utf8" },
    );
    assert.equal(repair.status, 0, repair.stderr || repair.stdout);
    assert.equal(existsSync(canonical), true);
    assert.equal(existsSync(ownedDuplicate), false);

    const unowned = join(root, "Different Browser.lnk");
    writeFileSync(unowned, "fixture", "utf8");
    writeInventory(inventoryPath, {
      Shortcuts: [
        { Link: canonical, Target: browserPath },
        { Link: unowned, Target: join(root, "other", "MKTBrowser.exe") },
      ],
    });
    const conflict = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, true, false, inventoryPath),
      { encoding: "utf8" },
    );
    assert.equal(conflict.status, 25, conflict.stderr || conflict.stdout);
    assert.equal(existsSync(unowned), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects firewall rules owned by another Windows user without mutation", windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "mktbrowser-firewall-owner-fixture-"));
  try {
    const inventoryPath = join(root, "firewall-rules.json");
    const enginePath = (user, engine) =>
      join(root, user, "MKTTool", "MKTBrowser", "chromium", engine, "runtime", "chrome.exe");
    const userACft = enginePath("user-a", "cft");
    const userACloak = enginePath("user-a", "cloakbrowser");
    writeFileSync(
      inventoryPath,
      JSON.stringify({
        Rules: [
          { ApplicationName: userACft },
          { ApplicationName: userACloak },
        ],
      }),
      "utf8",
    );

    const otherUser = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        firewall,
        "-Mode",
        "CheckOwner",
        "-CftPath",
        enginePath("user-b", "cft"),
        "-CloakBrowserPath",
        enginePath("user-b", "cloakbrowser"),
        "-OwnedRuleInventoryPath",
        inventoryPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(otherUser.status, 17, otherUser.stderr || otherUser.stdout);

    const owner = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        firewall,
        "-Mode",
        "CheckOwner",
        "-CftPath",
        userACft,
        "-CloakBrowserPath",
        userACloak,
        "-OwnedRuleInventoryPath",
        inventoryPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(owner.status, 0, owner.stderr || owner.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "explicit machine integration gate inspects live Windows process, listener, and startup state",
  {
    skip:
      process.platform !== "win32" ||
      process.env.MKT_BROWSER_RUN_WINDOWS_MACHINE_INTEGRATION !== "1",
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "mktbrowser-live-conflict-gate-"));
    try {
      const result = spawnSync(
        "powershell.exe",
        detectorArgs(
          root,
          join(root, "MKTBrowser.exe"),
          join(root, "MKTTool-Relay.exe"),
        ),
        { encoding: "utf8" },
      );
      assert.equal(
        result.status,
        0,
        `Live-machine precondition failed. Close MKT Browser, Relay, and MultiZen before retrying.\n${result.stderr || result.stdout}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("owned Relay cleanup stops only its exact executable and preserves local state", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "mktbrowser-relay-cleanup-fixture-"));
  let relayProcess;
  try {
    const relayDir = join(root, "MKTTool-Relay");
    const startupDir = join(root, "startup");
    const desktopDir = join(root, "desktop");
    for (const directory of [relayDir, startupDir, desktopDir]) {
      mkdirSync(directory, { recursive: true });
    }

    const relayExe = join(relayDir, "MKTTool-Relay.exe");
    copyFileSync(process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", relayExe);
    writeFileSync(join(relayDir, "relay-config.json"), '{"preserved":true}', "utf8");

    const ownedShortcut = join(startupDir, "MKTTool Relay.lnk");
    const unownedShortcut = join(startupDir, "Other Relay.lnk");
    createShortcut(ownedShortcut, relayExe);
    createShortcut(unownedShortcut, join(root, "other", basename(relayExe)));

    const cleanupPath = join(root, "cleanup.ps1");
    writeFileSync(
      cleanupPath,
      cleanupSource
        .replace('[Environment]::GetFolderPath("Startup")', JSON.stringify(startupDir))
        .replace('[Environment]::GetFolderPath("Desktop")', JSON.stringify(desktopDir)),
      "utf8",
    );

    relayProcess = spawn(relayExe, ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], {
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    runPowerShell(["-File", cleanupPath], {
      env: { ...process.env, LOCALAPPDATA: root },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(relayProcess.exitCode === null, false, "owned Relay process is still running");
    assert.equal(existsSync(relayExe), false);
    assert.equal(existsSync(ownedShortcut), false);
    assert.equal(existsSync(unownedShortcut), true);
    assert.equal(readFileSync(join(relayDir, "relay-config.json"), "utf8"), '{"preserved":true}');
  } finally {
    if (relayProcess?.exitCode === null) relayProcess.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
