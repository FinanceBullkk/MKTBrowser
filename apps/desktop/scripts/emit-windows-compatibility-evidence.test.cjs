const assert = require("node:assert/strict");
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
