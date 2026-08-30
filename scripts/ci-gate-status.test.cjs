const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { STATUSES, makeGateResult } = require("./ci-gate-status.cjs");

const helper = path.join(__dirname, "ci-gate-status.cjs");

test("accepts only the five machine-readable statuses and exact result fields", () => {
  assert.deepEqual(STATUSES, ["PASS", "FAIL", "OPEN", "BLOCKED", "SKIPPED"]);
  assert.deepEqual(
    makeGateResult({ gate: "version", status: "PASS", reason: "ok", owner: "release" }),
    {
      gate: "version",
      status: "PASS",
      reason: "ok",
      owner: "release",
    },
  );
  assert.throws(
    () => makeGateResult({ gate: "version", status: "UNKNOWN", reason: "bad", owner: "release" }),
    /PASS \| FAIL \| OPEN \| BLOCKED \| SKIPPED/,
  );
});

test("writes summary and output evidence, and fails required non-PASS statuses", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-ci-gate-"));
  const summary = path.join(root, "summary.md");
  const output = path.join(root, "output.txt");
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "--gate",
      "fork-windows",
      "--status",
      "OPEN",
      "--reason",
      "fork is untrusted",
      "--owner",
      "release",
      "--json",
      path.join(root, "result.json"),
    ],
    {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(readFileSync(summary, "utf8"), /"gate":"fork-windows"/);
  assert.match(readFileSync(output, "utf8"), /(?:^|\n)status=OPEN(?:\n|$)/);
  assert.match(readFileSync(path.join(root, "result.json"), "utf8"), /"owner":"release"/);
});

test("optional SKIPPED evidence is visible without satisfying a required check", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-ci-gate-"));
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "--gate",
      "comparison-only-artifact",
      "--status",
      "SKIPPED",
      "--reason",
      "build B is never shipped",
      "--owner",
      "release",
      "--optional",
    ],
    {
      env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(root, "summary.md") },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"status":"SKIPPED"/);
});
