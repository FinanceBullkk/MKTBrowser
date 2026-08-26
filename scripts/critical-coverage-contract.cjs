#!/usr/bin/env node
"use strict";

// Coverage floors for the modules whose regression can cross an identity boundary.
//
// This is deliberately not a whole-repository percentage. A repository number rises when someone
// adds tests to a settings helper and falls when someone adds an untested branch to the proxy path,
// and it cannot tell those two apart. The list below is the slice where a regression mixes profiles,
// leaks the real address, strands a licence seat, or executes an archive entry it should have
// refused, so it is the slice that gets a floor.
//
// Thresholds are the measured baseline rounded down by at most one point, per the phase 3 policy.
// They may be raised. Lowering one is a code review conversation, not an environment variable.

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const DESKTOP_ROOT = path.resolve(__dirname, "..", "apps", "desktop");

// Measured on 22 August 2026: 87.38 lines, 81.65 branches, 86.75 functions.
const THRESHOLDS = { lines: 86, branches: 80, functions: 85 };

// The floors below which a threshold may never be set, whatever a future baseline measures. A
// dropping baseline is a reason to add tests, not a reason to move the floor down to meet it.
const ABSOLUTE_FLOORS = { lines: 70, branches: 60, functions: 70 };

// Each entry pairs a protected module with the reason it is protected. The reason is not decoration:
// when someone later proposes removing an entry, the sentence is the argument they have to answer.
const PROTECTED_MODULES = [
  ["src/main/safe-archive-extraction.ts", "extracts engine and extension archives"],
  ["src/main/safe-archive-entry-validation.ts", "refuses traversal, links, and collisions"],
  ["src/main/devtools-port-discovery.ts", "binds a browser to the profile that owns it"],
  ["src/main/browser-process-discovery.ts", "identifies which process a port belongs to"],
  ["src/main/startup-orphan-sweep.ts", "reclaims browsers a crashed app left behind"],
  [
    "src/main/startup-license-lease-reconciliation.ts",
    "binds startup orphan verdicts back to durable licence seats",
  ],
  ["src/main/license-key-pool.ts", "decides which licence key a launch consumes"],
  ["src/main/license-lease-journal.ts", "records seat ownership across crashes"],
  ["src/main/license-lease-recovery.ts", "returns a seat a crash would otherwise strand"],
  ["src/main/license-seat-exit-verdict.ts", "keeps killed or crashed Browser seats resting"],
  ["src/main/proxyGeoLaunch.ts", "fails a launch closed when egress is unverifiable"],
  ["src/main/windows-webrtc-firewall.ts", "blocks the direct route WebRTC would otherwise take"],
  ["src/main/socks5Bridge.ts", "carries proxied traffic and must not rewrite its destination"],
];

const TEST_FILES = [
  "src/main/safe-archive-extraction.test.ts",
  "src/main/devtools-port-discovery.test.ts",
  "src/main/browser-process-discovery.test.ts",
  "src/main/startup-orphan-sweep.test.ts",
  "src/main/startup-license-lease-reconciliation.test.ts",
  "src/main/license-key-pool.test.ts",
  "src/main/license-lease-journal.test.ts",
  "src/main/license-lease-recovery.test.ts",
  "src/main/license-driver-lifecycle-contract.test.ts",
  "src/main/license-seat-exit-verdict.test.ts",
  "src/main/proxy-geo-launch.test.ts",
  "src/main/windows-webrtc-firewall.test.ts",
  "src/main/socks5-bridge-containment.test.ts",
  "src/main/socks5-bridge-http-upstream.test.ts",
];

function assertThresholdsAreLegal() {
  for (const [metric, floor] of Object.entries(ABSOLUTE_FLOORS)) {
    const value = THRESHOLDS[metric];
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`Coverage threshold for ${metric} is missing.`);
    }
    if (value < floor) {
      throw new Error(
        `Coverage threshold for ${metric} is ${value}, below the absolute floor of ${floor}. ` +
          `A baseline that dropped this far is a reason to add tests, not to lower the floor.`,
      );
    }
  }
}

// A renamed or deleted module silently leaves the include list, and coverage of everything that
// remains keeps looking healthy. Missing files are therefore a hard failure, not a warning.
function assertProtectedFilesExist() {
  const missing = [];
  for (const [relativePath, reason] of PROTECTED_MODULES) {
    if (!existsSync(path.join(DESKTOP_ROOT, relativePath))) missing.push(`${relativePath} (${reason})`);
  }
  for (const relativePath of TEST_FILES) {
    if (!existsSync(path.join(DESKTOP_ROOT, relativePath))) missing.push(relativePath);
  }
  if (missing.length > 0) {
    throw new Error(
      `Critical coverage contract references files that no longer exist:\n  ${missing.join("\n  ")}\n` +
        `Update scripts/critical-coverage-contract.cjs deliberately; do not let a rename drop a ` +
        `module out of coverage protection.`,
    );
  }
}

function buildArguments() {
  const args = ["--experimental-strip-types", "--test", "--experimental-test-coverage"];
  for (const [relativePath] of PROTECTED_MODULES) {
    args.push(`--test-coverage-include=${relativePath}`);
  }
  args.push(`--test-coverage-lines=${THRESHOLDS.lines}`);
  args.push(`--test-coverage-branches=${THRESHOLDS.branches}`);
  args.push(`--test-coverage-functions=${THRESHOLDS.functions}`);
  args.push(...TEST_FILES);
  return args;
}

function main() {
  assertThresholdsAreLegal();
  assertProtectedFilesExist();

  process.stdout.write(
    `Critical coverage contract: ${PROTECTED_MODULES.length} protected modules, thresholds ` +
      `${THRESHOLDS.lines}% lines / ${THRESHOLDS.branches}% branches / ${THRESHOLDS.functions}% functions.\n`,
  );

  const result = spawnSync(process.execPath, buildArguments(), {
    cwd: DESKTOP_ROOT,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(
      "\nCritical coverage fell below the contract. Add tests for the uncovered lines above; " +
        "do not lower the threshold to meet the measurement.\n",
    );
  }
  process.exit(result.status ?? 1);
}

module.exports = {
  ABSOLUTE_FLOORS,
  PROTECTED_MODULES,
  TEST_FILES,
  THRESHOLDS,
  assertProtectedFilesExist,
  assertThresholdsAreLegal,
  buildArguments,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
