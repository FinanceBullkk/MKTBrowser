const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertSameSourceBinding,
  buildSourceBinding,
  parseArguments,
  parseRelaySourceVersion,
  parseWindowsInstallerCandidate,
} = require("./release-candidate-source-binding.cjs");
const { verifyTokenConsumers } = require("./verify-tokenized-relay-consumers.cjs");

const browserRoot = path.resolve(__dirname, "..");
const mktToolRoot = path.resolve(browserRoot, "..", "MKTTool");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function git(root, ...args) {
  return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function initializeGit(root) {
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "test source");
  return git(root, "rev-parse", "HEAD");
}

function candidateSource({ relaySha256, relaySizeBytes }) {
  return [
    "export const WINDOWS_INSTALLER_CANDIDATE = Object.freeze({",
    '  id: "candidate-v19",',
    '  browserVersion: "0.3.25",',
    "  relayVersion: 19,",
    `  relaySha256: "${relaySha256}",`,
    `  relaySizeBytes: ${relaySizeBytes},`,
    '  engineKind: "cft",',
    '  engineChannel: "chrome-for-testing",',
    '  engineVersion: "152.0.7977.64",',
    `  engineSha256: "${"e".repeat(64)}",`,
    "  engineSizeBytes: 123,",
    "});",
  ].join("\n");
}

function toolchainReceipt() {
  return {
    schemaVersion: 1,
    type: "mktbrowser.windows-release-toolchain",
    platform: "win32",
    arch: "x64",
    node: { fileName: "node.exe", version: "22.23.2", sha256: "a".repeat(64) },
    corepack: { fileName: "corepack.js", version: "0.34.6", sha256: "b".repeat(64) },
    yarn: { fileName: "yarn.js", version: "4.5.0", sha256: "c".repeat(64) },
  };
}

function relayBuildToolchainReceipt({ root, packageLockPath }) {
  const nodePath = path.join(root, "node-v24.21.0-win-x64", "node.exe");
  return {
    schemaVersion: 1,
    type: "mktbrowser.relay-build-toolchain",
    platform: "win32",
    arch: "x64",
    node: { path: nodePath, fileName: "node.exe", version: "24.21.0", sha256: "a".repeat(64) },
    npmCli: {
      path: path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
      fileName: "npm-cli.js",
      version: "11.6.2",
      sha256: "b".repeat(64),
    },
    mktToolPackageLock: {
      path: "package-lock.json",
      sizeBytes: readFileSync(packageLockPath).length,
      sha256: sha256(readFileSync(packageLockPath)),
    },
  };
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mkt-source-binding-"));
  t.after(async () => {
    // Git's short-lived Windows handles can close on the next event-loop turn under Node 22.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 50,
        retryDelay: 100,
      });
    } catch (error) {
      // Windows can retain a just-closed Git fixture handle beyond the test's functional lifetime.
      if (error?.code !== "EBUSY") throw error;
    }
  });
  const fixtureBrowserRoot = path.join(root, "MKTBrowser");
  const fixtureMktToolRoot = path.join(root, "MKTTool");
  const archive = Buffer.from("verified-relay-v19");
  const relaySha256 = sha256(archive);

  write(fixtureBrowserRoot, "package.json", JSON.stringify({ version: "0.3.25" }));
  write(fixtureBrowserRoot, "yarn.lock", "__metadata:\n  version: 8\n");
  write(fixtureBrowserRoot, "apps/desktop/package.json", JSON.stringify({ version: "0.3.25" }));
  write(fixtureBrowserRoot, "apps/desktop/relay-release.json", JSON.stringify({
    version: 19,
    sizeBytes: archive.length,
    sha256: relaySha256,
    executableSizeBytes: 7,
    executableSha256: "d".repeat(64),
  }));
  write(fixtureBrowserRoot, "apps/desktop/windows-engine-release.json", JSON.stringify({
    engineKind: "cft",
    source: "chrome-for-testing",
    version: "152.0.7977.64",
    sha256: "e".repeat(64),
    sizeBytes: 123,
  }));
  write(fixtureBrowserRoot, "apps/desktop/scripts/package-tokenized-windows-installer.cmd", "@echo off\n");
  write(fixtureBrowserRoot, "apps/desktop/scripts/fetch-pinned-relay-for-tokenized-package.ps1", "exit 0\n");
  write(fixtureBrowserRoot, "scripts/emit-relay-build-toolchain-receipt.cjs", "module.exports = {};\n");
  write(fixtureBrowserRoot, "scripts/release-candidate-source-binding.cjs", "module.exports = {};\n");
  write(fixtureBrowserRoot, "scripts/verify-tokenized-relay-consumers.cjs", "module.exports = {};\n");
  initializeGit(fixtureBrowserRoot);

  write(fixtureMktToolRoot, "package.json", JSON.stringify({ name: "mkttool" }));
  write(fixtureMktToolRoot, "package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
  write(fixtureMktToolRoot, "src/lib/setup/windows-installer-candidate.ts", candidateSource({
    relaySha256,
    relaySizeBytes: archive.length,
  }));
  write(fixtureMktToolRoot, "src/lib/relay/relay-endpoints.ts", "export const RELAY_VERSION = 19;\n");
  write(fixtureMktToolRoot, "scripts/build-relay-executable.ts", "export {};\n");
  write(fixtureMktToolRoot, "src/lib/relay/relay-release-metadata.ts", "export {};\n");
  write(fixtureMktToolRoot, ".gitignore", "relay/dist/\n");
  const sourceCommit = initializeGit(fixtureMktToolRoot);
  const archivePath = write(fixtureMktToolRoot, "relay/dist/MKTTool-Relay.zip", archive);
  const metadataPath = write(fixtureMktToolRoot, "relay/dist/MKTTool-Relay.metadata.json", JSON.stringify({
    version: 19,
    sizeBytes: archive.length,
    sha256: relaySha256,
    executableSizeBytes: 7,
    executableSha256: "d".repeat(64),
    sourceCommit,
    nodeVersion: "v24.21.0",
    platform: "win32",
    arch: "x64",
    webOrigin: "https://mkttool.example.invalid",
    compatibilityFloor: 32,
  }));
  const receiptPath = write(root, "windows-toolchain.json", JSON.stringify(toolchainReceipt()));
  const relayBuildToolchainReceiptPath = write(
    root,
    "relay-build-toolchain.json",
    JSON.stringify(relayBuildToolchainReceipt({
      root,
      packageLockPath: path.join(fixtureMktToolRoot, "package-lock.json"),
    })),
  );
  return {
    fixtureBrowserRoot,
    fixtureMktToolRoot,
    archivePath,
    metadataPath,
    receiptPath,
    relayBuildToolchainReceiptPath,
  };
}

