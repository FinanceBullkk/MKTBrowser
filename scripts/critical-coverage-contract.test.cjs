const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ABSOLUTE_FLOORS,
  PROTECTED_MODULES,
  TEST_FILES,
  THRESHOLDS,
  assertProtectedFilesExist,
  assertThresholdsAreLegal,
  buildArguments,
} = require("./critical-coverage-contract.cjs");

test("protects the modules whose regression crosses an identity boundary", () => {
  const protectedPaths = PROTECTED_MODULES.map(([relativePath]) => relativePath);

  // Named individually rather than counted, so deleting one fails here instead of quietly changing
  // a number that nobody reads.
  for (const required of [
    "src/main/safe-archive-extraction.ts",
    "src/main/safe-archive-entry-validation.ts",
    "src/main/devtools-port-discovery.ts",
    "src/main/browser-process-discovery.ts",
    "src/main/windows-process-query-worker.ts",
    "src/main/startup-orphan-sweep.ts",
    "src/main/license-key-pool.ts",
    "src/main/license-lease-journal.ts",
    "src/main/license-lease-recovery.ts",
    "src/main/proxyGeoLaunch.ts",
    "src/main/windows-webrtc-firewall.ts",
    "src/main/socks5Bridge.ts",
  ]) {
    assert.ok(protectedPaths.includes(required), `${required} must stay under a coverage floor`);
  }

  // Every entry carries the reason it is protected, so removing one has to answer the sentence.
  for (const [relativePath, reason] of PROTECTED_MODULES) {
    assert.equal(typeof reason, "string", `${relativePath} needs a stated reason`);
    assert.ok(reason.length > 10, `${relativePath} needs a real reason, not a placeholder`);
  }

  assert.ok(TEST_FILES.length > 0);
});

test("refuses a threshold below the absolute floor", () => {
  assert.doesNotThrow(() => assertThresholdsAreLegal());

  for (const metric of Object.keys(ABSOLUTE_FLOORS)) {
    const previous = THRESHOLDS[metric];
    try {
      THRESHOLDS[metric] = ABSOLUTE_FLOORS[metric] - 1;
      assert.throws(() => assertThresholdsAreLegal(), /below the absolute floor/);
    } finally {
      THRESHOLDS[metric] = previous;
    }
  }
});

test("fails when a protected module has been renamed out of the list", () => {
  assert.doesNotThrow(() => assertProtectedFilesExist());

  PROTECTED_MODULES.push(["src/main/module-that-was-renamed.ts", "stands in for a rename"]);
  try {
    assert.throws(() => assertProtectedFilesExist(), /no longer exist/);
  } finally {
    PROTECTED_MODULES.pop();
  }
});

test("passes the thresholds to the runner instead of only reporting them", () => {
  const args = buildArguments();

  // A coverage report that nobody compares to a number is decoration. The run itself must fail.
  assert.ok(args.includes(`--test-coverage-lines=${THRESHOLDS.lines}`));
  assert.ok(args.includes(`--test-coverage-branches=${THRESHOLDS.branches}`));
  assert.ok(args.includes(`--test-coverage-functions=${THRESHOLDS.functions}`));

  for (const [relativePath] of PROTECTED_MODULES) {
    assert.ok(args.includes(`--test-coverage-include=${relativePath}`));
  }

  // Coverage must be measured against production modules only. Counting the test files themselves
  // inflates every number and protects nothing.
  for (const testFile of TEST_FILES) {
    assert.ok(!args.includes(`--test-coverage-include=${testFile}`));
  }
});
