const assert = require("node:assert/strict");
const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  APPROVED_ENGINE,
  CURRENT_RELAY,
  HISTORICAL_RELAY,
  PROFILE_ACTION_RELAY_FLOOR,
  assertEnginePin,
  assertNoBadTuple,
  assertPackagedEnginePinned,
  assertRelayEligibleForCandidatePackaging,
  assertRelayPin,
  verifyReleaseCandidate,
} = require("./release-candidate-contract.cjs");

const repoRoot = path.resolve(__dirname, "..");

test("retains Relay v20 as history and pins v21 as the current candidate", () => {
  const relay = assertRelayPin(repoRoot);
  assert.equal(HISTORICAL_RELAY.version, 20);
  assert.equal(relay.version, CURRENT_RELAY.version);
  assert.equal(relay.promotionStatus, "eligible");
  assert.equal(relay.minimumProfileActionRelayVersion, PROFILE_ACTION_RELAY_FLOOR);
  assert.equal(relay.executableSizeBytes, CURRENT_RELAY.executableSizeBytes);
  assert.equal(relay.executableSha256, CURRENT_RELAY.executableSha256);
  assert.ok(relay.version >= PROFILE_ACTION_RELAY_FLOOR);
  assert.doesNotThrow(() => assertRelayEligibleForCandidatePackaging(relay));
  assert.doesNotThrow(() => verifyReleaseCandidate({ repoRoot }));
  assert.doesNotThrow(() =>
    assertRelayEligibleForCandidatePackaging({ ...relay, version: HISTORICAL_RELAY.version }),
  );
  assert.throws(() => assertRelayEligibleForCandidatePackaging({ ...relay, version: 19 }), /v20/i);
});

test("rejects stale, future and altered Relay candidate fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-release-contract-"));
  mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
  const file = path.join(root, "apps", "desktop", "relay-release.json");
  const pin = JSON.parse(readFileSync(path.join(repoRoot, "apps", "desktop", "relay-release.json"), "utf8"));
  for (const mutation of [{ version: 20 }, { version: 22 }, { sizeBytes: 1 },
    { sha256: "0".repeat(64) }, { sha256: "9cc71eba405c8ea5ff9f288491ea0b827c7403b3c43541d1fa18c48a87126d69" },
    { executableSizeBytes: 1 }, { executableSha256: "0".repeat(64) },
    { url: "https://example.test/api/relay/download/v20" }]) {
    writeFileSync(file, JSON.stringify({ ...pin, ...mutation }));
    assert.throws(() => assertRelayPin(root), /v21|candidate|archive\/executable/);
  }
});

test("requires every measured CFT tuple field, not merely a compatible engine kind", () => {
  assert.doesNotThrow(() => assertEnginePin({ ...APPROVED_ENGINE }));
  for (const [field, value] of Object.entries({
    engineKind: "cloakbrowser", source: "licensed-channel", version: "152.0.0.0",
    url: "https://example.test/chrome.zip", sha256: "0".repeat(64), sizeBytes: 1,
  })) {
    assert.throws(() => assertEnginePin({ ...APPROVED_ENGINE, [field]: value }), /reviewed CFT/);
    const missing = { ...APPROVED_ENGINE };
    delete missing[field];
    assert.throws(() => assertEnginePin(missing), /reviewed CFT/);
  }
  assert.throws(() => assertEnginePin(null), /reviewed CFT/);
});

test("rejects a known-bad Relay hash and quarantined installer version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-release-contract-"));
  mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
  writeFileSync(
    path.join(root, "apps", "desktop", "relay-release.json"),
    JSON.stringify({
      ...CURRENT_RELAY,
      sha256: "cfeefc7f1284492a64f5cf8b29603b3e9a36e5d488ac676d2d109b2c4364b261",
      url: "https://example.test/api/relay/download/v15",
    }),
  );
  assert.throws(() => assertRelayPin(root), /v21|candidate|bad Relay/i);

  const candidate = path.join(root, "package.json");
  writeFileSync(candidate, JSON.stringify({ version: "0.3.12" }));
  assert.throws(() => assertNoBadTuple(root), /0\.3\.12/);
});