test("keeps the current MKTTool Relay source aligned with the Browser candidate", () => {
  const candidate = parseWindowsInstallerCandidate(readFileSync(
    path.join(mktToolRoot, "src/lib/setup/windows-installer-candidate.ts"),
    "utf8",
  ));

  assert.equal(candidate.browserVersion, "0.3.26");
  assert.equal(candidate.relay.version, 20);
  assert.equal(parseRelaySourceVersion(mktToolRoot), candidate.relay.version);
});

test("binds one Relay archive, build sidecar, source commit, and Windows toolchain", (t) => {
  const fixture = createFixture(t);
  const candidate = parseWindowsInstallerCandidate(readFileSync(
    path.join(fixture.fixtureMktToolRoot, "src/lib/setup/windows-installer-candidate.ts"),
    "utf8",
  ));
  const binding = buildSourceBinding({
    browserRoot: fixture.fixtureBrowserRoot,
    mktToolRoot: fixture.fixtureMktToolRoot,
    candidateId: candidate.id,
    relayArtifactMetadataPath: fixture.metadataPath,
    relayArchivePath: fixture.archivePath,
    windowsToolchainReceiptPath: fixture.receiptPath,
    relayBuildToolchainReceiptPath: fixture.relayBuildToolchainReceiptPath,
    requireClean: false,
    now: "2026-09-24T00:00:00.000Z",
  });

  assert.equal(binding.schemaVersion, 5);
  assert.equal(binding.relayArtifact.version, 19);
  assert.equal(binding.relayArtifact.sourceCommit, binding.mktTool.commit);
  assert.equal(binding.relayArtifact.archive.sha256, candidate.relay.sha256);
  assert.equal(binding.relayArtifact.sidecar.fileName, "MKTTool-Relay.metadata.json");
  assert.equal(binding.windowsToolchain.yarn.version, "4.5.0");
  assert.equal(binding.relayBuildToolchain.node.version, "24.21.0");
  assert.deepEqual(
    binding.tokenConsumers.map((consumer) => consumer.relativePath),
    [
      "apps/desktop/scripts/package-tokenized-windows-installer.cmd",
      "apps/desktop/scripts/fetch-pinned-relay-for-tokenized-package.ps1",
      "apps/desktop/relay-release.json",
    ],
  );
  assert.equal(binding.mktTool.hashes["relay/dist/MKTTool-Relay.zip"], undefined);
  assert.equal(binding.mktTool.hashes["relay/dist/MKTTool-Relay.metadata.json"], undefined);
});

