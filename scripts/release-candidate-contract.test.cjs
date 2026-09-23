const assert = require("node:assert/strict");
const { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  APPROVED_ENGINE,
  EXPECTED_RELAY,
  assertEnginePin,
  assertNoBadTuple,
  assertPackagedEnginePinned,
  assertRelayPin,
  verifyReleaseCandidate,
} = require("./release-candidate-contract.cjs");

const repoRoot = path.resolve(__dirname, "..");

test("accepts the immutable Relay v19 tuple and guarded engine source", () => {
  const result = verifyReleaseCandidate({ repoRoot });
  assert.equal(result.relay.version, EXPECTED_RELAY.version);
  assert.deepEqual(result.engine, { checked: false });
});

test("rejects stale, future and altered Relay candidate fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-release-contract-"));
  mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
  const file = path.join(root, "apps", "desktop", "relay-release.json");
  const pin = JSON.parse(readFileSync(path.join(repoRoot, "apps", "desktop", "relay-release.json"), "utf8"));
  for (const mutation of [{ version: 18 }, { version: 20 }, { sizeBytes: 1 },
    { sha256: "0".repeat(64) }, { url: "https://example.test/api/relay/download/v18" }]) {
    writeFileSync(file, JSON.stringify({ ...pin, ...mutation }));
    assert.throws(() => assertRelayPin(root), /v19|immutable/);
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
      ...EXPECTED_RELAY,
      sha256: "cfeefc7f1284492a64f5cf8b29603b3e9a36e5d488ac676d2d109b2c4364b261",
      url: "https://example.test/api/relay/download/v15",
    }),
  );
  assert.throws(() => assertRelayPin(root), /v19|immutable|bad Relay/i);

  const candidate = path.join(root, "package.json");
  writeFileSync(candidate, JSON.stringify({ version: "0.3.12" }));
  assert.throws(() => assertNoBadTuple(root), /0\.3\.12/);
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