test("rejects the retained failing v20 hash in generated provenance", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-release-quarantine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provenance = path.join(root, "release-provenance.json");
  writeFileSync(provenance, JSON.stringify({ relay: { sha256: CURRENT_RELAY.sha256 } }));
  assert.doesNotThrow(() => assertNoBadTuple(root));
  writeFileSync(provenance, JSON.stringify({
    relay: { sha256: "9cc71eba405c8ea5ff9f288491ea0b827c7403b3c43541d1fa18c48a87126d69" },
  }));
  assert.throws(() => assertNoBadTuple(root), /Known-bad Relay hash.*release-provenance/);
});

test("rejects unpinned and system-Chrome overrides in a packaged payload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-release-contract-"));
  mkdirSync(path.join(root, "apps", "desktop", "src", "main"), { recursive: true });
  cpSync(
    path.join(repoRoot, "apps", "desktop", "src", "main", "compatibility-engine-pin.ts"),
    path.join(root, "apps", "desktop", "src", "main", "compatibility-engine-pin.ts"),
  );
  const packageDirectory = path.join(root, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "runtime.json"),
    '{"MKT_BROWSER_ALLOW_UNPINNED_ENGINE":"1"}',
  );
  assert.throws(() => assertPackagedEnginePinned(root, packageDirectory), /unpinned/i);
});

test("release-candidate workflow compares and records both normalized payload builds", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /attempt:\s*\[a, b\]/);
  assert.match(workflow, /normalized-payload-manifest\.cjs\s+--directory/);
  assert.match(workflow, /normalized-payload-manifest\.cjs\s+--compare/);
  assert.ok(
    workflow.indexOf("prepare-windows-node22.ps1") <
      workflow.indexOf("prepare-windows-native-dependencies.ps1"),
    "the pinned Node executable must be prepared before native dependency setup",
  );

  const compareGate = workflow.indexOf("--gate payload-reproducibility");
  assert.ok(compareGate >= 0, "the required payload-reproducibility gate must be present");
  assert.match(workflow.slice(compareGate, compareGate + 600), /--required/);
  assert.match(workflow, /needs\.build\.result.*!=.*success/);
  assert.match(workflow, /payload-reproducibility-result\.json/);
  assert.match(
    workflow,
    /installer-reproducibility[\s\S]*103-byte residual classified NSIS-RT_DIALOG-order-and-trailer/,
  );
});

