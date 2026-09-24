const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWindowsToolchainReceipt,
  hasReleaseToken,
  parseArguments,
  tokenlessEnvironment,
} = require("./emit-windows-toolchain-receipt.cjs");

function sha256(filePath) {
  return createHash("sha256").update(require("node:fs").readFileSync(filePath)).digest("hex");
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mktbrowser-toolchain-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeExecutable = write(root, "node22/node.exe", "node-22-binary");
  const corepackEntrypoint = write(root, "node22/node_modules/corepack/dist/corepack.js", "corepack");
  const corepackHome = path.join(root, "corepack-home");
  const yarnEntrypoint = write(corepackHome, "v1/yarn.js", "yarn-4.5.0");
  return {
    corepackEntrypoint,
    corepackHome,
    nodeExecutable,
    yarnEntrypoint,
  };
}

function successfulRunCommand({ corepackEntrypoint, yarnEntrypoint }, calls) {
  return (nodeExecutable, args, environment) => {
    calls.push({ nodeExecutable, args, environment });
    if (args[0] === "-p") {
      return JSON.stringify({ version: "22.23.2", platform: "win32", arch: "x64" });
    }
    if (args[0] === corepackEntrypoint && args[1] === "--version") return "0.34.6";
    if (args[0] === yarnEntrypoint && args[1] === "--version") return "4.5.0";
    throw new Error(`Unexpected toolchain probe: ${args.join(" ")}`);
  };
}

test("emits a hash-bound Windows Node, Corepack, and Yarn receipt with a tokenless child environment", (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const result = buildWindowsToolchainReceipt({
    nodeExecutable: fixture.nodeExecutable,
    nodeSha256: sha256(fixture.nodeExecutable),
    corepackEntrypoint: fixture.corepackEntrypoint,
    corepackSha256: sha256(fixture.corepackEntrypoint),
    corepackHome: fixture.corepackHome,
    environment: {
      MKTTOOL_RELEASE_TOKEN: "must-not-reach-toolchain",
      node_options: "--inspect",
      NODE_EXTRA_CA_CERTS: "untrusted-ca.pem",
      SAFE_VALUE: "kept",
    },
    runCommand: successfulRunCommand(fixture, calls),
  });

  assert.deepEqual(result.receipt, {
    schemaVersion: 1,
    type: "mktbrowser.windows-release-toolchain",
    platform: "win32",
    arch: "x64",
    node: {
      fileName: "node.exe",
      version: "22.23.2",
      sha256: sha256(fixture.nodeExecutable),
    },
    corepack: {
      fileName: "corepack.js",
      version: "0.34.6",
      sha256: sha256(fixture.corepackEntrypoint),
    },
    yarn: {
      fileName: "yarn.js",
      version: "4.5.0",
      sha256: sha256(fixture.yarnEntrypoint),
    },
  });
  assert.equal(result.yarnEntrypoint, fixture.yarnEntrypoint);
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.environment.MKTTOOL_RELEASE_TOKEN, undefined);
    assert.equal(call.environment.node_options, undefined);
    assert.equal(call.environment.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(call.environment.SAFE_VALUE, "kept");
  }
});

test("treats Windows environment keys case-insensitively when scrubbing release state", () => {
  const sanitized = tokenlessEnvironment({
    mkttool_release_token: "secret",
    node_options: "--inspect",
    Node_Use_System_CA: "1",
    SAFE_VALUE: "kept",
  });

  assert.deepEqual(sanitized, { SAFE_VALUE: "kept" });
  assert.equal(hasReleaseToken({ mkttool_release_token: "secret" }), true);
  assert.equal(hasReleaseToken({ MKTTOOL_RELEASE_TOKEN: "   " }), false);
});

test("requires every pinned Windows toolchain input", () => {
  assert.throws(() => parseArguments([]), /--node is required/);
  assert.throws(
    () => parseArguments(["--node", "node.exe", "--node-sha256", "a".repeat(64)]),
    /--corepack is required/,
  );
  assert.throws(
    () => parseArguments(["--node", "node.exe", "--unknown", "value"]),
    /Unknown option/,
  );
});
