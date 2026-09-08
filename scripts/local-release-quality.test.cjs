const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  QUALITY_STEPS, parseQualityArgs, createOutputDirectory, hashFile,
  assertSourceUnchanged, assertCompletedQualityReceipt,
} = require("./local-release-quality-contract.cjs");
const { snapshotRepository, childEnvironment, inspectToolchain } = require("./local-release-source-state.cjs");
const { executeLoggedCommand } = require("./local-release-quality.cjs");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "mkt-quality-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("command list is fixed, ordered, bounded and immutable", () => {
  assert.deepEqual(QUALITY_STEPS.map((step) => step.id), ["verify:node", "audit:production", "test:installer", "test:critical-coverage", "typecheck", "lint", "build"]);
  assert.ok(QUALITY_STEPS.every((step) => Object.isFrozen(step) && step.timeoutMs > 0));
  assert.ok(Object.isFrozen(QUALITY_STEPS));
});

test("CLI accepts only unique absolute paths, never commands or a caller PASS", () => {
  const absolute = path.resolve("synthetic");
  assert.equal(parseQualityArgs(["--output", absolute, "--sibling", absolute, "--yarn-cli", absolute]).output, absolute);
  for (const args of [[], ["--output", "relative"], ["--command", absolute], ["--pass", absolute], ["--output", absolute, "--output", absolute]]) {
    assert.throws(() => parseQualityArgs(args));
  }
});

test("output is new and outside both source roots", (t) => {
  const root = fixture(t);
  const browser = path.join(root, "browser");
  const sibling = path.join(root, "sibling");
  mkdirSync(browser); mkdirSync(sibling);
  for (const repo of [browser, sibling]) assert.throws(() => createOutputDirectory(path.join(repo, "logs"), [browser, sibling]), /outside/);
  const output = path.join(root, "logs");
  assert.equal(createOutputDirectory(output, [browser, sibling]), output);
  assert.throws(() => createOutputDirectory(output, [browser, sibling]), /EEXIST/);
});

test("source receipt rejects dirty trees, untracked input, changed commits and locks", (t) => {
  const root = fixture(t);
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe", windowsHide: true });
  git(["init"]);
  writeFileSync(path.join(root, "yarn.lock"), "synthetic lock");
  git(["add", "--", "yarn.lock"]);
  git(["-c", "core.hooksPath=", "-c", "user.name=Quality Test", "-c", "user.email=quality@example.invalid", "commit", "-m", "synthetic fixture"]);
  const snapshot = snapshotRepository(root, "yarn.lock");
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/);
  assert.match(snapshot.lockfileSha256, /^[a-f0-9]{64}$/);
  for (const key of ["commit", "tree", "lockfileSha256"]) assert.throws(() => assertSourceUnchanged(snapshot, { ...snapshot, [key]: "changed" }), /changed/);
  writeFileSync(path.join(root, "new-input"), "synthetic");
  assert.throws(() => snapshotRepository(root, "yarn.lock"), /clean committed/);
  rmSync(path.join(root, "new-input"));
  writeFileSync(path.join(root, "yarn.lock"), "changed");
  assert.throws(() => snapshotRepository(root, "yarn.lock"), /clean committed/);
});

test("logs actual success and nonzero exits without interpreting output as PASS", (t) => {
  const root = fixture(t);
  for (const exit of [0, 7]) {
    const logPath = path.join(root, `${exit}.log`);
    const result = executeLoggedCommand(process.execPath, ["-e", `console.log('PASS');process.exit(${exit})`], { cwd: root, env: process.env, timeoutMs: 5_000, logPath });
    assert.equal(result.exitCode, exit);
    assert.equal(result.logSha256, hashFile(logPath));
    assert.equal(result.timedOut, false);
  }
});

test("timeout and missing executable fail closed", (t) => {
  const root = fixture(t);
  const timeout = executeLoggedCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: root, env: process.env, timeoutMs: 50, logPath: path.join(root, "timeout.log") });
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.exitCode, 0);
  const missing = executeLoggedCommand(path.join(root, "absent.exe"), [], { cwd: root, env: process.env, timeoutMs: 50, logPath: path.join(root, "missing.log") });
  assert.equal(missing.spawnError, true);
  assert.notEqual(missing.exitCode, 0);
});

