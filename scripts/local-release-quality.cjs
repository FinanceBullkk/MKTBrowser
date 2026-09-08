#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { openSync, closeSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const {
  QUALITY_STEPS, hashFile, parseQualityArgs, createOutputDirectory,
  assertSourceUnchanged, assertCompletedQualityReceipt,
} = require("./local-release-quality-contract.cjs");
const { snapshotSources, childEnvironment, inspectToolchain } = require("./local-release-source-state.cjs");

function executeLoggedCommand(executable, args, options) {
  const descriptor = openSync(options.logPath, "wx", 0o600);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd: options.cwd, env: options.env, timeout: options.timeoutMs, windowsHide: true,
      stdio: ["ignore", descriptor, descriptor], killSignal: "SIGKILL",
    });
  } finally {
    closeSync(descriptor);
  }
  return {
    startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT", spawnError: Boolean(result.error),
    logSha256: hashFile(options.logPath),
  };
}

function runQuality(args) {
  const options = parseQualityArgs(args);
  const repoRoot = path.resolve(__dirname, "..");
  const before = snapshotSources(repoRoot, options.sibling);
  const env = childEnvironment(before.mkttool.directory);
  const toolchain = inspectToolchain(repoRoot, options.yarnCli, env);
  const output = createOutputDirectory(options.output, [repoRoot, options.sibling]);
  const receipt = {
    schemaVersion: 1, kind: "local-quality-command-evidence", runId: randomUUID(),
    status: "running", acceptance: "OPEN", releaseReady: false, testSkips: "NOT_EVALUATED",
    limits: "Command exits only. Packaging, two-build equivalence, VM, test-skip adjudication and human acceptance are separate gates.",
    startedAt: new Date().toISOString(), finishedAt: null,
    before, after: null, toolchain, results: [], failure: null,
  };
  const receiptPath = path.join(output, "quality-receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  try {
    for (const [index, step] of QUALITY_STEPS.entries()) {
      assertSourceUnchanged(before, snapshotSources(repoRoot, options.sibling));
      const log = `${String(index + 1).padStart(2, "0")}-${step.id.replaceAll(":", "-")}.log`;
      process.stdout.write(`Running quality command ${index + 1}/${QUALITY_STEPS.length}: ${step.id}\n`);
      const result = executeLoggedCommand(process.execPath, [toolchain.yarnCli, "run", step.id], {
        cwd: repoRoot, env, timeoutMs: step.timeoutMs, logPath: path.join(output, log),
      });
      receipt.results.push({ ...step, log, ...result });
      if (result.exitCode !== 0 || result.signal || result.spawnError || result.timedOut) {
        receipt.failure = result.timedOut ? "COMMAND_TIMEOUT_CONTAINMENT_UNVERIFIED" : "COMMAND_FAILED";
        throw new Error("A required command failed; later commands were not started.");
      }
    }
    receipt.after = snapshotSources(repoRoot, options.sibling);
    assertSourceUnchanged(before, receipt.after);
    if (hashFile(toolchain.yarnCli) !== toolchain.yarnSha256 ||
        hashFile(process.execPath) !== toolchain.nodeSha256) throw new Error("Toolchain changed during quality execution.");
    receipt.status = "completed";
    assertCompletedQualityReceipt(receipt, output);
  } catch {
    receipt.status = "failed";
    receipt.failure ??= "SOURCE_TOOLCHAIN_OR_RECEIPT_INVALID";
    try { receipt.after = snapshotSources(repoRoot, options.sibling); } catch { /* Dirty source stays unverified. */ }
  } finally {
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  }
  process.stdout.write(`Quality commands: ${receipt.status}; release acceptance remains OPEN.\n`);
  return receipt.status === "completed" ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = runQuality(process.argv.slice(2)); }
  catch { process.stderr.write("Quality preflight failed; no acceptance claim. Check paths, clean sources and pinned Node/Yarn.\n"); process.exitCode = 1; }
}

module.exports = { executeLoggedCommand, runQuality };
