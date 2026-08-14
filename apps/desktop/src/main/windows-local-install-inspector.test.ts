import assert from "node:assert/strict";
import test from "node:test";
import { WindowsLocalInstallInspector } from "./windows-local-install-inspector.ts";

const PATHS = {
  scriptPath:
    "C:\\Program Files\\MKT Browser\\resources\\installer\\windows-install-conflict-detection.ps1",
  browserPath: "C:\\Program Files\\MKT Browser\\MKTBrowser.exe",
  relayPath: "C:\\Users\\operator\\AppData\\Local\\MKTTool-Relay\\MKTTool-Relay.exe",
  startupDirectory:
    "C:\\Users\\operator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
};

test("runs the packaged detector in runtime mode and caches a passing verdict", async () => {
  let now = 1_000;
  const calls: Array<{ file: string; args: string[]; timeout: number; windowsHide: boolean }> = [];
  const inspector = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    now: () => now,
    pathExists: () => true,
    execFile: async (file, args, options) => {
      calls.push({
        file,
        args,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
      });
      return { stdout: "inspection passed", stderr: "" };
    },
  });

  assert.equal(await inspector.isReady(), true);
  assert.equal(await inspector.isReady(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "powershell.exe");
  assert.equal(calls[0]?.timeout, 5_000);
  assert.equal(calls[0]?.windowsHide, true);
  assert.equal(calls[0]?.args.at(-1), "-RuntimeInspection");
  assert.equal(calls[0]?.args.includes("-RepairOwnedShortcuts"), false);

  now += 5_001;
  assert.equal(await inspector.isReady(), true);
  assert.equal(calls.length, 2);
});

test("fails closed when the detector is unavailable or reports a conflict", async () => {
  const missing = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    pathExists: () => false,
    execFile: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(await missing.isReady(), false);

  const conflict = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    pathExists: () => true,
    execFile: async () => {
      throw new Error("process exited with code 24");
    },
  });
  assert.equal(await conflict.isReady(), false);

  const nonWindows = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "linux",
    pathExists: () => true,
    execFile: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(await nonWindows.isReady(), false);
});
