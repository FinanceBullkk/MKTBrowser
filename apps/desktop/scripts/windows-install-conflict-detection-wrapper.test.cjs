const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const desktopRoot = join(__dirname, "..");
const detector = join(desktopRoot, "build", "windows-install-conflict-detection.ps1");

function stageRelayShortcutFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-shortcut-conflict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const startup = join(root, "Startup");
  const relayDirectory = join(root, "MKTTool-Relay");
  mkdirSync(startup, { recursive: true });
  mkdirSync(relayDirectory, { recursive: true });
  const browser = join(root, "MKTBrowser.exe");
  const relay = join(relayDirectory, "MKTTool-Relay.exe");
  const launcher = join(relayDirectory, "start-mkttool-relay.cmd");
  writeFileSync(browser, "fixture");
  writeFileSync(relay, "fixture");
  writeFileSync(launcher, "@echo off\r\n", "ascii");

  function inspect(shortcuts, { runtime = false, repair = false } = {}) {
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({ Processes: [], Listeners: [], Shortcuts: shortcuts }));
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", detector,
      "-ExpectedBrowserPath", browser,
      "-ExpectedRelayPath", relay,
      "-StartupDirectory", startup,
      "-InventoryPath", inventoryPath,
    ];
    if (runtime) args.push("-RuntimeInspection");
    if (repair) args.push("-RepairOwnedShortcuts");
    return spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  }

  return { startup, relay, launcher, inspect };
}

test("accepts only the exact wrapper at runtime while permitting one legacy direct target during upgrade", { skip: process.platform !== "win32" }, (t) => {
  const fixture = stageRelayShortcutFixture(t);
  const canonical = join(fixture.startup, "MKTTool Relay.lnk");
  const duplicate = join(fixture.startup, "Relay duplicate.lnk");
  const foreignLauncher = join(fixture.startup, "start-mkttool-relay.cmd");
  writeFileSync(duplicate, "fixture");
  writeFileSync(foreignLauncher, "@echo off\r\n", "ascii");

  const wrapper = {
    Link: canonical,
    Target: fixture.launcher,
    Arguments: "",
    LinkIsReparsePoint: false,
    TargetIsReparsePoint: false,
  };
  assert.equal(fixture.inspect([wrapper]).status, 0, "canonical wrapper should pass setup inspection");
  assert.equal(fixture.inspect([wrapper], { runtime: true }).status, 0, "canonical wrapper should pass runtime inspection");

  rmSync(fixture.launcher);
  assert.equal(
    fixture.inspect([], { runtime: true }).status,
    26,
    "runtime accepted a missing wrapper when no Relay Startup shortcut existed",
  );
  writeFileSync(fixture.launcher, "@echo off\r\n", "ascii");

  rmSync(fixture.relay);
  assert.equal(
    fixture.inspect([], { runtime: true }).status,
    26,
    "runtime accepted a missing Relay executable when no Relay Startup shortcut existed",
  );
  writeFileSync(fixture.relay, "fixture");

  const direct = { ...wrapper, Target: fixture.relay };
  assert.equal(fixture.inspect([direct]).status, 0, "exact legacy target should be accepted only for upgrade");
  assert.equal(fixture.inspect([direct], { runtime: true }).status, 26, "runtime accepted an unsafe direct target");

  const foreign = { ...wrapper, Target: foreignLauncher };
  assert.equal(fixture.inspect([foreign]).status, 26, "foreign wrapper target was accepted");
  assert.equal(fixture.inspect([{ ...wrapper, Arguments: "--unsafe" }]).status, 26, "wrapper arguments were accepted");
  assert.equal(fixture.inspect([{ ...wrapper, LinkIsReparsePoint: true }]).status, 26, "reparse shortcut was accepted");

  const duplicateWrapper = { ...wrapper, Link: duplicate };
  assert.equal(fixture.inspect([wrapper, duplicateWrapper]).status, 26, "duplicate wrapper was accepted without repair");
  assert.equal(fixture.inspect([wrapper, duplicateWrapper], { repair: true }).status, 0, "owned wrapper duplicate was not repairable");
  assert.equal(existsSync(duplicate), false, "repair did not remove the owned duplicate wrapper");
});
