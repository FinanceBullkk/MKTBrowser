const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
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

function runPowerShellAsync(powershell, scriptPath, environment) {
  let child;
  const result = new Promise((resolve, reject) => {
    child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell fetcher did not finish: ${scriptPath}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ child, status, signal, stdout, stderr });
    });
  });
  return { child, result };
}

async function waitForPath(file, label) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`${label} was not created`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the tokenized fetcher validates the exact canonical release URL before reading its token", () => {
  const source = readFileSync(tokenizedFetcherPath, "utf8");
  const canonicalValidation = source.indexOf("Pinned Relay URL must equal the canonical immutable Relay release URL.");
  const eligibilityValidation = source.indexOf("Pinned Relay tuple is not eligible for tokenized Windows packaging.");
  const tokenRead = source.indexOf("$releaseToken = ([string]$env:MKTTOOL_RELEASE_TOKEN).Trim()");

  assert.match(source, /\$canonicalRelayOrigin = "https:\/\/mkttool-web-production\.up\.railway\.app"/);
  assert.ok(canonicalValidation >= 0, "the exact Relay URL must be checked");
  assert.ok(eligibilityValidation >= 0, "the tokenized fetcher must reject quarantined Relay tuples");
  assert.ok(tokenRead > eligibilityValidation, "the token was read before eligibility was checked");
  assert.ok(tokenRead > canonicalValidation, "the token was read before the canonical URL check");
});

test("the tokenized PowerShell fetch refuses a quarantined tuple before staging", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createFixture(t);
  const archiveBytes = Buffer.from("quarantined-tokenized-relay");
  const archivePath = path.join(fixture.root, "source-relay.zip");
  const manifest = {
    version: 70,
    sizeBytes: archiveBytes.length,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    minimumProfileActionRelayVersion: 71,
    promotionStatus: "quarantined",
    url: canonicalUrl(70),
  };
  writeFileSync(archivePath, archiveBytes);
  writeFileSync(path.join(fixture.snapshotDesktopRoot, "relay-release.json"), JSON.stringify(manifest));

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const token = "test-quarantined-relay-token";
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

  assert.notEqual(staged.status, 0);
  assert.match(`${staged.stdout}${staged.stderr}`, /not eligible for tokenized Windows packaging/i);
  assert.equal(existsSync(fixture.handoffPath), false, "a quarantined tuple created a handoff receipt");
  assert.equal(existsSync(path.join(fixture.snapshotDesktopRoot, ".relay-payload")), false, "a quarantined tuple staged a cache directory");
  assert.equal(`${staged.stdout}${staged.stderr}`.includes(token), false, "the tokenized fetch printed the release token");
});

