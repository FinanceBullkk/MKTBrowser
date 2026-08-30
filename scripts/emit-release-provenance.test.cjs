const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildProvenance,
  dependencyInventory,
  parseArguments,
} = require("./emit-release-provenance.cjs");

function fixtures() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mkt-provenance-"));
  const installerPath = path.join(directory, "MKT Browser Setup.exe");
  const manifestPath = path.join(directory, "payload-manifest.json");
  writeFileSync(installerPath, "installer-bytes");
  writeFileSync(
    manifestPath,
    JSON.stringify({ manifestSha256: "b".repeat(64), fileCount: 42, entries: [] }),
  );
  return { installerPath, manifestPath };
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
  const { installerPath, manifestPath } = fixtures();

  const provenance = buildProvenance({
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "no-high-severity-advisories",
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

  // The pinned Relay and engine travel with the record, because "which installer" is not enough to
  // answer "what did the operator actually receive".
  assert.match(provenance.relay.sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.engine.sha256, /^[a-f0-9]{64}$/);
});

test("states that the release is unsigned instead of leaving a silence", () => {
  const { installerPath, manifestPath } = fixtures();
  const provenance = buildProvenance({
    installerPath,
    payloadManifestPath: manifestPath,
    dependencyAudit: "clean",
  });

  // A missing signature field would leave a reader deciding whether it was a decision or a mistake.
  assert.equal(provenance.signing.authenticode, false);
  assert.equal(provenance.signing.status, "unsigned-internal-exception");
  assert.deepEqual(provenance.signing.allowedLanes, ["A", "B"]);
  assert.ok(Date.parse(provenance.signing.exceptionExpiresAt) > Date.parse(provenance.generatedAt));
  assert.match(provenance.signing.note, /unsigned by owner decision/);
  assert.match(provenance.signing.note, /SmartScreen/);
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
  ]);
  assert.equal(options.installerPath, "a.exe");
  assert.equal(options.output, "p.json");
});
