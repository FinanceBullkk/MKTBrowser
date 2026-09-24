#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  TOKEN_CONSUMER_FILES,
  assertTokenConsumerIdentity,
  buildTokenConsumerIdentity,
} = require("./verify-tokenized-relay-consumers.cjs");
const {
  RELAY_BUILD_TOOLCHAIN_TYPE,
  assertValidRelayBuildToolchainReceipt,
  readRelayBuildToolchainReceipt,
} = require("./emit-relay-build-toolchain-receipt.cjs");

const repoRoot = path.resolve(__dirname, "..");
const CANDIDATE_PATH = "src/lib/setup/windows-installer-candidate.ts";
const RELAY_SOURCE_PATH = "src/lib/relay/relay-endpoints.ts";
const RELAY_ARTIFACT_METADATA_PATH = "relay/dist/MKTTool-Relay.metadata.json";
const RELAY_ARCHIVE_PATH = "relay/dist/MKTTool-Relay.zip";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const BROWSER_HASHED_FILES = [
  "package.json",
  "yarn.lock",
  "apps/desktop/package.json",
  "apps/desktop/windows-engine-release.json",
  ...TOKEN_CONSUMER_FILES,
  "scripts/emit-relay-build-toolchain-receipt.cjs",
  "scripts/release-candidate-source-binding.cjs",
  "scripts/verify-tokenized-relay-consumers.cjs",
];
const MKTTOOL_HASHED_FILES = [
  "package.json",
  "package-lock.json",
  CANDIDATE_PATH,
  RELAY_SOURCE_PATH,
  "scripts/build-relay-executable.ts",
  "src/lib/relay/relay-release-metadata.ts",
];
const WINDOWS_TOOLCHAIN_TYPE = "mktbrowser.windows-release-toolchain";

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveMktToolRoot(explicit = process.env.MKTTOOL_ROOT) {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.resolve(repoRoot, "..", "MKTTool"), path.resolve(repoRoot, "..", "mkttool")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, CANDIDATE_PATH))) return candidate;
  }
  throw new Error(`MKTTool checkout not found. Tried: ${candidates.join(", ")}`);
}

function sourceIdentity(root, label, files, requireClean) {
  const clean = git(root, "status", "--porcelain", "--untracked-files=all") === "";
  if (requireClean && !clean) throw new Error(`${label} source checkout must be clean before binding.`);
  const hashes = Object.fromEntries(files.map((relativePath) => [
    relativePath,
    sha256(path.join(root, relativePath)),
  ]));
  return {
    commit: git(root, "rev-parse", "HEAD"),
    tree: git(root, "rev-parse", "HEAD^{tree}"),
    clean,
    hashes,
  };
}

function literalField(source, field) {
  const match = new RegExp(`^\\s*${field}:\\s*("(?:[^"\\\\]|\\\\.)*"|[0-9]+),\\s*$`, "m")
    .exec(source);
  if (!match) throw new Error(`Missing exact candidate field ${field}.`);
  return JSON.parse(match[1]);
}

