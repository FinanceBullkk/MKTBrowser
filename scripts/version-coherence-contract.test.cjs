const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(repoRoot, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("keeps the Windows candidate version and pinned Relay coherent", () => {
  const root = readJson("package.json");
  const desktop = readJson("apps/desktop/package.json");
  const relay = readJson("apps/desktop/relay-release.json");
  const expectedVersion = "0.3.13";

  assert.equal(root.version, expectedVersion, "root package version drifted");
  assert.equal(desktop.version, expectedVersion, "desktop package version drifted");
  assert.equal(relay.version, 16, "the candidate must carry immutable Relay v16");
  assert.equal(relay.sizeBytes, 33342752);
  assert.equal(
    relay.sha256,
    "5c98cf460e62f83b484c9ecd55bc80b650f2e19a09e8ded6e99eafb682e1842e",
  );
  assert.match(relay.url, /\/api\/relay\/download\/v16$/);

  const proxyGeo = readFileSync(path.join(repoRoot, "apps/desktop/src/main/proxyGeo.ts"), "utf8");
  assert.match(proxyGeo, /MKTBrowser\/0\.3\.13/);

  const mktToolReader = readFileSync(
    path.join(workspaceRoot, "MKTTool", "src", "lib", "setup", "windows-installer-release.ts"),
    "utf8",
  );
  assert.match(mktToolReader, /EXPECTED_WINDOWS_INSTALLER_VERSION = "0\.3\.13"/);
  assert.match(
    mktToolReader,
    /EXPECTED_WINDOWS_INSTALLER_CANDIDATE_ID = "20260830-browser-0\.3\.13-relay-16"/,
  );
  const mktToolMetadata = readFileSync(
    path.join(workspaceRoot, "MKTTool", "src", "lib", "setup", "windows-installer-release-metadata.ts"),
    "utf8",
  );
  assert.match(mktToolMetadata, /payloadManifestSha256/);
  assert.match(mktToolMetadata, /payloadFileCount/);
  const typesSource = readFileSync(path.join(repoRoot, "packages", "types", "src", "index.ts"), "utf8");
  assert.match(typesSource, /MKT_BROWSER_MCP_PROTOCOL_VERSION/);
  assert.match(typesSource, /MKT_BROWSER_MCP_SERVER_VERSION = MKT_BROWSER_MCP_PROTOCOL_VERSION/);

  // The generated evidence is intentionally checked when present. A stale ignored output is
  // contamination, not a harmless cache: it must be rebuilt or quarantined before promotion.
  const evidencePath = path.join(repoRoot, "apps/desktop/release/installer/windows-compatibility-artifacts.json");
  if (existsSync(evidencePath)) {
    const evidence = readJson("apps/desktop/release/installer/windows-compatibility-artifacts.json");
    assert.equal(evidence.browserVersion, expectedVersion, "generated installer evidence is stale");
    assert.equal(evidence.artifacts.relay.version, "16", "generated Relay evidence is stale");
  }
});

test("packaging derives the control contract version from the package metadata", () => {
  const source = readFileSync(
    path.join(repoRoot, "apps/desktop/scripts/emit-windows-compatibility-evidence.cjs"),
    "utf8",
  );
  assert.match(source, /appVersion: packageJson\.version/);
  assert.match(source, /browserVersion: packageJson\.version/);
});

test("attestation workflow requires and forwards the immutable candidate ID", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /candidate_id:/);
  assert.match(workflow, /MKT_RELEASE_CANDIDATE_ID: \$\{\{ inputs\.candidate_id \}\}/);
  assert.match(workflow, /--candidate-id "\$MKT_RELEASE_CANDIDATE_ID"/);
  assert.match(workflow, /--engine-release/);
});
