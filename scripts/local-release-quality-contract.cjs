const { createHash } = require("node:crypto");
const { readFileSync, realpathSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const NODE_MAJOR = 22;
const YARN_VERSION = "4.5.0";
const QUALITY_STEPS = Object.freeze([
  ["verify:node", 60_000],
  ["audit:production", 300_000],
  ["test:installer", 900_000],
  // Live-machine inspection stays opt-in inside `test:packaging`, which must remain hermetic.
  // It is a required release step here instead: skipping it for four consecutive releases is
  // how a gate becomes decoration. It fails loudly while the product is running, which is the
  // point - a machine that is not quiet cannot be inspected.
  ["test:machine-integration", 300_000],
  ["test:critical-coverage", 300_000],
  ["typecheck", 300_000],
  ["lint", 300_000],
  ["build", 900_000],
].map(([id, timeoutMs]) => Object.freeze({ id, timeoutMs })));

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseQualityArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--output", "--sibling", "--yarn-cli"].includes(name) ||
        typeof value !== "string" || !path.isAbsolute(value) || result[name]) {
      throw new Error("Use unique --output, --sibling and --yarn-cli absolute paths only.");
    }
    result[name] = value;
  }
  if (Object.keys(result).length !== 3) throw new Error("All three quality-runner paths are required.");
  return { output: result["--output"], sibling: result["--sibling"], yarnCli: result["--yarn-cli"] };
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function createOutputDirectory(output, repositories) {
  const resolved = path.join(realpathSync(path.dirname(output)), path.basename(output));
  if (repositories.some((root) => within(realpathSync(root), resolved))) {
    throw new Error("Quality output must be outside both source repositories.");
  }
  // Exclusive directory creation prevents mixing a new run with earlier or attacker-supplied logs.
  mkdirSync(resolved, { mode: 0o700 });
  return resolved;
}

function assertSourceUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Source commits, trees or lockfiles changed during quality execution.");
  }
}

function assertCompletedQualityReceipt(receipt, output) {
  if (receipt.schemaVersion !== 1 || receipt.kind !== "local-quality-command-evidence" ||
      receipt.status !== "completed" || receipt.acceptance !== "OPEN" ||
      receipt.releaseReady !== false || receipt.testSkips !== "NOT_EVALUATED" ||
      receipt.results?.length !== QUALITY_STEPS.length || receipt.failure !== null) {
    throw new Error("Incomplete or incorrectly promoted quality receipt.");
  }
  if (Number(receipt.toolchain?.nodeVersion?.split(".")[0]) !== NODE_MAJOR ||
      receipt.toolchain?.yarnVersion !== YARN_VERSION) throw new Error("Wrong receipt toolchain.");
  assertSourceUnchanged(receipt.before, receipt.after);
  for (const [index, step] of QUALITY_STEPS.entries()) {
    const result = receipt.results[index];
    const log = `${String(index + 1).padStart(2, "0")}-${step.id.replaceAll(":", "-")}.log`;
    if (result.id !== step.id || result.timeoutMs !== step.timeoutMs || result.log !== log ||
        result.exitCode !== 0 || result.signal !== null || result.timedOut !== false ||
        result.spawnError !== false || !Number.isFinite(Date.parse(result.startedAt)) ||
        !Number.isFinite(Date.parse(result.finishedAt)) ||
        Date.parse(result.finishedAt) < Date.parse(result.startedAt) ||
        result.logSha256 !== hashFile(path.join(output, log))) {
      throw new Error(`Invalid or tampered quality command receipt: ${step.id}.`);
    }
  }
}

module.exports = {
  NODE_MAJOR, YARN_VERSION, QUALITY_STEPS, hashFile, parseQualityArgs,
  createOutputDirectory, assertSourceUnchanged, assertCompletedQualityReceipt,
};
