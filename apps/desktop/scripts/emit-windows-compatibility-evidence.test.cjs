const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readEngineRelease,
  readIntegerConstant,
} = require("./emit-windows-compatibility-evidence.cjs");

test("reads the pinned contract versions mechanically from the runtime source", () => {
  const source = [
    "export const MKT_BROWSER_CONTRACT_VERSION = 4;",
    "export const MKT_BROWSER_PROFILE_SCHEMA_VERSION = 3;",
  ].join("\n");
  assert.equal(readIntegerConstant(source, "MKT_BROWSER_CONTRACT_VERSION"), 4);
  assert.equal(readIntegerConstant(source, "MKT_BROWSER_PROFILE_SCHEMA_VERSION"), 3);
});

test("requires a complete immutable engine release record", () => {
  assert.throws(() => readEngineRelease("missing-engine-release.json"));
});

test("ships a valid pinned engine release beside the pinned Relay release", () => {
  // The installer job names this file through MKT_BROWSER_ENGINE_RELEASE_FILE. Packaging failed in
  // CI once because the record lived in the other repository, so keep the committed copy honest
  // here rather than discovering it again at the end of a Windows build.
  const record = readEngineRelease(path.join(__dirname, "..", "windows-engine-release.json"));
  assert.equal(record.type, "mktbrowser.windows-engine-release");
  assert.equal(record.engineKind, "cloakbrowser");
});

function writeRecord(record) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "engine-release-")),
    "windows-engine-release.json",
  );
  fs.writeFileSync(file, JSON.stringify(record), "utf8");
  return file;
}

const licensed = {
  schemaVersion: 1,
  type: "mktbrowser.windows-engine-release",
  engineKind: "cloakbrowser",
  source: "licensed-channel",
  version: "151.0.7922.108.2",
  sha256: "a".repeat(64),
  sizeBytes: 537518332,
};

test("accepts a licensed engine identified by digest alone", () => {
  // The licensed archive URL is presigned and expires, so it cannot be signed
  // into a durable artifact — and the binary enforces its own licence at
  // launch, so a URL would not let a keyless machine use the engine anyway.
  const record = readEngineRelease(writeRecord(licensed));
  assert.equal(record.source, "licensed-channel");
  assert.equal(record.url, undefined);
});

test("rejects a licensed engine that carries a URL", () => {
  assert.throws(
    () => readEngineRelease(writeRecord({ ...licensed, url: "https://example.invalid/a.zip" })),
    /must not carry a URL/,
  );
});

test("rejects a licensed marker on a Chrome for Testing record", () => {
  assert.throws(
    () => readEngineRelease(writeRecord({ ...licensed, engineKind: "cft" })),
    /Only a CloakBrowser engine release/,
  );
});

test("still requires an https URL for a publicly fetchable engine", () => {
  const { source: _source, ...publicRecord } = licensed;
  assert.throws(() => readEngineRelease(writeRecord(publicRecord)));
  const withUrl = readEngineRelease(
    writeRecord({ ...publicRecord, url: "https://example.invalid/a.zip" }),
  );
  assert.equal(withUrl.engineKind, "cloakbrowser");
});
