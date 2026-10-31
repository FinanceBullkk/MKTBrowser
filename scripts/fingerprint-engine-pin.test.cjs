const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectFingerprintEnginePin,
  requestedFingerprintEngine,
} = require("./fingerprint-engine-pin.cjs");

const VERSION = "151.0.7922.108.6";
const HASH = "a".repeat(64);
const ARGS = { "engine-version": VERSION, "engine-sha256": HASH };
const URL_WITH_SECRETS =
  "https://user:secret@archive.example/releases/engine.zip?signature=secret#secret";

async function fixture(t, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-engine-pin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pinFile = path.join(root, "MKTTool", "compatibility-updater", "active-engine.json");
  const sourceRoot = path.join(root, "MKTTool", "MKTBrowser", "chromium", "cloakbrowser");
  const runtime = path.join(sourceRoot, "runtime");
  await mkdir(path.dirname(pinFile), { recursive: true });
  await mkdir(runtime, { recursive: true });
  const pin = {
    schemaVersion: 1,
    sequence: 2,
    engineKind: "cloakbrowser",
    version: VERSION,
    sha256: HASH,
    sizeBytes: 123,
    url: URL_WITH_SECRETS,
    ...changes.pin,
  };
  const cache = {
    version: VERSION,
    sha256: HASH,
    binaryRelative: "runtime/chrome.exe",
    ...changes.cache,
  };
  await writeFile(pinFile, changes.pinText ?? JSON.stringify(pin));
  await writeFile(path.join(sourceRoot, "current.json"), JSON.stringify(cache));
  await writeFile(
    path.join(runtime, ".mkt-runtime.json"),
    JSON.stringify({ version: VERSION, ...changes.runtime }),
  );
  if (!changes.missingBinary)
    await writeFile(path.join(runtime, "chrome.exe"), "synthetic executable fixture");
  return { root, pinFile, sourceRoot };
}

test("historical .2 default is preserved and partial/invalid overrides are rejected", () => {
  assert.deepEqual(requestedFingerprintEngine({}), {
    version: "151.0.7922.108.2",
    sha256: "7b16ae3070bfcbed9cd381d03d1a8d57a8baf8f4540650397d620eb8dbe89561",
    explicit: false,
  });
  for (const args of [{ "engine-version": VERSION }, { "engine-sha256": HASH }]) {
    assert.throws(() => requestedFingerprintEngine(args), /together/);
  }
  assert.throws(
    () => requestedFingerprintEngine({ ...ARGS, "engine-version": "../invalid" }),
    /numeric/,
  );
  assert.throws(
    () => requestedFingerprintEngine({ ...ARGS, "engine-sha256": "invalid" }),
    /64 hexadecimal/,
  );
  assert.throws(
    () => requestedFingerprintEngine({ "engine-version": undefined, "engine-sha256": undefined }),
    /numeric/,
  );
});

test("pin drift names both explicit overrides before touching the engine cache", async (t) => {
  const { root, sourceRoot } = await fixture(t);
  await rm(sourceRoot, { recursive: true, force: true });
  await assert.rejects(inspectFingerprintEnginePin({}, { localAppData: root }), (error) => {
    assert.match(error.message, /pin drift.*historical default/);
    assert.match(error.message, /--engine-version 151\.0\.7922\.108\.6 --engine-sha256/);
    assert.doesNotMatch(error.message, /secret|signature=|https?:/);
    return true;
  });
});

test("an explicit matched pin returns only sanitized provenance with a limited verification claim", async (t) => {
  const { root } = await fixture(t);
  const result = await inspectFingerprintEnginePin(ARGS, { localAppData: root });
  assert.equal(result.version, VERSION);
  assert.equal(result.archiveSha256, HASH);
  assert.equal(result.authority.sequence, 2);
  assert.equal(result.authority.url, "https://archive.example/releases/engine.zip");
  assert.equal(result.authority.archive, "engine.zip");
  assert.match(result.verification, /does not revalidate signatures or establish acceptance/);
  assert.doesNotMatch(JSON.stringify(result), /secret|signature=|user:/);
});

test("explicit pin and cache must agree before any measurement", async (t) => {
  const cases = [
    {
      name: "wrong digest",
      args: { ...ARGS, "engine-sha256": "b".repeat(64) },
      message: /pin drift/,
    },
    {
      name: "wrong version",
      args: { ...ARGS, "engine-version": "151.0.7922.108.2" },
      message: /pin drift/,
    },
    { name: "wrong engine", pin: { engineKind: "cft" }, message: /not CloakBrowser/ },
    { name: "cache digest", cache: { sha256: "b".repeat(64) }, message: /cache does not match/ },
    {
      name: "cache version",
      cache: { version: "151.0.7922.108.2" },
      message: /cache does not match/,
    },
    {
      name: "cache traversal",
      cache: { binaryRelative: "../../chrome.exe" },
      message: /cache does not match/,
    },
    {
      name: "runtime version",
      runtime: { version: "151.0.7922.108.2" },
      message: /runtime version/,
    },
    { name: "missing binary", missingBinary: true, message: /incomplete/ },
  ];
  for (const item of cases) {
    await t.test(item.name, async (context) => {
      const { root } = await fixture(context, item);
      await assert.rejects(
        inspectFingerprintEnginePin(item.args ?? ARGS, { localAppData: root }),
        item.message,
      );
    });
  }
});

test("missing, malformed and invalid authorities fail without exposing their contents", async (t) => {
  for (const change of [
    { pin: { sequence: 0 } },
    { pin: { sha256: "secret" } },
    { pin: { url: "not-a-url-secret" } },
    { pinText: `{"url":"${URL_WITH_SECRETS}" broken` },
  ]) {
    await t.test(JSON.stringify(Object.keys(change)), async (context) => {
      const { root } = await fixture(context, change);
      await assert.rejects(inspectFingerprintEnginePin(ARGS, { localAppData: root }), (error) => {
        assert.match(error.message, /active-engine.json.*invalid|active-engine.json.*unreadable/);
        assert.doesNotMatch(error.message, /secret|signature=|https?:/);
        return true;
      });
    });
  }
  const { root, pinFile } = await fixture(t);
  await rm(pinFile);
  await assert.rejects(
    inspectFingerprintEnginePin(ARGS, { localAppData: root }),
    /active-engine.json.*missing/,
  );
});

