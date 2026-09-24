const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  TOKEN_CONSUMER_FILES,
  buildTokenConsumerIdentity,
  createVerifiedTokenConsumerSnapshot,
  parseArguments,
  verifyTokenConsumers,
} = require("./verify-tokenized-relay-consumers.cjs");

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mkt-token-consumer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrapperPath = write(root, TOKEN_CONSUMER_FILES[0], "@echo off\n");
  const fetcherPath = write(root, TOKEN_CONSUMER_FILES[1], "exit 0\n");
  const manifestPath = write(root, TOKEN_CONSUMER_FILES[2], "{\"version\":19}\n");
  const tokenConsumers = buildTokenConsumerIdentity(root);
  return {
    root,
    wrapperPath,
    fetcherPath,
    manifestPath,
    binding: {
      schemaVersion: 5,
      type: "mktbrowser.release-candidate-source-binding",
      browser: {
        hashes: Object.fromEntries(tokenConsumers.map((consumer) => [consumer.relativePath, consumer.sha256])),
      },
      tokenConsumers,
    },
  };
}

test("rejects a changed token-consuming wrapper before it can receive a release token", (t) => {
  const fixture = createFixture(t);
  const original = readFileSync(fixture.wrapperPath, "utf8");

  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }));
  writeFileSync(fixture.wrapperPath, `${original}rem replaced before token injection\n`, "utf8");
  assert.throws(
    () => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }),
    /Token-bearing Relay input changed after source binding/,
  );
  writeFileSync(fixture.wrapperPath, original, "utf8");
  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }));
});

test("binds every token-bearing input and rejects a changed fetcher", (t) => {
  const fixture = createFixture(t);
  const original = readFileSync(fixture.fetcherPath, "utf8");

  assert.deepEqual(
    fixture.binding.tokenConsumers.map((consumer) => ({
      relativePath: consumer.relativePath,
      canonicalRelativePath: consumer.canonicalRelativePath,
    })),
    TOKEN_CONSUMER_FILES.map((relativePath) => ({ relativePath, canonicalRelativePath: relativePath })),
  );
  writeFileSync(fixture.fetcherPath, `${original}Write-Output 'changed'\n`, "utf8");
  assert.throws(
    () => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }),
    /Token-bearing Relay input changed after source binding/,
  );
});

test("copies verified token consumers to an independent snapshot before source can change", (t) => {
  const fixture = createFixture(t);
  const snapshotRoot = `${fixture.root}-snapshot`;
  t.after(() => rmSync(snapshotRoot, { recursive: true, force: true }));
  const originalFetcher = readFileSync(fixture.fetcherPath, "utf8");
  const originalManifest = readFileSync(fixture.manifestPath, "utf8");

  const snapshot = createVerifiedTokenConsumerSnapshot({
    browserRoot: fixture.root,
    binding: fixture.binding,
    snapshotRoot,
  });
  assert.equal(snapshot.root, path.resolve(snapshotRoot));
  assert.equal(snapshot.wrapperPath, path.join(snapshot.root, TOKEN_CONSUMER_FILES[0]));
  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: snapshot.root, binding: fixture.binding }));

  writeFileSync(fixture.fetcherPath, "Write-Output 'mutated after snapshot'\n", "utf8");
  writeFileSync(fixture.manifestPath, "{\"version\":20}\n", "utf8");
  assert.throws(
    () => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }),
    /Token-bearing Relay input changed after source binding/,
  );
  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: snapshot.root, binding: fixture.binding }));

  // Restoring a mutable checkout cannot alter the already selected snapshot bytes.
  writeFileSync(fixture.fetcherPath, originalFetcher, "utf8");
  writeFileSync(fixture.manifestPath, originalManifest, "utf8");
  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: fixture.root, binding: fixture.binding }));
  assert.doesNotThrow(() => verifyTokenConsumers({ browserRoot: snapshot.root, binding: fixture.binding }));
});

test("rejects a missing, nested, or tampered token-consumer snapshot", (t) => {
  const fixture = createFixture(t);
  const nestedSnapshotRoot = path.join(fixture.root, "snapshot");
  assert.throws(
    () => createVerifiedTokenConsumerSnapshot({
      browserRoot: fixture.root,
      binding: fixture.binding,
      snapshotRoot: nestedSnapshotRoot,
    }),
    /outside Browser source/,
  );

  const snapshotRoot = `${fixture.root}-snapshot-tamper`;
  t.after(() => rmSync(snapshotRoot, { recursive: true, force: true }));
  createVerifiedTokenConsumerSnapshot({
    browserRoot: fixture.root,
    binding: fixture.binding,
    snapshotRoot,
  });
  writeFileSync(path.join(snapshotRoot, TOKEN_CONSUMER_FILES[0]), "@echo off\nrem tampered\n", "utf8");
  assert.throws(
    () => verifyTokenConsumers({ browserRoot: snapshotRoot, binding: fixture.binding }),
    /Token-bearing Relay input changed after source binding/,
  );
});

test("requires the exact binding inputs", () => {
  assert.throws(() => parseArguments([]), /browser-root/);
  assert.throws(() => parseArguments(["--browser-root", "browser"]), /binding/);
  assert.throws(
    () => parseArguments(["--binding", "binding.json", "--browser-root", "browser", "--unexpected", "x"]),
    /Unknown option/,
  );
});