test("release workflows bind exact MKTTool source and use immutable Node outputs", () => {
  const releaseWorkflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const windowsWorkflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "windows-pipeline.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const nodeSetup = readFileSync(
    path.join(repoRoot, ".github", "scripts", "prepare-windows-node22.ps1"),
    "utf8",
  );
  const nativeDependencies = readFileSync(
    path.join(repoRoot, ".github", "scripts", "prepare-windows-native-dependencies.ps1"),
    "utf8",
  );
  const toolchainReceipt = readFileSync(
    path.join(repoRoot, "scripts", "emit-windows-toolchain-receipt.cjs"),
    "utf8",
  );
  const relayBuildToolchainReceipt = readFileSync(
    path.join(repoRoot, "scripts", "emit-relay-build-toolchain-receipt.cjs"),
    "utf8",
  );

  assert.match(releaseWorkflow, /mkttool_commit:\s*\n\s*description:.*\n\s*required: true/);
  assert.match(releaseWorkflow, /relay_compatibility_floor:\s*\n\s*description:.*\n\s*required: true/);
  assert.match(releaseWorkflow, /ref: \$\{\{ inputs\.mkttool_commit \}\}/);
  assert.doesNotMatch(releaseWorkflow, /ref:\s*master/);
  assert.match(releaseWorkflow, /mkttool_commit must be an exact 40-character commit SHA/);
  assert.match(releaseWorkflow, /relay_compatibility_floor must be a positive integer/);
  assert.match(releaseWorkflow, /git -C "\$env:MKTTOOL_ROOT" rev-parse HEAD/);
  assert.match(releaseWorkflow, /node-version: 24\.21\.0/);
  assert.match(releaseWorkflow, /id: relay_build_toolchain/);
  assert.match(releaseWorkflow, /emit-relay-build-toolchain-receipt\.cjs[\s\S]*--package-lock "\$env:MKTTOOL_ROOT\/package-lock\.json"/);
  assert.match(releaseWorkflow, /& \$nodeExecutable \$npmCli ci/);
  assert.match(
    releaseWorkflow,
    /& \$nodeExecutable \$npmCli run relay:build -- "--web-origin=https:\/\/mkttool-web-production\.up\.railway\.app" "--compatibility-floor=\$env:RELAY_COMPATIBILITY_FLOOR"/,
  );
  assert.match(
    releaseWorkflow,
    /& \$nodeExecutable \$npmCli run relay:verify -- --archive=relay\/dist\/MKTTool-Relay\.zip --metadata=relay\/dist\/MKTTool-Relay\.metadata\.json/,
  );
  const relayBuildStepAt = releaseWorkflow.indexOf("- name: Build and verify the exact Relay candidate archive");
  const relayBuildStepEnd = releaseWorkflow.indexOf("\n      - name:", relayBuildStepAt + 1);
  const relayBuildStep = releaseWorkflow.slice(relayBuildStepAt, relayBuildStepEnd);
  const relayBuildCommandAt = relayBuildStep.indexOf("& $nodeExecutable $npmCli run relay:build");
  const relayVerifyAt = relayBuildStep.indexOf("& $nodeExecutable $npmCli run relay:verify");
  const postBuildReceiptVerificationAt = relayBuildStep.lastIndexOf("emit-relay-build-toolchain-receipt.cjs");
  assert.ok(
    relayBuildStepAt >= 0 && relayBuildCommandAt >= 0 && relayVerifyAt > relayBuildCommandAt &&
      postBuildReceiptVerificationAt > relayVerifyAt,
    "the Relay build toolchain must be verified after relay:build and relay:verify complete",
  );
  const postBuildReceiptVerification = relayBuildStep.slice(postBuildReceiptVerificationAt);
  assert.match(postBuildReceiptVerification, /--node \$nodeExecutable/);
  assert.match(postBuildReceiptVerification, /--package-lock "\$env:MKTTOOL_ROOT\/package-lock\.json"/);
  assert.match(
    postBuildReceiptVerification,
    /--verify "\$env:RUNNER_TEMP\/relay-build-toolchain-\$\{\{ matrix\.attempt \}\}\.json"/,
  );
  assert.doesNotMatch(releaseWorkflow, /^\s+npm (?:ci|run relay:)/m);
  assert.match(relayBuildToolchainReceipt, /Relay build receipt requires Node\.js \$\{EXPECTED_NODE_VERSION\}/);
  assert.match(relayBuildToolchainReceipt, /Relay build npm CLI is not derived from the pinned Node\.js executable/);
  const relayCandidateBuild = releaseWorkflow.indexOf("Build and verify the exact Relay candidate archive");
  const sourceBinding = releaseWorkflow.indexOf("Capture clean source binding before packaging");
  assert.ok(
    relayCandidateBuild >= 0 && relayCandidateBuild < sourceBinding,
    "the ignored Relay archive and sidecar must be built before source binding",
  );

  assert.match(nodeSetup, /GITHUB_OUTPUT is required/);
  for (const output of [
    "node22_exe",
    "node22_sha256",
    "corepack22_entrypoint",
    "corepack22_sha256",
  ]) {
    assert.match(nodeSetup, new RegExp(`"${output}=`));
  }
  assert.doesNotMatch(nodeSetup, /\$env:GITHUB_ENV|\$env:GITHUB_PATH/);
  assert.match(nativeDependencies, /\[string\]\$NodeExecutable/);
  assert.match(nativeDependencies, /\[string\]\$NodeSha256/);
  assert.match(nativeDependencies, /NodeExecutable does not match the SHA-256 emitted/);
  assert.doesNotMatch(nativeDependencies, /\$env:MKT_BROWSER_NODE22_EXE/);

  for (const workflow of [releaseWorkflow, windowsWorkflow]) {
    assert.match(workflow, /id: node22/);
    assert.match(workflow, /steps\.node22\.outputs\.node22_exe/);
    assert.match(workflow, /steps\.node22\.outputs\.node22_sha256/);
    assert.match(workflow, /steps\.node22\.outputs\.corepack22_entrypoint/);
    assert.doesNotMatch(
      workflow,
      /\$env:MKT_BROWSER_(?:NODE22_EXE|COREPACK22_ENTRYPOINT)/,
      "Node/Corepack commands must not trust GITHUB_ENV",
    );
  }
  assert.match(
    releaseWorkflow,
    /MKT_BROWSER_NODE22_SHA256: \$\{\{ steps\.node22\.outputs\.node22_sha256 \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /MKT_BROWSER_COREPACK22_SHA256: \$\{\{ steps\.node22\.outputs\.corepack22_sha256 \}\}/,
  );
  assert.match(toolchainReceipt, /yarn_entrypoint=\$\{result\.yarnEntrypoint\}/);
  assert.match(toolchainReceipt, /yarn_version=\$\{result\.receipt\.yarn\.version\}/);
  assert.match(toolchainReceipt, /yarn_sha256=\$\{result\.receipt\.yarn\.sha256\}/);
  assert.match(
    releaseWorkflow,
    /MKT_BROWSER_YARN_ENTRYPOINT: \$\{\{ steps\.windows_toolchain\.outputs\.yarn_entrypoint \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /MKT_BROWSER_YARN_VERSION:\s+\$\{\{ steps\.windows_toolchain\.outputs\.yarn_version \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /MKT_BROWSER_YARN_SHA256: \$\{\{ steps\.windows_toolchain\.outputs\.yarn_sha256 \}\}/,
  );
  assert.match(
    windowsWorkflow,
    /prepare-windows-native-dependencies\.ps1 -NodeExecutable "\$\{\{ steps\.node22\.outputs\.node22_exe \}\}" -NodeSha256 "\$\{\{ steps\.node22\.outputs\.node22_sha256 \}\}"/,
  );
});

test("release-candidate workflow verifies source bindings and both build toolchains before attestation", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /source-binding-pre-\$\{\{ matrix\.attempt \}\}\.json/);
  assert.match(workflow, /emit-windows-toolchain-receipt\.cjs[\s\S]*--corepack-home "\$env:COREPACK_HOME"/);
  assert.match(workflow, /windows-toolchain-\$\{\{ matrix\.attempt \}\}\.json/);
  assert.match(workflow, /relay-build-toolchain-\$\{\{ matrix\.attempt \}\}\.json/);
  assert.match(workflow, /release-candidate-source-binding\.cjs[\s\S]*--mkttool-root[\s\S]*--candidate-id/);
  assert.match(workflow, /--windows-toolchain-receipt "\$env:RUNNER_TEMP\/windows-toolchain-\$\{\{ matrix\.attempt \}\}\.json"/);
  assert.match(workflow, /--relay-build-toolchain-receipt "\$env:RUNNER_TEMP\/relay-build-toolchain-\$\{\{ matrix\.attempt \}\}\.json"/);
  assert.match(workflow, /id: source_binding_pre/);
  assert.match(workflow, /pre_binding_sha256=\$bindingSha256/);
  assert.match(workflow, /steps\.source_binding_pre\.outputs\.pre_binding_sha256/);
  assert.match(workflow, /The pre-package source binding changed before post-package verification/);
  assert.match(workflow, /--verify \$preBindingPath/);
  assert.match(workflow, /name: source-binding-\$\{\{ matrix\.attempt \}\}/);
  assert.match(workflow, /pattern: source-binding-\*/);
  assert.match(workflow, /name: windows-toolchain-\$\{\{ matrix\.attempt \}\}/);
  assert.match(workflow, /pattern: windows-toolchain-\*/);
  assert.match(workflow, /name: relay-build-toolchain-\$\{\{ matrix\.attempt \}\}/);
  assert.match(workflow, /pattern: relay-build-toolchain-\*/);
  assert.match(workflow, /cmp --silent "\$first_toolchain" "\$second_toolchain"/);
  assert.match(workflow, /cmp --silent "\$first_relay_toolchain" "\$second_relay_toolchain"/);
  assert.match(workflow, /release-candidate-source-binding\.cjs --compare "\$first" "\$second"/);
  assert.match(workflow, /--gate source-binding-reproducibility[\s\S]*--required/);

  const bindingComparison = workflow.indexOf("source-binding-reproducibility");
  const bindingUpload = workflow.indexOf("Upload source binding evidence");
  const packagedContract = workflow.indexOf("Verify Relay and packaged engine pin");
  const attest = workflow.indexOf("  attest:");
  assert.ok(bindingComparison >= 0 && bindingComparison < attest, "source bindings must be compared before attestation");
  assert.ok(bindingUpload >= 0 && bindingUpload < packagedContract, "verified bindings must upload before later source-side checks");
  assert.match(workflow, /name: source-binding-a[\s\S]*path: \$\{\{ runner\.temp \}\}\/source-bindings/);
  assert.match(workflow, /name: windows-toolchain-a[\s\S]*path: \$\{\{ runner\.temp \}\}\/windows-toolchain/);
  assert.match(workflow, /name: relay-build-toolchain-a[\s\S]*path: \$\{\{ runner\.temp \}\}\/relay-build-toolchain/);
  assert.match(workflow, /--source-binding "\$RUNNER_TEMP\/source-bindings\/source-binding-a\.json"/);
  assert.match(workflow, /--windows-toolchain-receipt "\$RUNNER_TEMP\/windows-toolchain\/windows-toolchain-a\.json"/);
  assert.match(workflow, /--relay-build-toolchain-receipt "\$RUNNER_TEMP\/relay-build-toolchain\/relay-build-toolchain-a\.json"/);
});

test("release-candidate workflow verifies canonical token consumers after mutable setup", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /Relocate the verified MKTTool sibling outside Browser source/);
  assert.match(workflow, /Move-Item -LiteralPath \$checkoutRoot -Destination \$mkttoolRoot/);
  assert.match(workflow, /MKTTOOL_ROOT=\$mkttoolRoot/);
  assert.match(workflow, /cache-dependency-path: \$\{\{ steps\.mkttool_location\.outputs\.root \}\}\/package-lock\.json/);
  assert.match(workflow, /working-directory: \$\{\{ steps\.mkttool_location\.outputs\.root \}\}/);
  assert.match(workflow, /Preserve the bound token-consumer verifier/);
  assert.match(workflow, /scripts\/verify-tokenized-relay-consumers\.cjs/);
  assert.match(workflow, /The preserved token-consumer verifier does not match the clean source binding/);
  assert.match(workflow, /MKT_RELEASE_TOKEN_AFTER_VERIFICATION: \$\{\{ secrets\.MKTTOOL_RELEASE_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /MKTTOOL_RELEASE_TOKEN: \$\{\{ secrets\.MKTTOOL_RELEASE_TOKEN \}\}/);
  assert.match(workflow, /A Relay release token was present before token-consumer verification/);
  assert.match(workflow, /The clean source binding changed before token-consumer verification/);
  assert.match(workflow, /The preserved token-consumer verifier changed before release-token injection/);
  assert.match(workflow, /The pinned Node\.js executable changed before token-consumer verification/);
  assert.match(workflow, /Get-FileHash -LiteralPath \$nodeExecutable -Algorithm SHA256/);
  assert.match(workflow, /--snapshot-root \$consumerSnapshotRoot/);
  assert.match(
    workflow,
    /\$snapshotWrapperPath = Join-Path \$consumerSnapshotRoot 'apps\\desktop\\scripts\\package-tokenized-windows-installer\.cmd'/,
  );
  assert.match(workflow, /The verified token-consumer snapshot does not contain its package wrapper/);
  assert.match(workflow, /& cmd\.exe \/d \/v:off \/c \$snapshotWrapperPath/);
  assert.match(workflow, /\$env:MKT_BROWSER_PACKAGE_ROOT = \$env:GITHUB_WORKSPACE/);
  assert.match(workflow, /Remove-Item Env:MKT_BROWSER_PACKAGE_ROOT -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(
    workflow,
    /& cmd\.exe \/d \/v:off \/c apps\\desktop\\scripts\\package-tokenized-windows-installer\.cmd/,
  );
  assert.match(workflow, /Remove-Item Env:MKT_RELEASE_TOKEN_AFTER_VERIFICATION -ErrorAction SilentlyContinue/);
  assert.match(workflow, /Remove-Item Env:MKTTOOL_RELEASE_TOKEN -ErrorAction SilentlyContinue/);
  for (const name of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    assert.match(workflow, new RegExp(`'${name}'`));
  }

  const relocateSibling = workflow.indexOf("Relocate the verified MKTTool sibling outside Browser source");
  const sourceBinding = workflow.indexOf("Capture clean source binding before packaging");
  const nativeSetup = workflow.indexOf("Prepare Windows native dependencies");
  const immutableInstall = workflow.indexOf("Install dependencies");
  const audit = workflow.indexOf("Audit production dependencies");
  const tokenizedBuild = workflow.indexOf("Verify token consumers then build the combined Windows installer");
  const aliasRemoval = workflow.indexOf("Remove-Item Env:MKT_RELEASE_TOKEN_AFTER_VERIFICATION -ErrorAction SilentlyContinue", tokenizedBuild);
  const unsafeScrub = workflow.indexOf("$unsafeEnvironmentNames = @(", tokenizedBuild);
  const nodeHashCheck = workflow.indexOf("$nodeHash = (Get-FileHash", tokenizedBuild);
  const snapshotCreation = workflow.indexOf("Copy and revalidate every token-bearing input outside the mutable checkout", tokenizedBuild);
  const tokenInjection = workflow.indexOf("$env:MKTTOOL_RELEASE_TOKEN = $releaseToken", tokenizedBuild);
  const wrapperInvocation = workflow.indexOf("& cmd.exe /d /v:off /c $snapshotWrapperPath", tokenInjection);

  assert.ok(relocateSibling >= 0 && relocateSibling < sourceBinding, "the nested checkout must leave Browser source before cleanliness binding");
  assert.ok(sourceBinding >= 0 && sourceBinding < nativeSetup, "clean source identity must precede mutable Browser setup");
  assert.ok(nativeSetup < immutableInstall && immutableInstall < audit && audit < tokenizedBuild);
  assert.ok(
    aliasRemoval >= tokenizedBuild && unsafeScrub > aliasRemoval && nodeHashCheck > unsafeScrub && nodeHashCheck < snapshotCreation &&
      snapshotCreation < tokenInjection && tokenInjection < wrapperInvocation,
    "the token snapshot must be created without the staged token alias or unsafe Node/Electron environment",
  );
});
