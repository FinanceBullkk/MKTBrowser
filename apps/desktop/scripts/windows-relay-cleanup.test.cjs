/*
 * Behavioural coverage for build/windows-relay-cleanup.ps1.
 *
 * The other suites assert only that this script is shipped and referenced by the NSIS macro, and
 * anything that did run it ran it under the 64-bit PowerShell host, where it passes. NSIS is a
 * 32-bit application, so the powershell.exe it launches is the 32-bit host under WOW64, and there
 * `System.Diagnostics.Process.Path` throws for a 64-bit target. The script caught that and read it
 * as "not the Relay", so the Relay was never stopped and every ordinary uninstall aborted with
 * "The owned MKTTool Relay executable is still present" — naming a process it believed it had
 * handled. Installing starts the Relay, so operators hit this on the normal path.
 *
 * The bitness of the host is therefore the whole point: these tests run under both, and the
 * fixture is a real running process, because a fixture that only writes a file passes either way.
 */
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const script = join(__dirname, "..", "build", "windows-relay-cleanup.ps1");
const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";

/** A small real executable that keeps running, so it holds a genuine lock on its own image. */
const HOST_EXECUTABLE = join(windowsRoot, "System32", "cmd.exe");

/**
 * Both PowerShell hosts. `System32` is the native host; `SysWOW64` is the 32-bit one that NSIS
 * actually gets, and is the only one that reproduced the failure.
 */
const POWERSHELL_HOSTS = [
  ["native host", join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  ["32-bit host, as NSIS launches it", join(windowsRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe")],
];

function stageOwnedRelay(t) {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relayDirectory = join(root, "MKTTool-Relay");
  mkdirSync(relayDirectory, { recursive: true });
  const relayExecutable = join(relayDirectory, "MKTTool-Relay.exe");
  const relayLauncher = join(relayDirectory, "start-mkttool-relay.cmd");
  copyFileSync(HOST_EXECUTABLE, relayExecutable);
  writeFileSync(relayLauncher, "@echo off\r\n", "ascii");
  return { root, relayExecutable, relayLauncher };
}

function runCleanup(powershell, root, scriptPath = script) {
  return execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      // Only LOCALAPPDATA steers the script, so pointing it at the fixture keeps the run away from
      // any Relay actually installed on the machine running the suite.
      env: { ...process.env, LOCALAPPDATA: root },
    },
  );
}

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

function stageShortcutFixtureScript(t, root, startup, desktop) {
  const source = readFileSync(script, "utf8");
  const replacement = `$shortcutFolders = @(\n  ${psQuote(startup)},\n  ${psQuote(desktop)}\n)`;
  const staged = source.replace(
    /\$shortcutFolders = @\(\r?\n\s*\[Environment\]::GetFolderPath\("Startup"\),\r?\n\s*\[Environment\]::GetFolderPath\("Desktop"\)\r?\n\)/,
    replacement,
  );
  assert.notEqual(staged, source, "test fixture did not replace shortcut folders");
  const path = join(root, "cleanup-shortcut-fixture.ps1");
  writeFileSync(path, staged, "utf8");
  return path;
}

function createShortcut(link, target, argumentsValue = "") {
  const command = [
    "$shell = New-Object -ComObject WScript.Shell",
    "try {",
    `  $shortcut = $shell.CreateShortcut(${psQuote(link)})`,
    `  $shortcut.TargetPath = ${psQuote(target)}`,
    `  $shortcut.Arguments = ${psQuote(argumentsValue)}`,
    "  $shortcut.Save()",
    "} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }",
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
}

for (const [label, powershell] of POWERSHELL_HOSTS) {
  const hostAvailable = { skip: process.platform !== "win32" || !existsSync(powershell) };

  test(`removes a running owned Relay from the ${label}`, hostAvailable, async (t) => {
    const { root, relayExecutable, relayLauncher } = stageOwnedRelay(t);

    // `pause` keeps the copy alive without a window and without a busy loop.
    const child = spawn(relayExecutable, ["/c", "pause"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "the fixture Relay should still be running before cleanup");

    runCleanup(powershell, root);

    assert.equal(
      existsSync(relayExecutable),
      false,
      "a running owned Relay must be stopped and its executable removed",
    );
    assert.equal(existsSync(relayLauncher), false, "the owned Relay startup wrapper must be removed");
  });

  test(`removes an idle owned Relay from the ${label}`, hostAvailable, (t) => {
    const { root, relayExecutable, relayLauncher } = stageOwnedRelay(t);

    runCleanup(powershell, root);

    assert.equal(existsSync(relayExecutable), false);
    assert.equal(existsSync(relayLauncher), false);
  });

  test(`succeeds when the owned Relay is already gone, from the ${label}`, hostAvailable, (t) => {
    const root = mkdtempSync(join(tmpdir(), "mkt-relay-cleanup-absent-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // Re-running an interrupted uninstall must not fail because the earlier run already succeeded.
    runCleanup(powershell, root);

    assert.equal(existsSync(join(root, "MKTTool-Relay", "MKTTool-Relay.exe")), false);
  });
}

test("removes exact legacy and wrapper shortcuts while preserving foreign or argument-bearing entries", { skip: process.platform !== "win32" }, (t) => {
  const { root, relayExecutable, relayLauncher } = stageOwnedRelay(t);
  const startup = join(root, "Startup");
  const desktop = join(root, "Desktop");
  const foreignDirectory = join(root, "foreign");
  mkdirSync(startup, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  mkdirSync(foreignDirectory, { recursive: true });
  const foreignLauncher = join(foreignDirectory, "start-mkttool-relay.cmd");
  writeFileSync(foreignLauncher, "@echo off\r\n", "ascii");

  const legacyLink = join(startup, "MKTTool Relay.lnk");
  const wrapperLink = join(desktop, "MKTTool Relay.lnk");
  const foreignLink = join(startup, "Foreign Relay.lnk");
  const argumentLink = join(desktop, "Relay Arguments.lnk");
  createShortcut(legacyLink, relayExecutable);
  createShortcut(wrapperLink, relayLauncher);
  createShortcut(foreignLink, foreignLauncher);
  createShortcut(argumentLink, relayLauncher, "--unsafe");

  const fixtureScript = stageShortcutFixtureScript(t, root, startup, desktop);
  runCleanup(join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), root, fixtureScript);

  assert.equal(existsSync(legacyLink), false, "legacy direct shortcut remained");
  assert.equal(existsSync(wrapperLink), false, "safe wrapper shortcut remained");
  assert.equal(existsSync(foreignLink), true, "foreign wrapper shortcut was removed");
  assert.equal(existsSync(argumentLink), true, "argument-bearing wrapper shortcut was removed");
  assert.equal(existsSync(relayExecutable), false, "owned Relay executable remained");
  assert.equal(existsSync(relayLauncher), false, "owned Relay wrapper remained");
});

test("cleanup keeps wrapper deletion behind exact target and non-reparse ownership checks", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /start-mkttool-relay\.cmd/);
  assert.match(source, /Same-Path \$target \$relayExe\) -or \(Same-Path \$target \$relayLauncher/);
  assert.match(source, /\$shortcut\.Arguments -ceq ""/);
  assert.match(source, /Remove-OwnedRelayArtifact \$relayLauncher "startup wrapper"/);
  assert.match(source, /Is-Reparse-Path \$relayDirectory/);
});
