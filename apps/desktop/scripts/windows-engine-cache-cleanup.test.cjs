/*
 * Behavioural coverage for build/windows-engine-cache-cleanup.ps1.
 *
 * The risk this file exists to control is not "does the cache get deleted" but "does anything else
 * get deleted with it". Uninstall passed the 0.3.19 clean-VM run precisely because it preserves
 * operator data, so a cleanup step added afterwards has to prove it keeps that property: every test
 * below stages profiles.db, settings.json and the engine pin alongside the cache and asserts they
 * are still there afterwards.
 *
 * Both PowerShell hosts are exercised. NSIS launches the 32-bit host under WOW64, and a defect that
 * reproduces only there has shipped before (see windows-relay-cleanup.test.cjs).
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const script = join(__dirname, "..", "build", "windows-engine-cache-cleanup.ps1");
const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";

const POWERSHELL_HOSTS = [
  ["native host", join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  [
    "32-bit host, as NSIS launches it",
    join(windowsRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ],
];

/**
 * Recreate the on-disk layout the uninstaller meets: the engine cache nested under the product
 * root, operator data beside it, and the engine pin in a sibling of the product root rather than
 * a child of it.
 */
function stageLocalAppData(t, { withCache = true } = {}) {
  const localAppData = mkdtempSync(join(tmpdir(), "mkt-engine-cache-"));
  t.after(() => rmSync(localAppData, { recursive: true, force: true }));

  const productRoot = join(localAppData, "MKTTool", "MKTBrowser");
  mkdirSync(productRoot, { recursive: true });

  const preserved = {
    profiles: join(productRoot, "profiles.db"),
    settings: join(productRoot, "settings.json"),
    shutdownLog: join(productRoot, "profile-shutdown.log"),
    // Sibling of the product root, so a reinstall still knows which engine to fetch.
    enginePin: join(localAppData, "MKTTool", "compatibility-updater", "active-engine.json"),
  };
  mkdirSync(join(localAppData, "MKTTool", "compatibility-updater"), { recursive: true });
  for (const [name, filePath] of Object.entries(preserved)) {
    writeFileSync(filePath, `${name}-contents`, "utf8");
  }

  const engineCache = join(productRoot, "chromium");
  if (withCache) {
    // Both engines, nested, so the recursive removal is actually exercised.
    for (const engine of ["cft", "cloakbrowser"]) {
      const runtime = join(engineCache, engine, "runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "chrome.exe"), "not-a-real-engine", "utf8");
    }
  }

  return { localAppData, productRoot, engineCache, preserved };
}

function runCleanup(powershell, localAppData) {
  return execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    },
  );
}

/** Operator data is the whole point of the uninstall design, so assert it in every case. */
function assertOperatorDataPreserved(preserved) {
  for (const [name, filePath] of Object.entries(preserved)) {
    assert.equal(existsSync(filePath), true, `${name} must survive engine cache cleanup`);
    assert.equal(readFileSync(filePath, "utf8"), `${name}-contents`, `${name} must be unmodified`);
  }
}

for (const [label, powershell] of POWERSHELL_HOSTS) {
  const hostAvailable = { skip: process.platform !== "win32" || !existsSync(powershell) };

  test(`removes the engine cache and keeps operator data from the ${label}`, hostAvailable, (t) => {
    const staged = stageLocalAppData(t);

    const output = runCleanup(powershell, staged.localAppData);

    assert.match(output, /engine-cache-removed/);
    assert.equal(existsSync(staged.engineCache), false, "the engine cache must be gone");
    assert.equal(existsSync(staged.productRoot), true, "the product root itself must remain");
    assertOperatorDataPreserved(staged.preserved);
  });

  test(`succeeds with nothing to remove from the ${label}`, hostAvailable, (t) => {
    // An operator who never provisioned an engine must not see the uninstall report a failure.
    const staged = stageLocalAppData(t, { withCache: false });

    const output = runCleanup(powershell, staged.localAppData);

    assert.match(output, /engine-cache-absent/);
    assertOperatorDataPreserved(staged.preserved);
  });

  test(`refuses to delete anything when LOCALAPPDATA is unusable from the ${label}`, hostAvailable, (t) => {
    const staged = stageLocalAppData(t);

    assert.throws(() => runCleanup(powershell, ""));

    assert.equal(existsSync(staged.engineCache), true, "nothing may be removed without a target");
    assertOperatorDataPreserved(staged.preserved);
  });
}