test("rejects a stale Relay sidecar and a source version that drift from the candidate", (t) => {
  const fixture = createFixture(t);
  const options = {
    browserRoot: fixture.fixtureBrowserRoot,
    mktToolRoot: fixture.fixtureMktToolRoot,
    candidateId: "candidate-v19",
    relayArtifactMetadataPath: fixture.metadataPath,
    relayArchivePath: fixture.archivePath,
    windowsToolchainReceiptPath: fixture.receiptPath,
    relayBuildToolchainReceiptPath: fixture.relayBuildToolchainReceiptPath,
    requireClean: false,
  };
  const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8"));
  writeFileSync(fixture.metadataPath, JSON.stringify({ ...metadata, version: 18 }));
  assert.throws(() => buildSourceBinding(options), /Relay artifact metadata version/);

  writeFileSync(fixture.metadataPath, JSON.stringify(metadata));
  writeFileSync(
    path.join(fixture.fixtureMktToolRoot, "src/lib/relay/relay-endpoints.ts"),
    "export const RELAY_VERSION = 20;\n",
  );
  assert.throws(() => buildSourceBinding(options), /MKTTool RELAY_VERSION/);
});

test("requires both uploaded toolchain receipts and detects changed post-package source bindings", (t) => {
  const fixture = createFixture(t);
  const options = {
    browserRoot: fixture.fixtureBrowserRoot,
    mktToolRoot: fixture.fixtureMktToolRoot,
    candidateId: "candidate-v19",
    relayArtifactMetadataPath: fixture.metadataPath,
    relayArchivePath: fixture.archivePath,
    windowsToolchainReceiptPath: fixture.receiptPath,
    relayBuildToolchainReceiptPath: fixture.relayBuildToolchainReceiptPath,
    requireClean: false,
  };
  assert.throws(
    () => buildSourceBinding({ ...options, windowsToolchainReceiptPath: null }),
    /uploaded Windows toolchain receipt/,
  );
  assert.throws(
    () => buildSourceBinding({ ...options, relayBuildToolchainReceiptPath: null }),
    /Relay build toolchain receipt/,
  );

  const originalRelayReceipt = readFileSync(fixture.relayBuildToolchainReceiptPath, "utf8");
  writeFileSync(fixture.relayBuildToolchainReceiptPath, "{}", "utf8");
  assert.throws(
    () => buildSourceBinding(options),
    (error) => {
      assert.match(error.message, /Relay build toolchain receipt cannot bind source/);
      assert.ok(error.cause instanceof Error, "the source-binding receipt cause was discarded");
      return true;
    },
  );
  writeFileSync(fixture.relayBuildToolchainReceiptPath, originalRelayReceipt, "utf8");

  const changedRelayReceipt = JSON.parse(originalRelayReceipt);
  changedRelayReceipt.mktToolPackageLock.sha256 = "0".repeat(64);
  writeFileSync(fixture.relayBuildToolchainReceiptPath, JSON.stringify(changedRelayReceipt), "utf8");
  assert.throws(
    () => buildSourceBinding(options),
    /Relay build MKTTool package-lock SHA-256/,
  );
  writeFileSync(fixture.relayBuildToolchainReceiptPath, originalRelayReceipt, "utf8");

  const first = buildSourceBinding(options);
  const second = structuredClone(first);
  first.mktTool.clean = true;
  second.mktTool.clean = true;
  assert.doesNotThrow(() => assertSameSourceBinding(first, second));
  second.windowsToolchainReceiptSha256 = "0".repeat(64);
  assert.throws(() => assertSameSourceBinding(first, second), /Source binding changed/);
  second.windowsToolchainReceiptSha256 = first.windowsToolchainReceiptSha256;
  second.relayBuildToolchainReceiptSha256 = "0".repeat(64);
  assert.throws(() => assertSameSourceBinding(first, second), /Source binding changed/);
});