function parseWindowsInstallerCandidate(source) {
  const candidate = {
    id: literalField(source, "id"),
    browserVersion: literalField(source, "browserVersion"),
    relay: {
      version: literalField(source, "relayVersion"),
      sha256: literalField(source, "relaySha256"),
      sizeBytes: literalField(source, "relaySizeBytes"),
    },
    engine: {
      kind: literalField(source, "engineKind"),
      channel: literalField(source, "engineChannel"),
      version: literalField(source, "engineVersion"),
      sha256: literalField(source, "engineSha256"),
      sizeBytes: literalField(source, "engineSizeBytes"),
    },
  };
  if (!validCandidate(candidate)) {
    throw new Error("Windows installer candidate contains an invalid release tuple.");
  }
  return candidate;
}

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || !candidate.relay || !candidate.engine) return false;
  return !(
    typeof candidate.id !== "string" ||
    typeof candidate.browserVersion !== "string" ||
    !Number.isSafeInteger(candidate.relay.version) || candidate.relay.version <= 0 ||
    !SHA256.test(candidate.relay.sha256) ||
    !Number.isSafeInteger(candidate.relay.sizeBytes) || candidate.relay.sizeBytes <= 0 ||
    typeof candidate.engine.kind !== "string" || typeof candidate.engine.channel !== "string" ||
    typeof candidate.engine.version !== "string" || !SHA256.test(candidate.engine.sha256) ||
    !Number.isSafeInteger(candidate.engine.sizeBytes) || candidate.engine.sizeBytes <= 0
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the reviewed candidate.`);
}

function assertCandidateMatchesBrowser(candidate, browserRoot) {
  const rootPackage = readJson(browserRoot, "package.json");
  const desktopPackage = readJson(browserRoot, "apps/desktop/package.json");
  const relay = readJson(browserRoot, "apps/desktop/relay-release.json");
  const engine = readJson(browserRoot, "apps/desktop/windows-engine-release.json");
  assertEqual(rootPackage.version, candidate.browserVersion, "Browser root package version");
  assertEqual(desktopPackage.version, candidate.browserVersion, "Browser desktop package version");
  assertEqual(relay.version, candidate.relay.version, "Browser Relay version");
  assertEqual(relay.sha256, candidate.relay.sha256, "Browser Relay SHA-256");
  assertEqual(relay.sizeBytes, candidate.relay.sizeBytes, "Browser Relay size");
  assertEqual(engine.engineKind, candidate.engine.kind, "Browser engine kind");
  assertEqual(engine.source, candidate.engine.channel, "Browser engine channel");
  assertEqual(engine.version, candidate.engine.version, "Browser engine version");
  assertEqual(engine.sha256, candidate.engine.sha256, "Browser engine SHA-256");
  assertEqual(engine.sizeBytes, candidate.engine.sizeBytes, "Browser engine size");
}

function parseRelaySourceVersion(mktToolRoot) {
  const source = readFileSync(path.join(mktToolRoot, RELAY_SOURCE_PATH), "utf8");
  const match = /^export const RELAY_VERSION = (\d+);$/m.exec(source);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
    throw new Error("MKTTool Relay source does not declare one positive RELAY_VERSION.");
  }
  return Number(match[1]);
}

function normalizeRelayArtifactMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Relay artifact metadata is missing or invalid.");
  }
  const normalized = {
    version: metadata.version,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    executableSizeBytes: metadata.executableSizeBytes,
    executableSha256: metadata.executableSha256,
    sourceCommit: metadata.sourceCommit,
    nodeVersion: metadata.nodeVersion,
    platform: metadata.platform,
    arch: metadata.arch,
    webOrigin: metadata.webOrigin,
    compatibilityFloor: metadata.compatibilityFloor,
  };
  if (
    !Number.isSafeInteger(normalized.version) || normalized.version <= 0 ||
    !Number.isSafeInteger(normalized.sizeBytes) || normalized.sizeBytes <= 0 ||
    !SHA256.test(normalized.sha256 ?? "") ||
    !Number.isSafeInteger(normalized.executableSizeBytes) || normalized.executableSizeBytes <= 0 ||
    !SHA256.test(normalized.executableSha256 ?? "") ||
    !SHA1.test(normalized.sourceCommit ?? "") ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized.nodeVersion ?? "") ||
    normalized.platform !== "win32" || normalized.arch !== "x64" ||
    typeof normalized.webOrigin !== "string" || !/^https:\/\//.test(normalized.webOrigin) ||
    !Number.isSafeInteger(normalized.compatibilityFloor) || normalized.compatibilityFloor <= 0
  ) {
    throw new Error("Relay artifact metadata is incomplete or does not describe a Windows x64 release.");
  }
  return normalized;
}

function relayArtifactInput(filePath, label) {
  const stats = statSync(filePath);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file.`);
  return {
    fileName: path.basename(filePath),
    sizeBytes: stats.size,
    sha256: sha256(filePath),
  };
}

function normalizeRelayArtifactInput(input, label, expectedFileName) {
  if (!input || typeof input !== "object" ||
      input.fileName !== expectedFileName ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 ||
      !SHA256.test(input.sha256 ?? "")) {
    throw new Error(`${label} input is incomplete or does not name the retained artifact.`);
  }
  return {
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
  };
}

function normalizeRelayArtifactBinding(artifact) {
  const metadata = normalizeRelayArtifactMetadata(artifact);
  const archive = normalizeRelayArtifactInput(
    artifact?.archive,
    "Relay archive",
    path.basename(RELAY_ARCHIVE_PATH),
  );
  const sidecar = normalizeRelayArtifactInput(
    artifact?.sidecar,
    "Relay metadata sidecar",
    path.basename(RELAY_ARTIFACT_METADATA_PATH),
  );
  assertEqual(archive.sizeBytes, metadata.sizeBytes, "Relay archive input size");
  assertEqual(archive.sha256, metadata.sha256, "Relay archive input SHA-256");
  return { ...metadata, archive, sidecar };
}

