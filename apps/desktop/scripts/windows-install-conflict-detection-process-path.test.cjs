/*
 * Behavioural coverage for Process-Path in build/windows-install-conflict-detection.ps1.
 *
 * NSIS is a 32-bit application, so the powershell.exe it launches is the 32-bit host under WOW64,
 * where `System.Diagnostics.Process.Path` throws for a 64-bit target. Process-Path had only that
 * source and read the throw as "no path", so the running 64-bit Relay resolved to nothing and the
 * caller refused with "MKTTool Relay is running, but its executable ownership could not be
 * verified" — refusing a Relay the installer explicitly allows. Installing starts the Relay, so
 * every repair/upgrade over a normal installation hit this. Under the 64-bit host it passed, which
 * is why no gate caught it.
 *
 * The bitness of the host is therefore the whole point: these run under both, against a real
 * running 64-bit process. A fixture that only writes a file would pass either way.
 *
 * Process-Path is exercised on its own rather than through a full detector run, because the
 * detector enumerates processes machine-wide: a Relay installed on the machine running the suite
 * would decide the result before the code under test was reached.
 */
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const detectorSource = readFileSync(
  join(__dirname, "..", "build", "windows-install-conflict-detection.ps1"),
  "utf8",
);
const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";

/** A real 64-bit executable that keeps running, so the 32-bit host genuinely cannot read its path. */
const HOST_EXECUTABLE = join(windowsRoot, "System32", "cmd.exe");

const POWERSHELL_HOSTS = [
  ["native host", join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  [
    "32-bit host, as NSIS launches it",
    join(windowsRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ],
];

/**
 * Lift the shipped resolver out of the detector so it can be called directly. Extracting the real
 * text keeps this honest: a copy maintained here would drift away from what actually ships.
 */
function extractProcessPath() {
  const match = detectorSource.match(
    /Add-Type -Namespace MktBrowser -Name NativeProcessPath[\s\S]*?\nfunction Process-Path\([^)]*\) \{[\s\S]*?\n\}/,
  );
  assert.ok(
    match,
    "could not find Process-Path (and its native resolver) in the shipped detector",
  );
  return match[0];
}

function stageResolver(t) {
  const root = mkdtempSync(join(tmpdir(), "mkt-process-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = join(root, "resolve.ps1");
  writeFileSync(
    scriptPath,
    [
      "$ErrorActionPreference = 'Stop'",
      extractProcessPath(),
      "$resolved = Process-Path ([int]$args[0])",
      "if ([string]::IsNullOrWhiteSpace($resolved)) { Write-Output 'UNRESOLVED' }",
      "else { Write-Output $resolved }",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

for (const [label, powershell] of POWERSHELL_HOSTS) {
  const hostAvailable = { skip: process.platform !== "win32" || !existsSync(powershell) };

  test(`resolves a running 64-bit process from the ${label}`, hostAvailable, async (t) => {
    const scriptPath = stageResolver(t);

    // `pause` keeps the fixture alive without a window and without a busy loop.
    const child = spawn(HOST_EXECUTABLE, ["/c", "pause"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "the fixture process should still be running");

    const resolved = execFileSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, String(child.pid)],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 },
    ).trim();

    assert.notEqual(
      resolved,
      "UNRESOLVED",
      "a running process the installer must classify was left unverified",
    );
    assert.equal(resolved.toLowerCase(), HOST_EXECUTABLE.toLowerCase());
  });

  test(`reports an unknown process id as unresolved from the ${label}`, hostAvailable, (t) => {
    const scriptPath = stageResolver(t);

    // Ownership that cannot be proved must stay unproved: the caller refuses on this.
    const resolved = execFileSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "999999"],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 },
    ).trim();

    assert.equal(resolved, "UNRESOLVED");
  });
}
