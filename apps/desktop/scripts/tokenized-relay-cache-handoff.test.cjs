const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tokenizedFetcherPath = path.resolve(__dirname, "fetch-pinned-relay-for-tokenized-package.ps1");
const tokenlessFetcherPath = path.resolve(__dirname, "fetch-pinned-relay.cjs");
const canonicalUrl = (version) =>
  `https://mkttool-web-production.up.railway.app/api/relay/download/v${version}`;

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-tokenized-relay-cache-"));
  const snapshotDesktopRoot = path.join(root, "token-consumer-snapshot", "apps", "desktop");
  const packageDesktopRoot = path.join(root, "original-browser-checkout", "apps", "desktop");
  const snapshotScriptsRoot = path.join(snapshotDesktopRoot, "scripts");
  const packageScriptsRoot = path.join(packageDesktopRoot, "scripts");
  mkdirSync(snapshotScriptsRoot, { recursive: true });
  mkdirSync(packageScriptsRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tokenizedFetcher = path.join(snapshotScriptsRoot, path.basename(tokenizedFetcherPath));
  const tokenlessFetcher = path.join(packageScriptsRoot, path.basename(tokenlessFetcherPath));
  copyFileSync(tokenizedFetcherPath, tokenizedFetcher);
  copyFileSync(tokenlessFetcherPath, tokenlessFetcher);
  return {
    root,
    snapshotDesktopRoot,
    packageDesktopRoot,
    tokenizedFetcher,
    tokenlessFetcher,
    handoffPath: path.join(root, "relay-handoff.txt"),
  };
}

test("the tokenized fetcher validates the exact canonical release URL before reading its token", () => {
  const source = readFileSync(tokenizedFetcherPath, "utf8");
  const canonicalValidation = source.indexOf("Pinned Relay URL must equal the canonical immutable Relay release URL.");
  const tokenRead = source.indexOf("$releaseToken = ([string]$env:MKTTOOL_RELEASE_TOKEN).Trim()");

  assert.match(source, /\$canonicalRelayOrigin = "https:\/\/mkttool-web-production\.up\.railway\.app"/);
  assert.ok(canonicalValidation >= 0, "the exact Relay URL must be checked");
  assert.ok(tokenRead > canonicalValidation, "the token was read before the canonical URL check");
});

test("the tokenized PowerShell fetch rehashes its snapshot archive into a separate package root without network fallback", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = createFixture(t);
  const archiveBytes = Buffer.from("tokenized-relay-cache-handoff");
  const archivePath = path.join(fixture.root, "source-relay.zip");
  const manifest = {
    version: 71,
    sizeBytes: archiveBytes.length,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    url: canonicalUrl(71),
  };
  writeFileSync(archivePath, archiveBytes);
  writeFileSync(path.join(fixture.snapshotDesktopRoot, "relay-release.json"), JSON.stringify(manifest));
  writeFileSync(path.join(fixture.packageDesktopRoot, "relay-release.json"), JSON.stringify(manifest));

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const token = "test-tokenized-relay-cache-token";
  const staged = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.tokenizedFetcher],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MKTTOOL_RELEASE_TOKEN: token,
        MKTTOOL_RELAY_ARCHIVE: archivePath,
        MKT_BROWSER_RELAY_HANDOFF_PATH: fixture.handoffPath,
      },
      windowsHide: true,
    },
  );
  assert.equal(staged.status, 0, staged.stderr || "the tokenized Relay fetch did not complete");
  assert.equal(`${staged.stdout}${staged.stderr}`.includes(token), false, "the tokenized fetch printed the release token");

  const snapshotCachePath = path.join(fixture.snapshotDesktopRoot, ".relay-payload", "MKTTool-Relay-v71.zip");
  assert.equal(existsSync(snapshotCachePath), true, "the tokenized fetch did not create the snapshot cache file");
  assert.deepEqual(readFileSync(snapshotCachePath), archiveBytes);
  assert.equal(path.resolve(readFileSync(fixture.handoffPath, "utf8").trim()), path.resolve(snapshotCachePath));
  assert.equal(readFileSync(fixture.handoffPath, "utf8").includes(token), false, "the handoff receipt contained the release token");

  const cacheKey = require.resolve(fixture.tokenlessFetcher);
  const { fetchPinnedRelay } = require(cacheKey);
  t.after(() => delete require.cache[cacheKey]);
  let fetchCalled = false;
  await assert.rejects(() => fetchPinnedRelay({
    environment: { MKTTOOL_RELAY_ARCHIVE: path.join(fixture.root, "missing-relay.zip") },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("the original package cache attempted a network fallback");
    },
  }), /Local pinned Relay archive not found/);
  assert.equal(fetchCalled, false, "a failed Relay handoff fell back to the network");

  const handoffStaged = await fetchPinnedRelay({
    environment: { MKTTOOL_RELAY_ARCHIVE: snapshotCachePath },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("the original package cache attempted a network fallback");
    },
  });

  const originalCachePath = path.join(fixture.packageDesktopRoot, ".relay-payload", "MKTTool-Relay-v71.zip");
  assert.equal(fetchCalled, false, "the archive handoff used a network fallback");
  assert.equal(handoffStaged.archivePath, originalCachePath);
  assert.notEqual(path.resolve(handoffStaged.archivePath), path.resolve(snapshotCachePath));
  assert.deepEqual(readFileSync(handoffStaged.archivePath), archiveBytes);

  rmSync(snapshotCachePath, { force: true });
  const result = await fetchPinnedRelay({
    environment: Object.create(null),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("the tokenless package step attempted a new Relay download");
    },
  });

  assert.equal(fetchCalled, false, "the package step did not reuse the original-root Relay cache");
  assert.equal(result.archivePath, originalCachePath);
  assert.deepEqual(readFileSync(result.archivePath), archiveBytes);
});
