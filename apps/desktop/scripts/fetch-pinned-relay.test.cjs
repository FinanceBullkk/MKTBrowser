const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.resolve(__dirname, "fetch-pinned-relay.cjs");

// Ambient configuration must not decide what these tests measure, and the machine that runs them is
// exactly the machine that exports these two. With MKTTOOL_RELAY_ARCHIVE set, the download cases
// stop exercising the download at all and fail comparing a 32 MB archive against an 8-byte fixture —
// which is how a green suite turned red on 12 August without a line of source changing.
delete process.env.MKTTOOL_RELAY_ARCHIVE;
delete process.env.MKTTOOL_RELEASE_TOKEN;

function loadIsolated(manifest, initialPartial = null) {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-relay-fetch-"));
  const source = readFileSync(scriptPath, "utf8")
    .replace('const desktopRoot = path.resolve(__dirname, "..");', `const desktopRoot = ${JSON.stringify(root)};`);
  writeFileSync(path.join(root, "relay-release.json"), JSON.stringify(manifest));
  if (initialPartial) {
    require("node:fs").mkdirSync(path.join(root, ".relay-payload"));
    writeFileSync(path.join(root, ".relay-payload", `MKTTool-Relay-v${manifest.version}.zip.partial`), initialPartial);
  }
  const modulePath = path.join(root, "fetch.cjs");
  writeFileSync(modulePath, source);
  return { api: require(modulePath), root };
}

test("downloads the immutable URL and verifies SHA-256", async (t) => {
  const bytes = Buffer.from("relay-v7");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { api, root } = loadIsolated({ version: 7, sizeBytes: bytes.length, sha256, url: "https://example.test/api/relay/download/v7" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await api.fetchPinnedRelay({ fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(readFileSync(result.archivePath), bytes);
});

test("resumes a partial download with Range", async (t) => {
  const bytes = Buffer.from("relay-v7");
  const partial = bytes.subarray(0, 4);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { api, root } = loadIsolated({ version: 7, sizeBytes: bytes.length, sha256, url: "https://example.test/api/relay/download/v7" }, partial);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await api.fetchPinnedRelay({ fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Range, "bytes=4-");
    return new Response(bytes.subarray(4), { status: 206 });
  } });
});

test("fails closed before hashing when the downloaded size is wrong", async (t) => {
  const { api, root } = loadIsolated({ version: 7, sizeBytes: 99, sha256: "0".repeat(64), url: "https://example.test/api/relay/download/v7" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => api.fetchPinnedRelay({ fetchImpl: async () => new Response("short") }), /size mismatch/);
});

test("fails closed when the checksum is wrong", async (t) => {
  const bytes = Buffer.from("tampered");
  const { api, root } = loadIsolated({ version: 7, sizeBytes: bytes.length, sha256: "0".repeat(64), url: "https://example.test/api/relay/download/v7" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => api.fetchPinnedRelay({ fetchImpl: async () => new Response(bytes) }), /checksum mismatch/);
});

test("rejects a manifest without a pinned size", (t) => {
  const { api, root } = loadIsolated({ version: 7, sha256: "0".repeat(64), url: "https://example.test/api/relay/download/v7" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => api.readManifest(), /sizeBytes/);
});
