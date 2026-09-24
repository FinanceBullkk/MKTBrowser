const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildProvenance,
  dependencyInventory,
  parseArguments,
} = require("./emit-release-provenance.cjs");
const {
  BROWSER_HASHED_FILES,
  MKTTOOL_HASHED_FILES,
  RELAY_BUILD_TOOLCHAIN_TYPE,
  TOKEN_CONSUMER_FILES,
  WINDOWS_TOOLCHAIN_TYPE,
  parseWindowsInstallerCandidate,
} = require("./release-candidate-source-binding.cjs");

const repoRoot = path.resolve(__dirname, "..");
const mktToolRoot = path.resolve(repoRoot, "..", "MKTTool");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function windowsToolchainReceipt() {
  return {
    schemaVersion: 1,
    type: WINDOWS_TOOLCHAIN_TYPE,
    platform: "win32",
    arch: "x64",
    node: { fileName: "node.exe", version: "22.23.2", sha256: "a".repeat(64) },
    corepack: { fileName: "corepack.js", version: "0.34.6", sha256: "b".repeat(64) },
    yarn: { fileName: "yarn.js", version: "4.5.0", sha256: "c".repeat(64) },
  };
}

function relayBuildToolchainReceipt({ directory, packageLockPath }) {
  const nodePath = path.join(directory, "node-v24.21.0-win-x64", "node.exe");
  return {
    schemaVersion: 1,
    type: RELAY_BUILD_TOOLCHAIN_TYPE,
    platform: "win32",
    arch: "x64",
    node: { path: nodePath, fileName: "node.exe", version: "24.21.0", sha256: "d".repeat(64) },
    npmCli: {
      path: path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
      fileName: "npm-cli.js",
      version: "11.6.2",
      sha256: "e".repeat(64),
    },
    mktToolPackageLock: {
      path: "package-lock.json",
      sizeBytes: readFileSync(packageLockPath).length,
      sha256: sha256(readFileSync(packageLockPath)),
    },
  };
}

function fixtures() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mkt-provenance-"));
  const installerPath = path.join(directory, "MKT Browser Setup.exe");
  const manifestPath = path.join(directory, "payload-manifest.json");
  writeFileSync(installerPath, "installer-bytes");
  writeFileSync(
    manifestPath,
    JSON.stringify({ manifestSha256: "b".repeat(64), fileCount: 42, entries: [] }),
  );
  const candidate = parseWindowsInstallerCandidate(readFileSync(
    path.join(mktToolRoot, "src/lib/setup/windows-installer-candidate.ts"),
    "utf8",
  ));
  const receipt = windowsToolchainReceipt();
  const windowsToolchainReceiptPath = path.join(directory, "windows-toolchain.json");
  writeFileSync(windowsToolchainReceiptPath, JSON.stringify(receipt));
  const relayReceipt = relayBuildToolchainReceipt({
    directory,
    packageLockPath: path.join(mktToolRoot, "package-lock.json"),
  });
  const relayBuildToolchainReceiptPath = path.join(directory, "relay-build-toolchain.json");
  writeFileSync(relayBuildToolchainReceiptPath, JSON.stringify(relayReceipt));
  const mktToolHashes = Object.fromEntries(MKTTOOL_HASHED_FILES.map((file) => [file, "f".repeat(64)]));
  mktToolHashes["package-lock.json"] = relayReceipt.mktToolPackageLock.sha256;
  const sourceBinding = {
    schemaVersion: 5,
    type: "mktbrowser.release-candidate-source-binding",
    candidate,
    relayArtifact: {
      version: candidate.relay.version,
      sizeBytes: candidate.relay.sizeBytes,
      sha256: candidate.relay.sha256,
      executableSizeBytes: 1,
      executableSha256: "d".repeat(64),
      sourceCommit: git(mktToolRoot, "rev-parse", "HEAD"),
      nodeVersion: "v24.21.0",
      platform: "win32",
      arch: "x64",
      webOrigin: "https://mkttool.example.invalid",
      compatibilityFloor: 32,
      archive: {
        fileName: "MKTTool-Relay.zip",
        sizeBytes: candidate.relay.sizeBytes,
        sha256: candidate.relay.sha256,
      },
      sidecar: {
        fileName: "MKTTool-Relay.metadata.json",
        sizeBytes: 1,
        sha256: "e".repeat(64),
      },
    },
    windowsToolchain: receipt,
    windowsToolchainReceiptSha256: sha256(readFileSync(windowsToolchainReceiptPath)),
    relayBuildToolchain: relayReceipt,
    relayBuildToolchainReceiptSha256: sha256(readFileSync(relayBuildToolchainReceiptPath)),
    browser: {
      commit: git(repoRoot, "rev-parse", "HEAD"),
      tree: git(repoRoot, "rev-parse", "HEAD^{tree}"),
      clean: true,
      hashes: Object.fromEntries(BROWSER_HASHED_FILES.map((file) => [file, "e".repeat(64)])),
    },
    tokenConsumers: TOKEN_CONSUMER_FILES.map((relativePath) => ({
      relativePath,
      canonicalRelativePath: relativePath,
      sha256: "e".repeat(64),
    })),
    mktTool: {
      commit: git(mktToolRoot, "rev-parse", "HEAD"),
      tree: git(mktToolRoot, "rev-parse", "HEAD^{tree}"),
      clean: true,
      hashes: mktToolHashes,
    },
  };
  const sourceBindingPath = path.join(directory, "source-binding.json");
  writeFileSync(sourceBindingPath, JSON.stringify(sourceBinding));
  return {
    installerPath,
    manifestPath,
    sourceBindingPath,
    windowsToolchainReceiptPath,
    relayBuildToolchainReceiptPath,
    candidateId: candidate.id,
  };
}