function assertRelayArtifactSourceAlignment({
  candidate,
  browserRoot,
  mktToolRoot,
  relayArtifactMetadataPath = path.join(mktToolRoot, RELAY_ARTIFACT_METADATA_PATH),
  relayArchivePath = path.join(mktToolRoot, RELAY_ARCHIVE_PATH),
}) {
  const sourceVersion = parseRelaySourceVersion(mktToolRoot);
  assertEqual(sourceVersion, candidate.relay.version, "MKTTool RELAY_VERSION");
  if (!existsSync(relayArtifactMetadataPath) || !existsSync(relayArchivePath)) {
    throw new Error("The exact Relay archive and its build metadata are required for source binding.");
  }
  const metadata = normalizeRelayArtifactMetadata(readJsonFile(relayArtifactMetadataPath));
  const browserRelay = readJson(browserRoot, "apps/desktop/relay-release.json");
  const archive = relayArtifactInput(relayArchivePath, "Relay archive");
  const sidecar = relayArtifactInput(relayArtifactMetadataPath, "Relay metadata sidecar");

  assertEqual(metadata.version, candidate.relay.version, "Relay artifact metadata version");
  assertEqual(metadata.sizeBytes, candidate.relay.sizeBytes, "Relay artifact metadata size");
  assertEqual(metadata.sha256, candidate.relay.sha256, "Relay artifact metadata SHA-256");
  assertEqual(archive.sizeBytes, metadata.sizeBytes, "Relay archive size");
  assertEqual(archive.sha256, metadata.sha256, "Relay archive SHA-256");
  assertEqual(metadata.executableSizeBytes, browserRelay.executableSizeBytes, "Relay executable metadata size");
  assertEqual(metadata.executableSha256, browserRelay.executableSha256, "Relay executable metadata SHA-256");
  assertEqual(metadata.sourceCommit, git(mktToolRoot, "rev-parse", "HEAD"), "Relay artifact source commit");

  // These ignored build outputs are evidence inputs, not MKTTool source identity. Their own hashes
  // make a retained archive or sidecar mutation visible without making a clean source tree impossible.
  return { ...metadata, archive, sidecar };
}

function normalizeTool(tool, name) {
  if (!tool || typeof tool !== "object" ||
      typeof tool.fileName !== "string" || tool.fileName !== path.basename(tool.fileName) ||
      typeof tool.version !== "string" || !SEMVER.test(tool.version) ||
      !SHA256.test(tool.sha256 ?? "")) {
    throw new Error(`Windows ${name} toolchain identity is invalid.`);
  }
  return { fileName: tool.fileName, version: tool.version, sha256: tool.sha256 };
}

function assertValidWindowsToolchainReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.type !== WINDOWS_TOOLCHAIN_TYPE ||
      receipt.platform !== "win32" || receipt.arch !== "x64") {
    throw new Error("Windows toolchain receipt is incomplete or uses an unsupported schema.");
  }
  const node = normalizeTool(receipt.node, "Node.js");
  const corepack = normalizeTool(receipt.corepack, "Corepack");
  const yarn = normalizeTool(receipt.yarn, "Yarn");
  if (Number(node.version.split(".")[0]) !== 22 || yarn.version !== "4.5.0") {
    throw new Error("Windows toolchain receipt does not pin Node.js 22 and Yarn 4.5.0.");
  }
  return {
    schemaVersion: 1,
    type: WINDOWS_TOOLCHAIN_TYPE,
    platform: "win32",
    arch: "x64",
    node,
    corepack,
    yarn,
  };
}

function readWindowsToolchainReceipt(receiptPath) {
  if (!receiptPath || !existsSync(receiptPath)) {
    throw new Error("An uploaded Windows toolchain receipt is required for source binding.");
  }
  return {
    receipt: assertValidWindowsToolchainReceipt(readJsonFile(receiptPath)),
    sha256: sha256(receiptPath),
  };
}

function readBoundRelayBuildToolchainReceipt(receiptPath) {
  try {
    return readRelayBuildToolchainReceipt(receiptPath);
  } catch (error) {
    throw new Error(`Relay build toolchain receipt cannot bind source: ${error.message}`);
  }
}