test("the tokenized PowerShell fetch serializes shared cache staging and keeps handoffs separate", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  const fixture = createFixture(t);
  const archiveBytes = Buffer.from("concurrent-tokenized-relay-cache");
  const archivePath = path.join(fixture.root, "source-relay.zip");
  const manifest = {
    version: 72,
    sizeBytes: archiveBytes.length,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    minimumProfileActionRelayVersion: 20,
    promotionStatus: "eligible",
    url: canonicalUrl(72),
  };
  writeFileSync(archivePath, archiveBytes);
  writeFileSync(path.join(fixture.snapshotDesktopRoot, "relay-release.json"), JSON.stringify(manifest));

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const mutexName = `Local\\MKTBrowserRelayPayload-v${manifest.version}-${manifest.sha256.slice(0, 16)}`;
  const holderPath = path.join(fixture.root, "hold-relay-cache-mutex.ps1");
  const readyPath = path.join(fixture.root, "mutex-ready.txt");
  const releasePath = path.join(fixture.root, "mutex-release.txt");
  const firstHandoffPath = path.join(fixture.root, "first-handoff.txt");
  const secondHandoffPath = path.join(fixture.root, "second-handoff.txt");
  writeFileSync(
    holderPath,
    [
      "param([string]$MutexName, [string]$ReadyPath, [string]$ReleasePath)",
      '$ErrorActionPreference = "Stop"',
      "$mutex = [Threading.Mutex]::new($false, $MutexName)",
      "$held = $false",
      "try {",
      "  $held = $mutex.WaitOne(5000)",
      "  if (-not $held) { exit 2 }",
      "  [IO.File]::WriteAllText($ReadyPath, 'ready', [Text.UTF8Encoding]::new($false))",
      "  $deadline = [DateTime]::UtcNow.AddSeconds(10)",
      "  while (-not (Test-Path -LiteralPath $ReleasePath)) {",
      "    if ([DateTime]::UtcNow -ge $deadline) { throw 'The mutex release marker was not written.' }",
      "    Start-Sleep -Milliseconds 20",
      "  }",
      "} finally {",
      "  if ($held) { [void]$mutex.ReleaseMutex() }",
      "  $mutex.Dispose()",
      "}",
    ].join("\n"),
    "utf8",
  );

  const holder = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", holderPath, mutexName, readyPath, releasePath], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const holderResult = new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.once("close", (status, signal) => resolve({ status, signal }));
  });
  await waitForPath(readyPath, "the Relay cache mutex holder");

  const first = runPowerShellAsync(powershell, fixture.tokenizedFetcher, {
    ...process.env,
    MKTTOOL_RELAY_ARCHIVE: archivePath,
    MKT_BROWSER_RELAY_HANDOFF_PATH: firstHandoffPath,
  });
  const second = runPowerShellAsync(powershell, fixture.tokenizedFetcher, {
    ...process.env,
    MKTTOOL_RELAY_ARCHIVE: archivePath,
    MKT_BROWSER_RELAY_HANDOFF_PATH: secondHandoffPath,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(first.child.exitCode, null, "the first fetch bypassed the shared-cache mutex");
  assert.equal(second.child.exitCode, null, "the second fetch bypassed the shared-cache mutex");

  writeFileSync(releasePath, "release", "utf8");
  const [holderExit, firstResult, secondResult] = await Promise.all([holderResult, first.result, second.result]);
  assert.equal(holderExit.status, 0, "the Relay cache mutex holder did not complete");
  assert.equal(firstResult.status, 0, firstResult.stderr || "first shared-cache fetch did not complete");
  assert.equal(secondResult.status, 0, secondResult.stderr || "second shared-cache fetch did not complete");

  const snapshotCachePath = path.join(fixture.snapshotDesktopRoot, ".relay-payload", "MKTTool-Relay-v72.zip");
  assert.deepEqual(readFileSync(snapshotCachePath), archiveBytes);
  assert.equal(path.resolve(readFileSync(firstHandoffPath, "utf8").trim()), path.resolve(snapshotCachePath));
  assert.equal(path.resolve(readFileSync(secondHandoffPath, "utf8").trim()), path.resolve(snapshotCachePath));
});

test("the tokenized PowerShell fetch never overwrites an existing handoff receipt", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createFixture(t);
  const archiveBytes = Buffer.from("handoff-collision-relay-cache");
  const archivePath = path.join(fixture.root, "source-relay.zip");
  const manifest = {
    version: 73,
    sizeBytes: archiveBytes.length,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    minimumProfileActionRelayVersion: 20,
    promotionStatus: "eligible",
    url: canonicalUrl(73),
  };
  writeFileSync(archivePath, archiveBytes);
  writeFileSync(path.join(fixture.snapshotDesktopRoot, "relay-release.json"), JSON.stringify(manifest));
  writeFileSync(fixture.handoffPath, "another invocation owns this receipt", "utf8");

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const staged = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.tokenizedFetcher],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MKTTOOL_RELAY_ARCHIVE: archivePath,
        MKT_BROWSER_RELAY_HANDOFF_PATH: fixture.handoffPath,
      },
      windowsHide: true,
    },
  );

  assert.notEqual(staged.status, 0);
  assert.equal(readFileSync(fixture.handoffPath, "utf8"), "another invocation owns this receipt");
});

test("the tokenized PowerShell fetch rehashes its snapshot archive into a separate package root without network fallback", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = createFixture(t);
  const archiveBytes = Buffer.from("tokenized-relay-cache-handoff");
  const archivePath = path.join(fixture.root, "source-relay.zip");
  const manifest = {
    version: 71,
    sizeBytes: archiveBytes.length,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    minimumProfileActionRelayVersion: 20,
    promotionStatus: "eligible",
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

  rmSync(fixture.handoffPath, { force: true });
  const cached = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.tokenizedFetcher],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MKTTOOL_RELEASE_TOKEN: "",
        MKT_BROWSER_RELAY_HANDOFF_PATH: fixture.handoffPath,
      },
      windowsHide: true,
    },
  );
  assert.equal(cached.status, 0, cached.stderr || "the cached tokenized Relay fetch did not complete");
  assert.equal(
    path.resolve(readFileSync(fixture.handoffPath, "utf8").trim()),
    path.resolve(snapshotCachePath),
    "a verified cache hit did not recreate its Relay handoff receipt",
  );
  assert.equal(`${cached.stdout}${cached.stderr}`.includes(token), false, "the cached fetch printed the release token");

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
