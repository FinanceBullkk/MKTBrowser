const assert = require("node:assert/strict");
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
