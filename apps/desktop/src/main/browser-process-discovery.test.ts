import assert from "node:assert/strict";
import test from "node:test";
import {
  commandLineUsesDataDir,
  commandLineUsesDataDirUnder,
  debugPortFromCommandLine,
  selectPrimaryBrowserPid,
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
