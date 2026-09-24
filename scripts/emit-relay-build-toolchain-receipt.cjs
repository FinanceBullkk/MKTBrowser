#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const RELAY_BUILD_TOOLCHAIN_TYPE = "mktbrowser.relay-build-toolchain";
const EXPECTED_NODE_VERSION = "24.21.0";
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const UNSAFE_ENVIRONMENT_NAMES = new Set([
  "MKTTOOL_RELEASE_TOKEN",
  "MKT_RELEASE_TOKEN_AFTER_VERIFICATION",
  "NPM_TOKEN",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "ELECTRON_RUN_AS_NODE",
]);

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveRegularFile(filePath, label) {
  if (!filePath || !existsSync(filePath)) throw new Error(`${label} must name an existing regular file.`);
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must name an existing regular file.`);
  return realpathSync(filePath);
}

function resolveRegularDirectory(directory, label) {
  if (!directory || !existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(`${label} must name an existing directory.`);
  }
  return realpathSync(directory);
}

function tokenlessEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (UNSAFE_ENVIRONMENT_NAMES.has(name.toUpperCase())) delete sanitized[name];
  }
  return sanitized;
}

function run(nodeExecutable, args, environment) {
  return execFileSync(nodeExecutable, args, { encoding: "utf8", env: environment }).trim();
}

function windowsPathEquals(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function isAbsoluteWindowsPath(filePath) {
  return typeof filePath === "string" && /^[A-Za-z]:[\\/]/.test(filePath);
}

function normalizeTool(tool, label, expectedFileName) {
  if (
    !tool || typeof tool !== "object" ||
    !isAbsoluteWindowsPath(tool.path) ||
    tool.fileName !== expectedFileName || path.win32.basename(tool.path) !== expectedFileName ||
    typeof tool.version !== "string" || !SEMVER.test(tool.version) ||
    !SHA256.test(tool.sha256 ?? "")
  ) {
    throw new Error(`Relay build ${label} identity is invalid.`);
  }
  return { path: tool.path, fileName: expectedFileName, version: tool.version, sha256: tool.sha256 };
}

function assertValidRelayBuildToolchainReceipt(receipt) {
  if (
    !receipt || receipt.schemaVersion !== 1 || receipt.type !== RELAY_BUILD_TOOLCHAIN_TYPE ||
    receipt.platform !== "win32" || receipt.arch !== "x64"
  ) {
    throw new Error("Relay build toolchain receipt is incomplete or uses an unsupported schema.");
  }
  const node = normalizeTool(receipt.node, "Node.js", "node.exe");
  const npmCli = normalizeTool(receipt.npmCli, "npm CLI", "npm-cli.js");
  const expectedNpmCli = path.win32.join(
    path.win32.dirname(node.path),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!windowsPathEquals(npmCli.path, expectedNpmCli)) {
    throw new Error("Relay build npm CLI is not derived from the pinned Node.js executable.");
  }
  const lock = receipt.mktToolPackageLock;
  if (
    !lock || typeof lock !== "object" || lock.path !== "package-lock.json" ||
    !Number.isSafeInteger(lock.sizeBytes) || lock.sizeBytes <= 0 || !SHA256.test(lock.sha256 ?? "")
  ) {
    throw new Error("Relay build MKTTool package-lock identity is invalid.");
  }
  if (node.version !== EXPECTED_NODE_VERSION) {
    throw new Error(`Relay build receipt requires Node.js ${EXPECTED_NODE_VERSION}.`);
  }
  return {
    schemaVersion: 1,
    type: RELAY_BUILD_TOOLCHAIN_TYPE,
    platform: "win32",
    arch: "x64",
    node,
    npmCli,
    mktToolPackageLock: { path: "package-lock.json", sizeBytes: lock.sizeBytes, sha256: lock.sha256 },
  };
}

function resolveMktToolPackageLock({ mktToolRoot, packageLockPath }) {
  const root = resolveRegularDirectory(mktToolRoot, "MKTTool root");
  const expected = resolveRegularFile(path.join(root, "package-lock.json"), "MKTTool package-lock");
  const supplied = resolveRegularFile(packageLockPath, "Relay package-lock");
  if (path.normalize(supplied).toLowerCase() !== path.normalize(expected).toLowerCase()) {
    throw new Error("Relay package-lock must be the exact package-lock.json in the isolated MKTTool checkout.");
  }
  return { path: "package-lock.json", sizeBytes: statSync(supplied).size, sha256: sha256(supplied) };
}

function buildRelayBuildToolchainReceipt({
  nodeExecutable,
  mktToolRoot,
  packageLockPath,
  environment = process.env,
  runCommand = run,
}) {
  const node = resolveRegularFile(nodeExecutable, "Node.js executable");
  const childEnvironment = tokenlessEnvironment(environment);
  const runtime = JSON.parse(runCommand(
    node,
    ["-p", "JSON.stringify({ version: process.versions.node, platform: process.platform, arch: process.arch, execPath: process.execPath })"],
    childEnvironment,
  ));
  if (
    runtime.version !== EXPECTED_NODE_VERSION || runtime.platform !== "win32" || runtime.arch !== "x64" ||
    path.normalize(realpathSync(runtime.execPath)).toLowerCase() !== path.normalize(node).toLowerCase()
  ) {
    throw new Error(`Relay build requires the exact Windows x64 Node.js ${EXPECTED_NODE_VERSION} executable.`);
  }
  const npmCli = resolveRegularFile(
    path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    "npm CLI",
  );
  const npmVersion = runCommand(node, [npmCli, "--version"], childEnvironment);
  const receipt = assertValidRelayBuildToolchainReceipt({
    schemaVersion: 1,
    type: RELAY_BUILD_TOOLCHAIN_TYPE,
    platform: runtime.platform,
    arch: runtime.arch,
    node: { path: node, fileName: path.basename(node), version: runtime.version, sha256: sha256(node) },
    npmCli: { path: npmCli, fileName: path.basename(npmCli), version: npmVersion, sha256: sha256(npmCli) },
    mktToolPackageLock: resolveMktToolPackageLock({ mktToolRoot, packageLockPath }),
  });
  return { receipt, nodeExecutable: node, npmCli };
}

function readRelayBuildToolchainReceipt(receiptPath) {
  if (!receiptPath || !existsSync(receiptPath)) {
    throw new Error("A Relay build toolchain receipt is required.");
  }
  try {
    return { receipt: assertValidRelayBuildToolchainReceipt(JSON.parse(readFileSync(receiptPath, "utf8"))), sha256: sha256(receiptPath) };
  } catch (error) {
    throw new Error(`Relay build toolchain receipt is malformed: ${error.message}`);
  }
}

function assertReceiptMatches({ receiptPath, ...options }) {
  const expected = readRelayBuildToolchainReceipt(receiptPath).receipt;
  const actual = buildRelayBuildToolchainReceipt(options).receipt;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Relay build Node.js, npm CLI, or MKTTool package-lock changed after receipt emission.");
  }
  return actual;
}

function parseArguments(argv) {
  const options = { nodeExecutable: null, mktToolRoot: null, packageLockPath: null, output: null, githubOutput: null, verify: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--node") options.nodeExecutable = value;
    else if (name === "--mkttool-root") options.mktToolRoot = value;
    else if (name === "--package-lock") options.packageLockPath = value;
    else if (name === "--output") options.output = value;
    else if (name === "--github-output") options.githubOutput = value;
    else if (name === "--verify") options.verify = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  for (const option of ["nodeExecutable", "mktToolRoot", "packageLockPath"]) {
    if (!options[option]) throw new Error(`--${option.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
  }
  if (!options.output && !options.verify) throw new Error("--output is required unless --verify is used");
  if (options.output && options.verify) throw new Error("--output and --verify cannot be combined");
  return options;
}

