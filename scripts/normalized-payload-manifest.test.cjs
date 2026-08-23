const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildManifest,
  compareManifests,
  normalizePortableExecutable,
  parseArguments,
} = require("./normalized-payload-manifest.cjs");

/**
 * Minimal but structurally real PE image: a DOS stub whose `e_lfanew` points at a PE signature,
 * followed by enough of a COFF and optional header to hold the two fields under test.
 */
function makePortableExecutable({ timestamp, checksum, payload = "same" }) {
  const peOffset = 0x80;
  const buffer = Buffer.alloc(peOffset + 24 + 68 + 16);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.writeUInt32LE(0x00004550, peOffset);
  buffer.writeUInt32LE(timestamp, peOffset + 8);
  buffer.writeUInt32LE(checksum, peOffset + 24 + 64);
  buffer.write(payload, peOffset + 24 + 68, "ascii");
  return buffer;
}

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "mkt-payload-manifest-"));
}

test("treats two builds that differ only in build time as identical", () => {
  const morning = makePortableExecutable({ timestamp: 0x11111111, checksum: 0xaaaaaaaa });
  const evening = makePortableExecutable({ timestamp: 0x22222222, checksum: 0xbbbbbbbb });

  assert.notDeepEqual(morning, evening, "the fixture must actually differ before normalization");

  const first = normalizePortableExecutable(morning);
  const second = normalizePortableExecutable(evening);
  assert.equal(first.normalized, true);
  assert.deepEqual(first.buffer, second.buffer);
});

test("still reports a difference when the code itself changed", () => {
  // The normalization must not be so eager that it hides a real payload change.
  const original = makePortableExecutable({ timestamp: 1, checksum: 1, payload: "same" });
  const altered = makePortableExecutable({ timestamp: 1, checksum: 1, payload: "diff" });

  assert.notDeepEqual(
    normalizePortableExecutable(original).buffer,
    normalizePortableExecutable(altered).buffer,
  );
});

test("leaves a file that is not a PE image alone", () => {
  const plain = Buffer.from("this is not an executable", "ascii");
  const result = normalizePortableExecutable(plain);

  assert.equal(result.normalized, false);
  assert.deepEqual(result.buffer, plain);

  // A truncated file must not throw. Packaging output includes small text and JSON files, and a
  // manifest tool that crashes on one of them stops the release for the wrong reason.
  assert.doesNotThrow(() => normalizePortableExecutable(Buffer.from("MZ", "ascii")));
});

test("hashes a directory into a stable manifest that ignores walk order", () => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, "resources"));
  writeFileSync(path.join(root, "resources", "app.asar"), "asar-bytes");
  writeFileSync(path.join(root, "MKTBrowser.exe"), makePortableExecutable({ timestamp: 7, checksum: 9 }));

  const manifest = buildManifest(root);

  assert.equal(manifest.fileCount, 2);
  assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
  // Forward slashes, so a manifest built on one runner compares against another without the path
  // separator turning into a false difference.
  assert.deepEqual(
    manifest.entries.map((entry) => entry.path).sort(),
    ["MKTBrowser.exe", "resources/app.asar"],
  );
  assert.equal(manifest.entries.find((e) => e.path === "MKTBrowser.exe").peNormalized, true);
});

test("names what differs between two builds instead of only failing", () => {
  const first = temporaryDirectory();
  const second = temporaryDirectory();
  writeFileSync(path.join(first, "shared.txt"), "identical");
  writeFileSync(path.join(second, "shared.txt"), "identical");
  writeFileSync(path.join(first, "changed.txt"), "one");
  writeFileSync(path.join(second, "changed.txt"), "two");
  writeFileSync(path.join(first, "only-in-first.txt"), "x");
  writeFileSync(path.join(second, "only-in-second.txt"), "y");

  const differences = compareManifests(buildManifest(first), buildManifest(second));
  const byPath = new Map(differences.map((d) => [d.path, d]));

  assert.equal(differences.length, 3);
  assert.equal(byPath.get("changed.txt").kind, "content-differs");
  assert.equal(byPath.get("only-in-first.txt").kind, "missing-in-second");
  assert.equal(byPath.get("only-in-second.txt").kind, "missing-in-first");
  assert.ok(!byPath.has("shared.txt"));

  // A reviewer needs both hashes and both sizes: a size change and a content-only change at the
  // same size point at different causes.
  assert.match(byPath.get("changed.txt").firstSha256, /^[a-f0-9]{64}$/);
  assert.equal(byPath.get("changed.txt").firstSize, 3);
});

test("reports no difference when the same tree is compared with itself", () => {
  const root = temporaryDirectory();
  writeFileSync(path.join(root, "a.txt"), "a");
  assert.deepEqual(compareManifests(buildManifest(root), buildManifest(root)), []);
});

test("rejects an invocation that names neither a directory nor two manifests", () => {
  assert.throws(() => parseArguments([]), /--directory/);
  assert.throws(() => parseArguments(["--nonsense", "x"]), /Unknown option/);
  assert.equal(parseArguments(["--directory", "dist"]).mode, "build");
  assert.equal(parseArguments(["--compare", "a.json", "b.json"]).mode, "compare");
});
