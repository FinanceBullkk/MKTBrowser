import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
  commandLineUsesDataDir,
  commandLineUsesDataDirUnder,
  debugPortFromCommandLine,
  enumerateBrowserProcessesUsingDataDir,
  enumerateLoopbackPortOwners,
  parseLoopbackPortOwners,
  selectPrimaryBrowserPid,
  windowsSystemRootFromEnv,
} from "./browser-process-discovery.ts";

const DATA_DIR = "C:\\Users\\operator\\MKT Browser\\profile-1";

test("matches quoted and unquoted Chromium user-data-dir arguments exactly", () => {
  assert.equal(
    commandLineUsesDataDir(`chrome.exe --user-data-dir="${DATA_DIR}" --type=renderer`, DATA_DIR),
    true,
  );
  assert.equal(
    commandLineUsesDataDir(`chrome.exe --user-data-dir=${DATA_DIR.replaceAll(" ", "_")}`, DATA_DIR),
    false,
  );
  assert.equal(
    commandLineUsesDataDir(`chrome.exe --user-data-dir="${DATA_DIR}-other"`, DATA_DIR),
    false,
  );
});

test("selects the browser process instead of a short-lived launcher or helper", () => {
  const pid = selectPrimaryBrowserPid(
    [
      { pid: 20, commandLine: `chrome.exe --type=renderer --user-data-dir="${DATA_DIR}"` },
      { pid: 30, commandLine: `chrome.exe --user-data-dir="${DATA_DIR}" --remote-debugging-port=9222` },
    ],
    10,
  );
  assert.equal(pid, 30);
  assert.equal(selectPrimaryBrowserPid([], 10), 10);
});

// Paths here use forward slashes on purpose: normalizePath() folds them to the platform separator,
// so the tests read without a wall of escapes while exercising the same comparison.
const ROOT = "C:\\Users\\operator\\MKT Browser";
const ROOT_FWD = "C:/Users/operator/MKT Browser";

test("reads the DevTools port an orphaned browser was started with", () => {
  // Without the port there is no polite way to close a browser we did not launch, and the impolite
  // way keeps the licence seat for up to 17 minutes.
  assert.equal(debugPortFromCommandLine("chrome.exe --remote-debugging-port=9222"), 9222);
  assert.equal(debugPortFromCommandLine('chrome.exe --remote-debugging-port="9223" --x'), 9223);
  assert.equal(debugPortFromCommandLine("chrome.exe --type=renderer"), null);
  assert.equal(debugPortFromCommandLine("chrome.exe --remote-debugging-port=0"), null);
  assert.equal(debugPortFromCommandLine("chrome.exe --remote-debugging-port=70000"), null);
  // Chromium honours the last occurrence, so this must agree with it.
  assert.equal(
    debugPortFromCommandLine("chrome.exe --remote-debugging-port=9222 --remote-debugging-port=9333"),
    9333,
  );
  // A flag that merely starts with the same text is a different flag.
  assert.equal(debugPortFromCommandLine("chrome.exe --remote-debugging-port-x=9222"), null);
});

test("parses only exact IPv4 loopback listeners from native netstat output", () => {
  const raw = [
    "  TCP    127.0.0.1:47822        0.0.0.0:0              LISTENING       20",
    "  TCP    127.0.0.1:47822        0.0.0.0:0              LISTENING       20",
    "  TCP    127.0.0.1:47822        127.0.0.1:53100        ESTABLISHED     30",
    "  TCP    127.0.0.1:47823        0.0.0.0:0              LISTENING       40",
    "  TCP    0.0.0.0:47822          0.0.0.0:0              LISTENING       50",
    "  TCP    [::1]:47822            [::]:0                 LISTENING       60",
    "  TCP    127.0.0.1:47824        0.0.0.0:0              LOCALIZED      70",
  ].join("\r\n");

  assert.deepEqual(parseLoopbackPortOwners(raw, 47822), [20]);
  assert.deepEqual(parseLoopbackPortOwners(raw, 47823), [40]);
  // State labels are localized by Windows; the wildcard foreign endpoint is the invariant.
  assert.deepEqual(parseLoopbackPortOwners(raw, 47824), [70]);
  assert.deepEqual(parseLoopbackPortOwners(raw, 0), []);
  assert.deepEqual(parseLoopbackPortOwners("x".repeat(1_048_577), 47822), []);
});

test("accepts only a drive-qualified local Windows system root", () => {
  assert.equal(windowsSystemRootFromEnv({ SystemRoot: "C:\\Windows" }), "C:\\Windows");
  assert.equal(
    windowsSystemRootFromEnv({ SystemRoot: "", WINDIR: "D:\\Windows\\" }),
    "D:\\Windows",
  );
  assert.equal(windowsSystemRootFromEnv({ SystemRoot: "\\Windows" }), null);
  assert.equal(windowsSystemRootFromEnv({ SystemRoot: "\\\\server\\share\\Windows" }), null);
  assert.equal(windowsSystemRootFromEnv({ SystemRoot: "Windows" }), null);
});

test(
  "attributes a real Windows loopback listener to the owning process",
  { skip: process.platform !== "win32" },
  async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      if (address === null || typeof address !== "object") throw new Error("listener did not bind");
      const result = await enumerateLoopbackPortOwners(address.port);
      assert.equal(result.inspected, true);
      assert.deepEqual(result.pids, [process.pid]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "finds a real Windows process by its exact user-data directory",
  { skip: process.platform !== "win32" },
  async () => {
    const dataDir = "C:\\g3\\h\u1ed3-s\u01a1-process-inspection";
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${dataDir}`],
      { stdio: "ignore", windowsHide: true },
    );
    await once(child, "spawn");
    try {
      const result = await enumerateBrowserProcessesUsingDataDir(dataDir);
      assert.equal(result.enumerated, true);
      assert.equal(result.processes.some((candidate) => candidate.pid === child.pid), true);
    } finally {
      child.kill();
      await once(child, "exit");
    }
  },
);

test("matches profiles beneath the app root without reaching past it", () => {
  assert.equal(
    commandLineUsesDataDirUnder(
      `chrome.exe --user-data-dir="${ROOT_FWD}/p1/engines/cloakbrowser"`,
      ROOT_FWD,
    ),
    true,
  );
  // Same directory expressed the Windows way still has to match the root it sits under.
  assert.equal(
    commandLineUsesDataDirUnder(
      `chrome.exe --user-data-dir="${ROOT}\\p1"`,
      ROOT_FWD,
    ),
    true,
  );
  assert.equal(
    commandLineUsesDataDirUnder(`chrome.exe --user-data-dir="${ROOT_FWD}"`, ROOT_FWD),
    true,
  );
  // The operator's own Chrome must never be swept up to reclaim a seat.
  assert.equal(
    commandLineUsesDataDirUnder(
      `chrome.exe --user-data-dir="C:/Users/operator/AppData/Local/Google/Chrome/User Data"`,
      ROOT_FWD,
    ),
    false,
  );
  // A sibling whose name merely starts with the root is not beneath it.
  assert.equal(
    commandLineUsesDataDirUnder(`chrome.exe --user-data-dir="${ROOT_FWD}-backup/p1"`, ROOT_FWD),
    false,
  );
  assert.equal(commandLineUsesDataDirUnder("chrome.exe --type=gpu", ROOT_FWD), false);
});
