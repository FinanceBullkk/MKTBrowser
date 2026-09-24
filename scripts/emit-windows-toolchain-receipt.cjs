#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { appendFileSync, existsSync, lstatSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  WINDOWS_TOOLCHAIN_TYPE,
  assertValidWindowsToolchainReceipt,
} = require("./release-candidate-source-binding.cjs");

const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_YARN_VERSION = "4.5.0";

function sha256(filePath) {
  return createHash("sha256").update(require("node:fs").readFileSync(filePath)).digest("hex");
}

function resolveRegularFile(filePath, label) {
  if (!filePath || !existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`${label} must name an existing regular file.`);
  }
  return realpathSync(filePath);
}

function assertExpectedHash(filePath, expectedHash, label) {
  if (!SHA256.test(expectedHash ?? "")) throw new Error(`${label} SHA-256 is invalid.`);
  if (sha256(filePath) !== expectedHash) throw new Error(`${label} does not match its expected SHA-256.`);
}

const UNSAFE_ENVIRONMENT_NAMES = new Set([
  "MKTTOOL_RELEASE_TOKEN",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "ELECTRON_RUN_AS_NODE",
]);

function tokenlessEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (UNSAFE_ENVIRONMENT_NAMES.has(name.toUpperCase())) delete sanitized[name];
  }
  return sanitized;
}

function hasReleaseToken(environment = process.env) {
  return Object.entries(environment).some(
    ([name, value]) => name.toUpperCase() === "MKTTOOL_RELEASE_TOKEN" && String(value ?? "").trim() !== "",
  );
}

function run(nodeExecutable, args, environment) {
  return execFileSync(nodeExecutable, args, {
    encoding: "utf8",
    env: environment,
  }).trim();
}

function walkFiles(root, files = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(child, files);
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function resolveYarnEntrypoint({
  nodeExecutable,
  corepackHome,
  environment = process.env,
  runCommand = run,
}) {
  const childEnvironment = tokenlessEnvironment(environment);
  const resolvedHome = resolveRegularDirectory(corepackHome, "Corepack home");
  const candidates = walkFiles(resolvedHome)
    .filter((filePath) => /^yarn(?:\.c?js)?$/i.test(path.basename(filePath)))
    .sort();
  const matches = candidates.filter((candidate) => {
    try {
      return runCommand(nodeExecutable, [candidate, "--version"], childEnvironment) === EXPECTED_YARN_VERSION;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error("Corepack home must contain exactly one executable Yarn 4.5.0 entrypoint.");
  }
  return realpathSync(matches[0]);
}

function resolveRegularDirectory(directory, label) {
  if (!directory || !existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(`${label} must name an existing directory.`);
  }
  return realpathSync(directory);
}

function buildWindowsToolchainReceipt({
  nodeExecutable,
  nodeSha256,
  corepackEntrypoint,
  corepackSha256,
  corepackHome,
  environment = process.env,
  runCommand = run,
}) {
  const childEnvironment = tokenlessEnvironment(environment);
  const node = resolveRegularFile(nodeExecutable, "Node.js executable");
  const corepack = resolveRegularFile(corepackEntrypoint, "Corepack entrypoint");
  assertExpectedHash(node, nodeSha256, "Node.js executable");
  assertExpectedHash(corepack, corepackSha256, "Corepack entrypoint");

  const runtime = JSON.parse(runCommand(node, ["-p", "JSON.stringify({ version: process.versions.node, platform: process.platform, arch: process.arch })"], childEnvironment));
  if (Number(String(runtime.version).split(".")[0]) !== 22 || runtime.platform !== "win32" || runtime.arch !== "x64") {
    throw new Error("The release receipt requires Windows x64 Node.js 22.");
  }
  const corepackVersion = runCommand(node, [corepack, "--version"], childEnvironment);
  const yarn = resolveYarnEntrypoint({ nodeExecutable: node, corepackHome, environment: childEnvironment, runCommand });
  const receipt = {
    schemaVersion: 1,
    type: WINDOWS_TOOLCHAIN_TYPE,
    platform: runtime.platform,
    arch: runtime.arch,
    node: { fileName: path.basename(node), version: runtime.version, sha256: nodeSha256 },
    corepack: { fileName: path.basename(corepack), version: corepackVersion, sha256: corepackSha256 },
    yarn: { fileName: path.basename(yarn), version: EXPECTED_YARN_VERSION, sha256: sha256(yarn) },
  };
  return { receipt: assertValidWindowsToolchainReceipt(receipt), yarnEntrypoint: yarn };
}

function parseArguments(argv) {
  const options = {
    nodeExecutable: null,
    nodeSha256: null,
    corepackEntrypoint: null,
    corepackSha256: null,
    corepackHome: null,
    output: null,
    githubOutput: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--node") options.nodeExecutable = value;
    else if (name === "--node-sha256") options.nodeSha256 = value;
    else if (name === "--corepack") options.corepackEntrypoint = value;
    else if (name === "--corepack-sha256") options.corepackSha256 = value;
    else if (name === "--corepack-home") options.corepackHome = value;
    else if (name === "--output") options.output = value;
    else if (name === "--github-output") options.githubOutput = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  const requiredOptions = {
    nodeExecutable: "node",
    nodeSha256: "node-sha256",
    corepackEntrypoint: "corepack",
    corepackSha256: "corepack-sha256",
    corepackHome: "corepack-home",
    output: "output",
  };
  for (const [option, flag] of Object.entries(requiredOptions)) {
    if (!options[option]) throw new Error(`--${flag} is required`);
  }
  return options;
}

module.exports = {
  EXPECTED_YARN_VERSION,
  buildWindowsToolchainReceipt,
  hasReleaseToken,
  parseArguments,
  resolveYarnEntrypoint,
  tokenlessEnvironment,
};

if (require.main === module) {
  try {
    if (hasReleaseToken()) {
      throw new Error("Refusing to inspect a Windows toolchain while the Relay release token is present.");
    }
    const options = parseArguments(process.argv.slice(2));
    const result = buildWindowsToolchainReceipt(options);
    writeFileSync(options.output, `${JSON.stringify(result.receipt, null, 2)}\n`, "utf8");
    const receiptSha256 = sha256(options.output);
    if (options.githubOutput) {
      appendFileSync(
        options.githubOutput,
        `yarn_entrypoint=${result.yarnEntrypoint}\n` +
        `yarn_version=${result.receipt.yarn.version}\n` +
        `yarn_sha256=${result.receipt.yarn.sha256}\n` +
        `toolchain_receipt_sha256=${receiptSha256}\n`,
      );
    }
    process.stdout.write(`Windows toolchain receipt written: ${receiptSha256}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
