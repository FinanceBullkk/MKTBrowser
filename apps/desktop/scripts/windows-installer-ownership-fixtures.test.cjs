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

function detectorArgs(root, browserPath, relayPath, repair = false) {
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
  ];
}

test("standard-user conflict inspection and owned shortcut repair stay non-destructive", windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "mktbrowser-conflict-fixture-"));
  try {
    const browserPath = join(root, "expected", "MKTBrowser.exe");
    const relayPath = join(root, "expected", "MKTTool-Relay.exe");
    mkdirSync(join(root, "expected"), { recursive: true });

    const probe = spawnSync("powershell.exe", detectorArgs(root, browserPath, relayPath), {
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);

    const canonical = join(root, "MKT Browser.lnk");
    const ownedDuplicate = join(root, "Owned Browser Duplicate.lnk");
    createShortcut(canonical, browserPath);
    createShortcut(ownedDuplicate, browserPath);

    const repair = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, true),
      { encoding: "utf8" },
    );
    assert.equal(repair.status, 0, repair.stderr || repair.stdout);
    assert.equal(existsSync(canonical), true);
    assert.equal(existsSync(ownedDuplicate), false);

    const unowned = join(root, "Different Browser.lnk");
    createShortcut(unowned, join(root, "other", "MKTBrowser.exe"));
    const conflict = spawnSync(
      "powershell.exe",
      detectorArgs(root, browserPath, relayPath, true),
      { encoding: "utf8" },
    );
    assert.equal(conflict.status, 25, conflict.stderr || conflict.stdout);
    assert.equal(existsSync(unowned), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