function syntheticReceipt(root) {
  const source = { browser: { commit: "synthetic", tree: "synthetic" }, mkttool: { commit: "synthetic", tree: "synthetic" } };
  return {
    schemaVersion: 1, kind: "local-quality-command-evidence", status: "completed", acceptance: "OPEN",
    releaseReady: false, testSkips: "NOT_EVALUATED", failure: null, before: source, after: source,
    toolchain: { nodeVersion: "22.23.2", yarnVersion: "4.5.0" },
    results: QUALITY_STEPS.map((step, index) => {
      const log = `${String(index + 1).padStart(2, "0")}-${step.id.replaceAll(":", "-")}.log`;
      writeFileSync(path.join(root, log), "SYNTHETIC UNIT TEST ONLY");
      return { ...step, log, logSha256: hashFile(path.join(root, log)), exitCode: 0, signal: null, timedOut: false, spawnError: false, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" };
    }),
  };
}

test("receipt contract rejects missing, reordered, failed, promoted or tampered evidence", (t) => {
  const root = fixture(t);
  const valid = syntheticReceipt(root);
  assert.doesNotThrow(() => assertCompletedQualityReceipt(valid, root));
  for (const change of [
    (value) => { value.results.pop(); },
    (value) => { value.results.reverse(); },
    (value) => { value.results[0].exitCode = 1; },
    (value) => { value.results[0].timedOut = true; },
    (value) => { value.results[0].log = "../outside"; },
    (value) => { value.results[0].logSha256 = "forged"; },
    (value) => { value.after = { wrongSource: true }; },
    (value) => { value.acceptance = "PASS"; },
    (value) => { value.releaseReady = true; },
    (value) => { value.toolchain.yarnVersion = "1.22.22"; },
  ]) {
    const changed = structuredClone(valid); change(changed);
    assert.throws(() => assertCompletedQualityReceipt(changed, root));
  }
  writeFileSync(path.join(root, valid.results[0].log), "tampered");
  assert.throws(() => assertCompletedQualityReceipt(valid, root), /tampered/);
});

test("environment binds the recorded sibling instead of inherited checkout roots", (t) => {
  const sibling = path.resolve("recorded-sibling");
  const stale = path.resolve("stale-sibling");
  const names = ["MKTTOOL_ROOT", "MKTTOOL_REPO_ROOT"];
  const previous = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  });
  for (const name of names) process.env[name] = stale;
  const env = childEnvironment(sibling);
  assert.equal(env.MKTTOOL_ROOT, sibling);
  assert.notEqual(env.MKTTOOL_ROOT, stale);
  assert.equal(env.MKTTOOL_REPO_ROOT, undefined);
});

test("environment only inherits OS paths, never credentials or GitHub controls", (t) => {
  const names = [
    "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "NPM_TOKEN",
    "RELAY_RELEASE_R2_ACCESS_KEY_ID", "RELAY_RELEASE_R2_SECRET_ACCESS_KEY",
    "CLOAKBROWSER_LICENSE_KEY", "UNREVIEWED_ENVIRONMENT_SETTING",
  ];
  const previous = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  });
  for (const name of names) process.env[name] = "synthetic-test-only";
  const env = childEnvironment("recorded-sibling");
  for (const name of names) assert.equal(env[name], undefined, name);
  const allowed = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "MKTTOOL_ROOT",
    "COREPACK_ENABLE_PROJECT_SPEC", "COREPACK_ENABLE_NETWORK", "YARN_ENABLE_IMMUTABLE_INSTALLS",
  ]);
  assert.ok(Object.keys(env).every((name) => allowed.has(name)));
  assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.equal(env.MKTTOOL_ROOT, "recorded-sibling");
  assert.equal(env.COREPACK_ENABLE_PROJECT_SPEC, "1");
  assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(env.YARN_ENABLE_IMMUTABLE_INSTALLS, "true");
});

test("environment excludes inherited injection flags and toolchain rejects a wrong pin", (t) => {
  const env = childEnvironment("synthetic-sibling");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.MKT_BROWSER_ALLOW_UNPINNED_ENGINE, undefined);
  const root = fixture(t);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22" }));
  assert.throws(() => inspectToolchain(root, path.join(root, "absent.js"), env), /Node 22|package-manager pin/);
});