test("resolves every packaged dependency to a concrete version", () => {
  const inventory = dependencyInventory();

  assert.ok(inventory.length > 0);
  // A null here would still serialize into a record that reads as complete. The first version of
  // this parser required a bare newline, met a CRLF lockfile, and returned eleven nulls, so the
  // absence of nulls is the property worth asserting rather than the presence of entries.
  const unresolved = inventory.filter((entry) => entry.resolved === null);
  assert.deepEqual(unresolved, [], "every packaged dependency must resolve to a version");

  for (const entry of inventory) {
    assert.match(entry.resolved, /^\d+\.\d+\.\d+/, `${entry.name} resolved to something unversioned`);
  }
});

test("binds the artifact to the tree that produced it, not only to the commit", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();

  const provenance = buildProvenance({
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "no-high-severity-advisories",
    candidateId,
    sourceBindingPath,
    windowsToolchainReceiptPath,
    relayBuildToolchainReceiptPath,
  });

  // Two commits with different messages and the same tree produce the same artifact, so the tree is
  // the value the artifact is actually bound to.
  assert.match(provenance.source.tree, /^[a-f0-9]{40}$/);
  assert.match(provenance.source.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof provenance.source.clean, "boolean");

  assert.match(provenance.installer.installerSha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.installer.fileName, "MKT Browser Setup.exe");
  assert.equal(provenance.payload.manifestSha256, "b".repeat(64));
  assert.equal(provenance.payload.fileCount, 42);
  assert.equal(provenance.dependencyAudit, "no-high-severity-advisories");
  assert.match(provenance.source.mktTool.commit, /^[a-f0-9]{40}$/);
  assert.match(provenance.source.mktTool.tree, /^[a-f0-9]{40}$/);
  assert.match(provenance.sourceBinding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.product.node, undefined, "Ubuntu attestation Node must not be recorded as build evidence");
  assert.equal(provenance.windowsToolchain.node.version, "22.23.2");
  assert.equal(provenance.windowsToolchain.corepack.sha256, "b".repeat(64));
  assert.equal(provenance.windowsToolchain.yarn.sha256, "c".repeat(64));
  assert.equal(provenance.relayBuildToolchain.node.version, "24.21.0");
  assert.equal(provenance.relayBuildToolchain.npmCli.sha256, "e".repeat(64));

  // The pinned Relay and engine travel with the record, because "which installer" is not enough to
  // answer "what did the operator actually receive".
  assert.match(provenance.relay.sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.engine.sha256, /^[a-f0-9]{64}$/);
});

test("states that the release is unsigned instead of leaving a silence", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();
  const provenance = buildProvenance({
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "clean",
    candidateId,
    sourceBindingPath,
    windowsToolchainReceiptPath,
    relayBuildToolchainReceiptPath,
  });

  // A missing signature field would leave a reader deciding whether it was a decision or a mistake.
  assert.equal(provenance.signing.authenticode, false);
  assert.equal(provenance.signing.status, "unsigned-internal-exception");
  assert.deepEqual(provenance.signing.allowedLanes, ["A", "B"]);
  assert.match(provenance.signing.note, /unsigned by owner decision/);
  assert.match(provenance.signing.note, /SmartScreen/);
});

