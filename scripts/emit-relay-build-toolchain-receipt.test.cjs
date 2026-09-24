const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertReceiptMatches,
  buildRelayBuildToolchainReceipt,
  parseArguments,
  readRelayBuildToolchainReceipt,
} = require("./emit-relay-build-toolchain-receipt.cjs");

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mkt-relay-build-toolchain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeExecutable = write(root, "node-v24.21.0-win-x64/node.exe", "node-v24-bytes");
  const npmCli = write(
    root,
    "node-v24.21.0-win-x64/node_modules/npm/bin/npm-cli.js",
    "npm-cli-bytes",
  );
  const mktToolRoot = path.join(root, "MKTTool");
  const packageLockPath = write(mktToolRoot, "package-lock.json", "{\"lockfileVersion\":3}\n");
  const environments = [];
  const runCommand = (executable, args, environment) => {
    environments.push({ executable, args, environment });
    if (args[0] === "-p") {
      return JSON.stringify({
        version: "24.21.0",
        platform: "win32",
        arch: "x64",
        execPath: nodeExecutable,
      });
    }
    assert.equal(executable, nodeExecutable);
    assert.deepEqual(args, [npmCli, "--version"]);
    return "11.6.2";
  };
  return { root, nodeExecutable, npmCli, mktToolRoot, packageLockPath, environments, runCommand };
}

test("records the exact Node 24/npm paths and probes without release or TLS environment", (t) => {
  const fixture = createFixture(t);
  const result = buildRelayBuildToolchainReceipt({
    nodeExecutable: fixture.nodeExecutable,
    mktToolRoot: fixture.mktToolRoot,
    packageLockPath: fixture.packageLockPath,
    environment: {
      SAFE_VALUE: "kept",
      MKTTOOL_RELEASE_TOKEN: "not-for-probes",
      MKT_RELEASE_TOKEN_AFTER_VERIFICATION: "not-for-probes",
      NPM_TOKEN: "not-for-probes",
      NODE_OPTIONS: "--insecure-option",
      NODE_EXTRA_CA_CERTS: "fixture.pem",
    },
    runCommand: fixture.runCommand,
  });

  assert.equal(result.nodeExecutable, fixture.nodeExecutable);
  assert.equal(result.npmCli, fixture.npmCli);
  assert.equal(result.receipt.node.path, fixture.nodeExecutable);
  assert.equal(result.receipt.node.version, "24.21.0");
  assert.equal(result.receipt.npmCli.path, fixture.npmCli);
  assert.equal(result.receipt.npmCli.version, "11.6.2");
  assert.equal(result.receipt.mktToolPackageLock.path, "package-lock.json");
  assert.equal(result.receipt.mktToolPackageLock.sizeBytes, readFileSync(fixture.packageLockPath).length);
  for (const call of fixture.environments) {
    assert.equal(call.environment.SAFE_VALUE, "kept");
    for (const forbidden of [
      "MKTTOOL_RELEASE_TOKEN",
      "MKT_RELEASE_TOKEN_AFTER_VERIFICATION",
      "NPM_TOKEN",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      assert.equal(call.environment[forbidden], undefined, `${forbidden} must not reach a receipt probe`);
    }
  }
});

test("rejects a missing Node, a lock outside the isolated MKTTool checkout, and malformed receipts", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () => buildRelayBuildToolchainReceipt({
      nodeExecutable: path.join(fixture.root, "missing-node.exe"),
      mktToolRoot: fixture.mktToolRoot,
      packageLockPath: fixture.packageLockPath,
      runCommand: fixture.runCommand,
    }),
    /Node\.js executable must name an existing regular file/,
  );
  const outsideLock = write(fixture.root, "outside-package-lock.json", "{}\n");
  assert.throws(
    () => buildRelayBuildToolchainReceipt({
      nodeExecutable: fixture.nodeExecutable,
      mktToolRoot: fixture.mktToolRoot,
      packageLockPath: outsideLock,
      runCommand: fixture.runCommand,
    }),
    /must be the exact package-lock\.json in the isolated MKTTool checkout/,
  );
  const malformedReceiptPath = write(fixture.root, "malformed-receipt.json", "{}");
  assert.throws(() => readRelayBuildToolchainReceipt(malformedReceiptPath), /Relay build toolchain receipt is malformed/);
});

test("detects post-install toolchain or package-lock drift", (t) => {
  const fixture = createFixture(t);
  const result = buildRelayBuildToolchainReceipt({
    nodeExecutable: fixture.nodeExecutable,
    mktToolRoot: fixture.mktToolRoot,
    packageLockPath: fixture.packageLockPath,
    runCommand: fixture.runCommand,
  });
  const receiptPath = write(fixture.root, "relay-build-toolchain.json", JSON.stringify(result.receipt));

  assert.doesNotThrow(() => assertReceiptMatches({
    receiptPath,
    nodeExecutable: fixture.nodeExecutable,
    mktToolRoot: fixture.mktToolRoot,
    packageLockPath: fixture.packageLockPath,
    runCommand: fixture.runCommand,
  }));
  writeFileSync(fixture.packageLockPath, "{\"lockfileVersion\":4}\n", "utf8");
  assert.throws(
    () => assertReceiptMatches({
      receiptPath,
      nodeExecutable: fixture.nodeExecutable,
      mktToolRoot: fixture.mktToolRoot,
      packageLockPath: fixture.packageLockPath,
      runCommand: fixture.runCommand,
    }),
    /Relay build Node\.js, npm CLI, or MKTTool package-lock changed after receipt emission/,
  );
});

test("requires a complete receipt command or an explicit verify target", () => {
  assert.throws(() => parseArguments([]), /--node-executable is required/);
  assert.throws(
    () => parseArguments([
      "--node", "node.exe",
      "--mkttool-root", "MKTTool",
      "--package-lock", "MKTTool/package-lock.json",
    ]),
    /--output is required unless --verify is used/,
  );
  assert.deepEqual(
    parseArguments([
      "--node", "node.exe",
      "--mkttool-root", "MKTTool",
      "--package-lock", "MKTTool/package-lock.json",
      "--verify", "receipt.json",
    ]),
    {
      nodeExecutable: "node.exe",
      mktToolRoot: "MKTTool",
      packageLockPath: "MKTTool/package-lock.json",
      output: null,
      githubOutput: null,
      verify: "receipt.json",
    },
  );
});