test("keeps ignored Relay outputs out of source identity while binding their exact retained bytes", (t) => {
  const fixture = createFixture(t);
  const options = {
    browserRoot: fixture.fixtureBrowserRoot,
    mktToolRoot: fixture.fixtureMktToolRoot,
    candidateId: "candidate-v19",
    relayArtifactMetadataPath: fixture.metadataPath,
    relayArchivePath: fixture.archivePath,
    windowsToolchainReceiptPath: fixture.receiptPath,
    relayBuildToolchainReceiptPath: fixture.relayBuildToolchainReceiptPath,
    requireClean: true,
  };
  const first = buildSourceBinding(options);
  const originalSidecar = readFileSync(fixture.metadataPath, "utf8");
  writeFileSync(fixture.metadataPath, `${originalSidecar}\n`);
  const second = buildSourceBinding(options);

  assert.equal(first.mktTool.clean, true);
  assert.equal(second.mktTool.clean, true);
  assert.deepEqual(second.mktTool, first.mktTool);
  assert.notEqual(second.relayArtifact.sidecar.sha256, first.relayArtifact.sidecar.sha256);
  assert.throws(() => assertSameSourceBinding(first, second), /Source binding changed/);
});

test("rejects a changed token consumer before injection and accepts only restored bound bytes", (t) => {
  const fixture = createFixture(t);
  const options = {
    browserRoot: fixture.fixtureBrowserRoot,
    mktToolRoot: fixture.fixtureMktToolRoot,
    candidateId: "candidate-v19",
    relayArtifactMetadataPath: fixture.metadataPath,
    relayArchivePath: fixture.archivePath,
    windowsToolchainReceiptPath: fixture.receiptPath,
    relayBuildToolchainReceiptPath: fixture.relayBuildToolchainReceiptPath,
    requireClean: false,
  };
  const binding = buildSourceBinding(options);
  const fetcherPath = path.join(
    fixture.fixtureBrowserRoot,
    "apps/desktop/scripts/fetch-pinned-relay-for-tokenized-package.ps1",
  );
  const originalFetcher = readFileSync(fetcherPath, "utf8");

  assert.doesNotThrow(() => verifyTokenConsumers({
    browserRoot: fixture.fixtureBrowserRoot,
    binding,
  }));
  writeFileSync(fetcherPath, "Write-Output 'mutated before token injection'\n", "utf8");
  assert.throws(
    () => verifyTokenConsumers({ browserRoot: fixture.fixtureBrowserRoot, binding }),
    /Token-bearing Relay input changed after source binding/,
  );
  writeFileSync(fetcherPath, originalFetcher, "utf8");
  assert.doesNotThrow(() => verifyTokenConsumers({
    browserRoot: fixture.fixtureBrowserRoot,
    binding,
  }));
});

test("requires candidate, both toolchain receipts, and output paths", () => {
  assert.throws(() => parseArguments([]), /candidate-id/);
  assert.throws(
    () => parseArguments(["--candidate-id", "candidate", "--output", "binding.json"]),
    /windows-toolchain-receipt/,
  );
  assert.throws(
    () => parseArguments([
      "--candidate-id", "candidate",
      "--windows-toolchain-receipt", "windows-toolchain.json",
      "--output", "binding.json",
    ]),
    /relay-build-toolchain-receipt/,
  );
  assert.throws(() => parseArguments(["--compare", "a.json"]), /requires two/);
  assert.throws(
    () => parseArguments(["--compare", "a.json", "b.json", "--output", "c.json"]),
    /cannot be combined/,
  );
  assert.deepEqual(
    parseArguments([
      "--candidate-id", "candidate",
      "--windows-toolchain-receipt", "toolchain.json",
      "--relay-build-toolchain-receipt", "relay-build-toolchain.json",
      "--output", "binding.json",
    ]),
    {
      mktToolRoot: null,
      candidateId: "candidate",
      relayArtifactMetadataPath: null,
      relayArchivePath: null,
      windowsToolchainReceiptPath: "toolchain.json",
      relayBuildToolchainReceiptPath: "relay-build-toolchain.json",
      output: "binding.json",
      verify: null,
      compare: null,
    },
  );
});