function buildSourceBinding({
  browserRoot = repoRoot,
  mktToolRoot = resolveMktToolRoot(),
  candidateId,
  relayArtifactMetadataPath,
  relayArchivePath,
  windowsToolchainReceiptPath,
  relayBuildToolchainReceiptPath,
  requireClean = true,
  now = new Date(),
} = {}) {
  if (typeof candidateId !== "string" || !candidateId.trim()) {
    throw new Error("A candidate ID is required to bind source to a release candidate.");
  }
  const candidateSource = readFileSync(path.join(mktToolRoot, CANDIDATE_PATH), "utf8");
  const candidate = parseWindowsInstallerCandidate(candidateSource);
  assertEqual(candidate.id, candidateId.trim(), "Candidate ID");
  assertCandidateMatchesBrowser(candidate, browserRoot);
  const relayArtifact = assertRelayArtifactSourceAlignment({
    candidate,
    browserRoot,
    mktToolRoot,
    relayArtifactMetadataPath,
    relayArchivePath,
  });
  const windowsToolchain = readWindowsToolchainReceipt(windowsToolchainReceiptPath);
  const relayBuildToolchain = readBoundRelayBuildToolchainReceipt(relayBuildToolchainReceiptPath);
  const browser = sourceIdentity(browserRoot, "MKTBrowser", BROWSER_HASHED_FILES, requireClean);
  const tokenConsumers = buildTokenConsumerIdentity(browserRoot);
  assertTokenConsumerIdentity(tokenConsumers, browser.hashes);
  const mktTool = sourceIdentity(mktToolRoot, "MKTTool", MKTTOOL_HASHED_FILES, requireClean);
  assertEqual(
    relayBuildToolchain.receipt.mktToolPackageLock.sha256,
    mktTool.hashes["package-lock.json"],
    "Relay build MKTTool package-lock SHA-256",
  );
  return {
    schemaVersion: 5,
    type: "mktbrowser.release-candidate-source-binding",
    generatedAt: new Date(now).toISOString(),
    candidate,
    relayArtifact,
    windowsToolchain: windowsToolchain.receipt,
    windowsToolchainReceiptSha256: windowsToolchain.sha256,
    relayBuildToolchain: relayBuildToolchain.receipt,
    relayBuildToolchainReceiptSha256: relayBuildToolchain.sha256,
    browser,
    tokenConsumers,
    mktTool,
  };
}

function comparableBinding(binding) {
  return {
    schemaVersion: binding?.schemaVersion,
    type: binding?.type,
    candidate: binding?.candidate,
    relayArtifact: binding?.relayArtifact,
    windowsToolchain: binding?.windowsToolchain,
    windowsToolchainReceiptSha256: binding?.windowsToolchainReceiptSha256,
    relayBuildToolchain: binding?.relayBuildToolchain,
    relayBuildToolchainReceiptSha256: binding?.relayBuildToolchainReceiptSha256,
    browser: binding?.browser,
    tokenConsumers: binding?.tokenConsumers,
    mktTool: binding?.mktTool,
  };
}

function assertValidBinding(binding) {
  const comparable = comparableBinding(binding);
  if (
    comparable.schemaVersion !== 5 ||
    comparable.type !== "mktbrowser.release-candidate-source-binding" ||
    !validCandidate(comparable.candidate) || !comparable.browser || !comparable.mktTool ||
    !SHA1.test(comparable.browser.commit) || !SHA1.test(comparable.browser.tree) ||
    !SHA1.test(comparable.mktTool.commit) || !SHA1.test(comparable.mktTool.tree) ||
    comparable.browser.clean !== true || comparable.mktTool.clean !== true ||
    !hasFileHashes(comparable.browser.hashes, BROWSER_HASHED_FILES) ||
    !hasFileHashes(comparable.mktTool.hashes, MKTTOOL_HASHED_FILES) ||
    !SHA256.test(comparable.windowsToolchainReceiptSha256 ?? "") ||
    !SHA256.test(comparable.relayBuildToolchainReceiptSha256 ?? "")
  ) {
    throw new Error("Source binding is incomplete, dirty, or uses an unsupported schema.");
  }
  const relayArtifact = normalizeRelayArtifactBinding(comparable.relayArtifact);
  assertEqual(relayArtifact.version, comparable.candidate.relay.version, "Bound Relay artifact version");
  assertEqual(relayArtifact.sha256, comparable.candidate.relay.sha256, "Bound Relay artifact SHA-256");
  assertEqual(relayArtifact.sizeBytes, comparable.candidate.relay.sizeBytes, "Bound Relay artifact size");
  assertEqual(relayArtifact.archive.sha256, comparable.candidate.relay.sha256, "Bound Relay archive SHA-256");
  assertEqual(relayArtifact.archive.sizeBytes, comparable.candidate.relay.sizeBytes, "Bound Relay archive size");
  assertEqual(relayArtifact.sourceCommit, comparable.mktTool.commit, "Bound Relay artifact source commit");
  assertValidWindowsToolchainReceipt(comparable.windowsToolchain);
  assertValidRelayBuildToolchainReceipt(comparable.relayBuildToolchain);
  assertEqual(
    comparable.relayBuildToolchain.mktToolPackageLock.sha256,
    comparable.mktTool.hashes["package-lock.json"],
    "Bound Relay build MKTTool package-lock SHA-256",
  );
  assertTokenConsumerIdentity(comparable.tokenConsumers, comparable.browser.hashes);
  return comparable;
}

