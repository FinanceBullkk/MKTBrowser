#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } = require("node:fs");
const path = require("node:path");

const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN_CONSUMER_FILES = [
  "apps/desktop/scripts/package-tokenized-windows-installer.cmd",
  "apps/desktop/scripts/fetch-pinned-relay-for-tokenized-package.ps1",
  // The token-bearing fetcher reads this tuple to choose and verify its only network request.
  "apps/desktop/relay-release.json",
];

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function portableRelativePath(value) {
  return value.split(path.sep).join("/");
}

function assertCanonicalConsumerPath(browserRoot, relativePath) {
  const root = realpathSync(browserRoot);
  const expected = portableRelativePath(relativePath);
  const sourcePath = path.resolve(root, relativePath);
  const sourceRelative = portableRelativePath(path.relative(root, sourcePath));
  if (sourceRelative !== expected || sourceRelative.startsWith("../") || path.isAbsolute(sourceRelative)) {
    throw new Error(`Token consumer ${relativePath} is outside the Browser source root.`);
  }
  if (!existsSync(sourcePath)) throw new Error(`Token consumer ${relativePath} is missing.`);
  const stats = lstatSync(sourcePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Token consumer ${relativePath} must be a regular, non-symbolic-link file.`);
  }
  const canonicalPath = realpathSync(sourcePath);
  const canonicalRelativePath = portableRelativePath(path.relative(root, canonicalPath));
  const caseSensitive = process.platform !== "win32";
  const matchesExpected = caseSensitive
    ? canonicalRelativePath === expected
    : canonicalRelativePath.toLowerCase() === expected.toLowerCase();
  if (!matchesExpected || canonicalRelativePath.startsWith("../") || path.isAbsolute(canonicalRelativePath)) {
    throw new Error(`Token consumer ${relativePath} does not resolve to its canonical source path.`);
  }
  return {
    relativePath,
    canonicalRelativePath: expected,
    sha256: sha256(canonicalPath),
  };
}

function buildTokenConsumerIdentity(browserRoot) {
  return TOKEN_CONSUMER_FILES.map((relativePath) =>
    assertCanonicalConsumerPath(browserRoot, relativePath),
  );
}

function assertTokenConsumerIdentity(identity, browserHashes = null) {
  if (!Array.isArray(identity) || identity.length !== TOKEN_CONSUMER_FILES.length) {
    throw new Error("Token consumer binding is incomplete.");
  }
  for (const [index, relativePath] of TOKEN_CONSUMER_FILES.entries()) {
    const entry = identity[index];
    if (
      !entry ||
      entry.relativePath !== relativePath ||
      entry.canonicalRelativePath !== relativePath ||
      !SHA256.test(entry.sha256 ?? "")
    ) {
      throw new Error(`Token consumer binding is invalid for ${relativePath}.`);
    }
    if (browserHashes && browserHashes[relativePath] !== entry.sha256) {
      throw new Error(`Token consumer binding hash does not match Browser source for ${relativePath}.`);
    }
  }
  return identity;
}

function verifyTokenConsumers({ browserRoot, binding }) {
  if (!binding || binding.schemaVersion !== 5 || binding.type !== "mktbrowser.release-candidate-source-binding") {
    throw new Error("Token consumer verification requires a schema-v5 release source binding.");
  }
  if (!binding.browser || !binding.browser.hashes || typeof binding.browser.hashes !== "object") {
    throw new Error("Token consumer verification requires Browser source hashes.");
  }
  assertTokenConsumerIdentity(binding.tokenConsumers, binding.browser.hashes);
  const actual = buildTokenConsumerIdentity(browserRoot);
  if (JSON.stringify(actual) !== JSON.stringify(binding.tokenConsumers)) {
    throw new Error("Token-bearing Relay input changed after source binding.");
  }
  return actual;
}

function createVerifiedTokenConsumerSnapshot({ browserRoot, binding, snapshotRoot }) {
  const sourceRoot = realpathSync(browserRoot);
  const targetRoot = path.resolve(snapshotRoot);
  const relativeTarget = path.relative(sourceRoot, targetRoot);
  if (
    !snapshotRoot ||
    existsSync(targetRoot) ||
    relativeTarget === "" ||
    (!relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== ".." && !path.isAbsolute(relativeTarget))
  ) {
    throw new Error("Token consumer snapshot root must be a new directory outside Browser source.");
  }
  verifyTokenConsumers({ browserRoot: sourceRoot, binding });
  for (const relativePath of TOKEN_CONSUMER_FILES) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(targetRoot, relativePath);
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
  verifyTokenConsumers({ browserRoot: targetRoot, binding });
  const canonicalTargetRoot = realpathSync(targetRoot);
  return {
    root: canonicalTargetRoot,
    wrapperPath: path.join(canonicalTargetRoot, TOKEN_CONSUMER_FILES[0]),
  };
}

function parseArguments(argv) {
  const options = { browserRoot: null, bindingPath: null, snapshotRoot: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--browser-root") options.browserRoot = value;
    else if (name === "--binding") options.bindingPath = value;
    else if (name === "--snapshot-root") options.snapshotRoot = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.browserRoot) throw new Error("--browser-root is required");
  if (!options.bindingPath) throw new Error("--binding is required");
  return options;
}

module.exports = {
  TOKEN_CONSUMER_FILES,
  assertCanonicalConsumerPath,
  assertTokenConsumerIdentity,
  buildTokenConsumerIdentity,
  createVerifiedTokenConsumerSnapshot,
  parseArguments,
  verifyTokenConsumers,
};

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const binding = JSON.parse(readFileSync(options.bindingPath, "utf8"));
    if (options.snapshotRoot) {
      const snapshot = createVerifiedTokenConsumerSnapshot({
        browserRoot: path.resolve(options.browserRoot),
        binding,
        snapshotRoot: path.resolve(options.snapshotRoot),
      });
      process.stdout.write(`Verified token-consumer snapshot created at ${snapshot.root}.\n`);
    } else {
      verifyTokenConsumers({ browserRoot: path.resolve(options.browserRoot), binding });
      process.stdout.write("Token-consuming Relay wrapper and fetcher match the bound canonical source.\n");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
