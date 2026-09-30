const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isTransientCommitError,
  runRceditWithRetry,
  windowsVersionInfo,
} = require("./edit-windows-executable.cjs");

test("replaces inherited Electron version metadata with the fork identity", () => {
  assert.deepEqual(windowsVersionInfo("0.3.30"), {
    "file-version": "0.3.30",
    "product-version": "0.3.30",
    "version-string": {
      CompanyName: "MKTTool",
      FileDescription: "MKT Browser",
      InternalName: "MKTBrowser",
      LegalCopyright: "Copyright (c) 2023 oboshto and MKTTool contributors",
      OriginalFilename: "MKTBrowser.exe",
      ProductName: "MKT Browser",
    },
  });
});

test("retries transient rcedit commit failures with bounded delays", async () => {
  const calls = [];
  const delays = [];
  const warnings = [];
  const transientError = new Error("Fatal error: Unable to commit changes");
  const editExecutable = async (...args) => {
    calls.push(args);
    if (calls.length < 3) throw transientError;
  };

  await runRceditWithRetry(editExecutable, "MKTBrowser.exe", { version: "0.3.1" }, {
    sleep: async (delayMs) => delays.push(delayMs),
    warn: (message) => warnings.push(message),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(warnings.length, 2);
});

test("does not retry unrelated rcedit failures", async () => {
  const unrelatedError = new Error("Access is denied");
  let calls = 0;

  await assert.rejects(
    runRceditWithRetry(
      async () => {
        calls += 1;
        throw unrelatedError;
      },
      "MKTBrowser.exe",
      {},
      { sleep: async () => assert.fail("unexpected retry") },
    ),
    (error) => error === unrelatedError,
  );

  assert.equal(calls, 1);
  assert.equal(isTransientCommitError(unrelatedError), false);
});

test("stops after the configured transient retry budget", async () => {
  const transientError = new Error("Fatal error: Unable to commit changes");
  const delays = [];
  let calls = 0;

  await assert.rejects(
    runRceditWithRetry(
      async () => {
        calls += 1;
        throw transientError;
      },
      "MKTBrowser.exe",
      {},
      {
        retryDelaysMs: [10, 20],
        sleep: async (delayMs) => delays.push(delayMs),
        warn: () => {},
      },
    ),
    (error) => error === transientError,
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(isTransientCommitError(transientError), true);
});
