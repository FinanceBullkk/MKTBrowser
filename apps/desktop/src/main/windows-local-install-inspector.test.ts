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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function inspectionExit(code: number | string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`inspection exited with code ${code}`), { code, ...extra });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

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

test("coalesces cold snapshots and never reuses an expired passing verdict", async () => {
  let now = 1_000;
  const first = deferred<{ stdout: string; stderr: string }>();
  const second = deferred<{ stdout: string; stderr: string }>();
  const inspections = [first, second];
  let calls = 0;
  const inspector = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    now: () => now,
    pathExists: () => true,
    execFile: async () => {
      const inspection = inspections[calls++];
      return await inspection!.promise;
    },
  });

  assert.equal(inspector.snapshot(), "checking");
  assert.equal(inspector.snapshot(), "checking");
  assert.equal(calls, 1);

  first.resolve({ stdout: "inspection passed", stderr: "" });
  assert.equal(await inspector.isReady(), true);
  assert.equal(inspector.snapshot(), "ready");

  now += 5_001;
  assert.equal(inspector.snapshot(), "checking");
  assert.equal(calls, 2);

  second.resolve({ stdout: "inspection passed", stderr: "" });
  assert.equal(await inspector.isReady(), true);
});

test("classifies only explicit detector conflicts as failed", async () => {
  for (const code of [20, 26]) {
    const definitive = new WindowsLocalInstallInspector({
      ...PATHS,
      platform: "win32",
      pathExists: () => true,
      execFile: async () => {
        throw inspectionExit(code);
      },
    });
    assert.equal(await definitive.isReady(), false);
    assert.equal(definitive.snapshot(), "failed");
  }

  for (const error of [
    inspectionExit(27),
    inspectionExit("ETIMEDOUT", { killed: true }),
    inspectionExit(20, { killed: true }),
    new Error("unrecognized PowerShell failure"),
  ]) {
    const inspector = new WindowsLocalInstallInspector({
      ...PATHS,
      platform: "win32",
      pathExists: () => true,
      execFile: async () => {
        throw error;
      },
    });
    assert.equal(await inspector.isReady(), false);
    assert.equal(inspector.snapshot(), "unavailable");
  }
});

test("reports missing helpers and unsupported local checks as unavailable", async () => {
  const missing = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    pathExists: () => false,
    execFile: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(await missing.isReady(), false);
  assert.equal(missing.snapshot(), "unavailable");

  const probingFailure = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    pathExists: () => {
      throw new Error("filesystem inspection failed");
    },
    execFile: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(await probingFailure.isReady(), false);
  assert.equal(probingFailure.snapshot(), "unavailable");

  const missingConfig = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    scriptPath: "",
    pathExists: () => true,
    execFile: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(await missingConfig.isReady(), false);
  assert.equal(missingConfig.snapshot(), "unavailable");

  const nonWindows = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "linux",
    pathExists: () => true,
    execFile: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(await nonWindows.isReady(), false);
  assert.equal(nonWindows.snapshot(), "unavailable");
});

test("drops a late ready result after invalidation and queues one fresh inspection", async () => {
  const first = deferred<{ stdout: string; stderr: string }>();
  const second = deferred<{ stdout: string; stderr: string }>();
  const inspections = [first, second];
  let calls = 0;
  const inspector = new WindowsLocalInstallInspector({
    ...PATHS,
    platform: "win32",
    pathExists: () => true,
    execFile: async () => {
      const inspection = inspections[calls++];
      return await inspection!.promise;
    },
  });

  assert.equal(inspector.snapshot(), "checking");
  assert.equal(calls, 1);
  inspector.invalidate();
  assert.equal(calls, 1, "invalidation must not start a second PowerShell process");

  first.resolve({ stdout: "stale inspection passed", stderr: "" });
  await waitFor(() => calls === 2, "invalidation did not schedule one fresh inspection");
  assert.equal(inspector.snapshot(), "checking");
  assert.equal(calls, 2, "stale ready result must not become cached readiness");

  second.resolve({ stdout: "fresh inspection passed", stderr: "" });
  assert.equal(await inspector.isReady(), true);
  assert.equal(inspector.snapshot(), "ready");
  assert.equal(calls, 2, "only the queued fresh inspection may run");
});
