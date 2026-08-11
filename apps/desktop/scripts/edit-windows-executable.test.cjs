const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isTransientCommitError,
  runRceditWithRetry,
} = require("./edit-windows-executable.cjs");

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
