const assert = require("node:assert/strict");
const { cpSync, mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EXPECTED_RELAY,
  assertNoBadTuple,
  assertPackagedEnginePinned,
  assertRelayPin,
  verifyReleaseCandidate,
} = require("./release-candidate-contract.cjs");

const repoRoot = path.resolve(__dirname, "..");

test("accepts the immutable Relay v16 tuple and guarded engine source", () => {
  const result = verifyReleaseCandidate({ repoRoot });
  assert.equal(result.relay.version, EXPECTED_RELAY.version);
  assert.deepEqual(result.engine, { checked: false });
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
  assert.throws(() => assertRelayPin(root), /v16|immutable|bad Relay/i);

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