module.exports = {
  EXPECTED_NODE_VERSION,
  RELAY_BUILD_TOOLCHAIN_TYPE,
  assertReceiptMatches,
  assertValidRelayBuildToolchainReceipt,
  buildRelayBuildToolchainReceipt,
  parseArguments,
  readRelayBuildToolchainReceipt,
  tokenlessEnvironment,
  windowsPathEquals,
};

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (path.normalize(realpathSync(process.execPath)).toLowerCase() !== path.normalize(realpathSync(options.nodeExecutable)).toLowerCase()) {
      throw new Error("Relay build receipt must run from the exact Node.js executable it records.");
    }
    if (options.verify) {
      assertReceiptMatches({ receiptPath: options.verify, ...options });
      process.stdout.write("Relay build toolchain receipt verified.\n");
    } else {
      const result = buildRelayBuildToolchainReceipt(options);
      writeFileSync(options.output, `${JSON.stringify(result.receipt, null, 2)}\n`, "utf8");
      if (options.githubOutput) {
        appendFileSync(
          options.githubOutput,
          `node_executable=${result.nodeExecutable}\n` +
          `npm_cli=${result.npmCli}\n` +
          `relay_build_toolchain_receipt_sha256=${sha256(options.output)}\n`,
        );
      }
      process.stdout.write(`Relay build toolchain receipt written: ${sha256(options.output)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