test("dates the unsigned exception as this artifact's shelf life, not the decision's deadline", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();
  const provenance = buildProvenance({
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "clean",
    candidateId,
    sourceBindingPath,
    windowsToolchainReceiptPath,
    relayBuildToolchainReceiptPath,
  });

  /*
   * The previous assertion here was `expiresAt > generatedAt`, which holds for any rolling window
   * and for any absolute date still in the future, so it pinned nothing. The field is named
   * `exceptionExpiresAt` and published as `signing-exception-expires-at`, both of which read as a
   * deadline for the owner's decision to ship unsigned; the behaviour is a per-artifact shelf life
   * that restarts on every build. Owner confirmed the shelf-life reading on 13 September 2026, so
   * the exact offset is pinned here -- a future change to an absolute date is then a deliberate
   * edit to this test rather than a silent change of meaning.
   */
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  assert.equal(
    Date.parse(provenance.signing.exceptionExpiresAt) - Date.parse(provenance.generatedAt),
    SIXTY_DAYS_MS,
  );
  assert.match(provenance.signing.note, /shelf life/);
  assert.match(provenance.signing.note, /not on a fixed date/);
});

test("refuses provenance when the source binding names another candidate or Browser tree", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();
  const binding = JSON.parse(readFileSync(sourceBindingPath, "utf8"));
  binding.candidate.id = "other-candidate";
  writeFileSync(sourceBindingPath, JSON.stringify(binding));

  assert.throws(
    () => buildProvenance({
      installerPath,
      payloadManifestPath: manifestPath,
      dependencyAudit: "clean",
      candidateId,
      sourceBindingPath,
      windowsToolchainReceiptPath,
      relayBuildToolchainReceiptPath,
    }),
    /does not match the requested release candidate ID/,
  );

  binding.candidate.id = candidateId;
  binding.browser.tree = "0".repeat(40);
  writeFileSync(sourceBindingPath, JSON.stringify(binding));
  assert.throws(
    () => buildProvenance({
      installerPath,
      payloadManifestPath: manifestPath,
      dependencyAudit: "clean",
      candidateId,
      sourceBindingPath,
      windowsToolchainReceiptPath,
      relayBuildToolchainReceiptPath,
    }),
    /does not match the checked-out Browser source/,
  );
});

test("refuses provenance when the uploaded Windows toolchain receipt differs from the binding", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();
  const receipt = JSON.parse(readFileSync(windowsToolchainReceiptPath, "utf8"));
  receipt.yarn.sha256 = "0".repeat(64);
  writeFileSync(windowsToolchainReceiptPath, JSON.stringify(receipt));

  assert.throws(
    () => buildProvenance({
      installerPath,
      payloadManifestPath: manifestPath,
      dependencyAudit: "clean",
      candidateId,
      sourceBindingPath,
      windowsToolchainReceiptPath,
      relayBuildToolchainReceiptPath,
    }),
    /Windows toolchain receipt does not match the source binding/,
  );
});

test("refuses provenance when the uploaded Relay build toolchain receipt is missing, malformed, or differs from the binding", () => {
  const { installerPath, manifestPath, sourceBindingPath, windowsToolchainReceiptPath, relayBuildToolchainReceiptPath, candidateId } = fixtures();
  const options = {
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "clean",
    candidateId,
    sourceBindingPath,
    windowsToolchainReceiptPath,
    relayBuildToolchainReceiptPath,
  };

  assert.throws(
    () => buildProvenance({ ...options, relayBuildToolchainReceiptPath: null }),
    /Relay build toolchain receipt cannot bind source: A Relay build toolchain receipt is required/,
  );
  writeFileSync(relayBuildToolchainReceiptPath, "{}", "utf8");
  assert.throws(
    () => buildProvenance(options),
    /Relay build toolchain receipt cannot bind source: Relay build toolchain receipt is malformed/,
  );

  const changed = relayBuildToolchainReceipt({
    directory: path.dirname(relayBuildToolchainReceiptPath),
    packageLockPath: path.join(mktToolRoot, "package-lock.json"),
  });
  changed.npmCli.sha256 = "0".repeat(64);
  writeFileSync(relayBuildToolchainReceiptPath, JSON.stringify(changed), "utf8");
  assert.throws(
    () => buildProvenance(options),
    /Relay build toolchain receipt does not match the source binding/,
  );
});

test("requires the artifact, the payload manifest, and an output path", () => {
  assert.throws(() => parseArguments([]), /installer/);
  assert.throws(() => parseArguments(["--installer", "a.exe"]), /payload-manifest/);
  assert.throws(
    () => parseArguments(["--installer", "a.exe", "--payload-manifest", "m.json"]),
    /output/,
  );
  assert.throws(() => parseArguments(["--installer"]), /Missing value/);
  assert.throws(() => parseArguments(["--unknown", "x"]), /Unknown option/);

  const options = parseArguments([
    "--installer",
    "a.exe",
    "--payload-manifest",
    "m.json",
    "--output",
    "p.json",
    "--candidate-id",
    "candidate",
    "--source-binding",
    "binding.json",
      "--windows-toolchain-receipt",
      "toolchain.json",
      "--relay-build-toolchain-receipt",
      "relay-toolchain.json",
  ]);
  assert.equal(options.installerPath, "a.exe");
  assert.equal(options.output, "p.json");
});
