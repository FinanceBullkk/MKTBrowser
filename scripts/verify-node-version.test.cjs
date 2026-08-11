const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_NODE_MAJOR,
  assertSupportedNodeVersion,
} = require("./verify-node-version.cjs");

test("accepts the required Node.js major", () => {
  assert.equal(REQUIRED_NODE_MAJOR, 22);
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.23.0"));
});

test("rejects other Node.js majors with an actionable error", () => {
  assert.throws(
    () => assertSupportedNodeVersion("24.14.1"),
    /require Node\.js 22.*Current runtime: 24\.14\.1/s,
  );
});