function hasFileHashes(hashes, expectedFiles) {
  return Boolean(hashes) && expectedFiles.every((file) => SHA256.test(hashes[file] ?? ""));
}

function assertSameSourceBinding(first, second) {
  const left = assertValidBinding(first);
  const right = assertValidBinding(second);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("Source binding changed between the recorded release steps.");
  }
}

function parseArguments(argv) {
  const options = {
    mktToolRoot: null,
    candidateId: null,
    relayArtifactMetadataPath: null,
    relayArchivePath: null,
    windowsToolchainReceiptPath: null,
    relayBuildToolchainReceiptPath: null,
    output: null,
    verify: null,
    compare: null,
  };
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (name === "--compare") {
      const first = argv[index + 1];
      const second = argv[index + 2];
      if (!first || !second) throw new Error("--compare requires two source-binding files.");
      if (argv.length !== 3) throw new Error("--compare cannot be combined with source snapshot options.");
      options.compare = [first, second];
      return options;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--mkttool-root") options.mktToolRoot = value;
    else if (name === "--candidate-id") options.candidateId = value;
    else if (name === "--relay-artifact-metadata") options.relayArtifactMetadataPath = value;
    else if (name === "--relay-archive") options.relayArchivePath = value;
    else if (name === "--windows-toolchain-receipt") options.windowsToolchainReceiptPath = value;
    else if (name === "--relay-build-toolchain-receipt") options.relayBuildToolchainReceiptPath = value;
    else if (name === "--output") options.output = value;
    else if (name === "--verify") options.verify = value;
    else throw new Error(`Unknown option: ${name}`);
    index += 2;
  }
  for (const required of ["candidateId", "windowsToolchainReceiptPath", "relayBuildToolchainReceiptPath", "output"]) {
    if (!options[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)} is required`);
    }
  }
  return options;
}

module.exports = {
  BROWSER_HASHED_FILES,
  MKTTOOL_HASHED_FILES,
  TOKEN_CONSUMER_FILES,
  WINDOWS_TOOLCHAIN_TYPE,
  RELAY_BUILD_TOOLCHAIN_TYPE,
  assertCandidateMatchesBrowser,
  assertRelayArtifactSourceAlignment,
  assertSameSourceBinding,
  assertValidBinding,
  assertValidWindowsToolchainReceipt,
  assertValidRelayBuildToolchainReceipt,
  buildSourceBinding,
  comparableBinding,
  parseArguments,
  parseRelaySourceVersion,
  parseWindowsInstallerCandidate,
  readWindowsToolchainReceipt,
  readBoundRelayBuildToolchainReceipt,
  resolveMktToolRoot,
};

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.compare) {
      assertSameSourceBinding(readJsonFile(options.compare[0]), readJsonFile(options.compare[1]));
      process.stdout.write("Source bindings match.\n");
    } else {
      const binding = buildSourceBinding({
        mktToolRoot: options.mktToolRoot ? path.resolve(options.mktToolRoot) : undefined,
        candidateId: options.candidateId,
        relayArtifactMetadataPath: options.relayArtifactMetadataPath
          ? path.resolve(options.relayArtifactMetadataPath) : undefined,
        relayArchivePath: options.relayArchivePath ? path.resolve(options.relayArchivePath) : undefined,
        windowsToolchainReceiptPath: path.resolve(options.windowsToolchainReceiptPath),
        relayBuildToolchainReceiptPath: path.resolve(options.relayBuildToolchainReceiptPath),
      });
      if (options.verify) assertSameSourceBinding(readJsonFile(options.verify), binding);
      writeFileSync(options.output, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
      process.stdout.write(
        `Source binding written.\n  Browser ${binding.browser.commit}\n  MKTTool ${binding.mktTool.commit}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
