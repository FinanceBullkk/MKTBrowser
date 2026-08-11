import assert from "node:assert/strict";
import test from "node:test";
import {
  commandLineUsesDataDir,
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
