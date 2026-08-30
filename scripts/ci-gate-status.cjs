#!/usr/bin/env node
"use strict";

/**
 * Emit one machine-readable CI gate result.
 *
 * The JSON object intentionally has exactly four fields.  GitHub's summary and output files are
 * append-only, so a caller can use this helper from both success and failure paths without losing
 * the evidence that a gate actually ran.  A required result satisfies the gate only when status is
 * PASS; OPEN, BLOCKED, FAIL, and SKIPPED are all failures for a required check.
 */

const { appendFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const STATUSES = Object.freeze(["PASS", "FAIL", "OPEN", "BLOCKED", "SKIPPED"]);

function makeGateResult({ gate, status, reason, owner }) {
  for (const [name, value] of Object.entries({ gate, status, reason, owner })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} must be a non-empty string`);
    }
  }
  for (const [name, value] of Object.entries({ gate, status, owner })) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain a newline`);
  }
  if (!STATUSES.includes(status)) {
    throw new Error(`status must be one of ${STATUSES.join(" | ")}; received ${status}`);
  }
  return { gate: gate.trim(), status, reason: reason.trim(), owner: owner.trim() };
}

function isPassing(result, required = true) {
  return !required || result.status === "PASS";
}

function appendOutput(outputPath, result) {
  if (!outputPath) return;
  const delimiter = `ci_gate_${randomUUID().replaceAll("-", "")}`;
  const lines = [
    `gate=${result.gate}`,
    `status=${result.status}`,
    `owner=${result.owner}`,
    `reason<<${delimiter}`,
    result.reason,
    delimiter,
    `result<<${delimiter}`,
    JSON.stringify(result),
    delimiter,
  ];
  lines.push(`satisfies=${result.status === "PASS" ? "true" : "false"}`);
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function appendSummary(summaryPath, result) {
  if (!summaryPath) return;
  appendFileSync(
    summaryPath,
    `### CI gate: ${result.gate}\n\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n\n`,
    "utf8",
  );
}

function emitGateResult(result, options = {}) {
  const required = options.required !== false;
  const outputPath = options.outputPath ?? process.env.GITHUB_OUTPUT;
  const summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  if (options.jsonPath) writeFileSync(options.jsonPath, `${JSON.stringify(result)}\n`, "utf8");
  appendOutput(outputPath, result);
  appendSummary(summaryPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return isPassing(result, required);
}

function parseArguments(argv) {
  const options = {
    gate: null,
    status: null,
    reason: null,
    owner: null,
    required: true,
    jsonPath: null,
    run: [],
  };
  const indexOfSeparator = argv.indexOf("--");
  const flags = indexOfSeparator === -1 ? argv : argv.slice(0, indexOfSeparator);
  if (indexOfSeparator !== -1) options.run = argv.slice(indexOfSeparator + 1);
  for (let index = 0; index < flags.length; index += 1) {
    const name = flags[index];
    if (
      name === "--gate" ||
      name === "--status" ||
      name === "--reason" ||
      name === "--owner" ||
      name === "--json" ||
      name === "--output"
    ) {
      const value = flags[++index];
      if (value === undefined) throw new Error(`${name} requires a value`);
      if (name === "--gate") options.gate = value;
      else if (name === "--status") options.status = value;
      else if (name === "--reason") options.reason = value;
      else if (name === "--owner") options.owner = value;
      else options.jsonPath = value;
    } else if (name === "--optional") options.required = false;
    else if (name === "--required") options.required = true;
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.gate || !options.owner) throw new Error("--gate and --owner are required");
  if (!options.status && options.run.length === 0)
    throw new Error("--status or a command after -- is required");
  return options;
}

function runCommand(command) {
  const [executable, ...args] = command;
  // All workflow gates pass an executable plus argv, so keep argument boundaries intact.  The few
  // package-manager shims that are only available as `.cmd` files on Windows are the exception.
  const shell = process.platform === "win32" && /^(?:corepack|yarn|npm|npx)$/i.test(executable);
  const result = spawnSync(executable, args, { stdio: "inherit", shell, windowsHide: true });
  if (result.error) return { code: 1, detail: result.error.message };
  if (result.signal) return { code: 1, detail: `terminated by ${result.signal}` };
  return { code: result.status ?? 1, detail: `exit code ${result.status ?? 1}` };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    let status = options.status;
    let reason = options.reason;
    if (options.run.length > 0) {
      const commandResult = runCommand(options.run);
      status = commandResult.code === 0 ? "PASS" : "FAIL";
      reason ||=
        commandResult.code === 0
          ? "required command completed"
          : `required command ${commandResult.detail}`;
    }
    reason ||= status === "PASS" ? "required contract passed" : "contract did not pass";
    const result = makeGateResult({ gate: options.gate, status, reason, owner: options.owner });
    if (!emitGateResult(result, options)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  STATUSES,
  emitGateResult,
  isPassing,
  makeGateResult,
  parseArguments,
  writeGateStatus: emitGateResult,
};
