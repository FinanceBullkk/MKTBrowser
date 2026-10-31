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

const wrapperPath = path.resolve(__dirname, "package-tokenized-windows-installer.cmd");
const unsafeEnvironmentNames = [
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "ELECTRON_RUN_AS_NODE",
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeYarnObserver(file, resultEnvironmentName) {
  writeFileSync(
    file,
    [
      'const { writeFileSync } = require("node:fs");',
      'if (process.argv.length === 3 && process.argv[2] === "--version") {',
      '  process.stdout.write("4.5.0\\n");',
      '} else {',
       `const unsafe = ${JSON.stringify(unsafeEnvironmentNames)};`,
       "const inheritedUnsafe = Object.keys(process.env).filter((name) => unsafe.includes(name.toUpperCase()));",
       "const token = process.env.MKTTOOL_RELEASE_TOKEN ?? \"\";",
       "const relayArchive = process.env.MKTTOOL_RELAY_ARCHIVE ?? \"\";",
       `writeFileSync(process.env.${resultEnvironmentName}, JSON.stringify({`,
       "  tokenPresent: Boolean(token),",
       "  tokenLength: token.length,",
       "  relayArchivePresent: Boolean(relayArchive),",
       "  inheritedUnsafe,",
       "  workingDirectory: process.cwd(),",
       "  args: process.argv.slice(2),",
      "}));",
      "}",
    ].join("\n"),
    "utf8",
  );
}

function writePowerShellObserver(file, mutationEnvironmentName = null) {
  writeFileSync(
    file,
    [
      "$unsafe = @(\"NODE_OPTIONS\", \"NODE_EXTRA_CA_CERTS\", \"NODE_USE_SYSTEM_CA\", \"NODE_TLS_REJECT_UNAUTHORIZED\", \"ELECTRON_RUN_AS_NODE\")",
      "$inheritedUnsafe = @(Get-ChildItem Env: | Where-Object { $unsafe -contains $_.Name.ToUpperInvariant() } | ForEach-Object { $_.Name })",
       "$token = [string]$env:MKTTOOL_RELEASE_TOKEN",
       "$result = [ordered]@{ tokenPresent = -not [string]::IsNullOrWhiteSpace($token); tokenLength = $token.Length; inheritedUnsafe = $inheritedUnsafe }",
       "[IO.File]::WriteAllText($env:MKT_BROWSER_DOWNLOADER_RESULT, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))",
       "$handoffPath = [string]$env:MKT_BROWSER_RELAY_HANDOFF_PATH",
       "$snapshotArchive = [string]$env:MKT_BROWSER_SNAPSHOT_RELAY_ARCHIVE",
       "if ([string]::IsNullOrWhiteSpace($handoffPath) -or [string]::IsNullOrWhiteSpace($snapshotArchive)) { exit 1 }",
       "[IO.File]::WriteAllText($handoffPath, $snapshotArchive, [Text.UTF8Encoding]::new($false))",
       ...(mutationEnvironmentName
        ? [`Add-Content -LiteralPath $env:${mutationEnvironmentName} -Value "changed-after-first-validation"`]
        : []),
    ].join("\n"),
    "utf8",
  );
}

function writeConcurrentPowerShellObserver(file) {
  writeFileSync(
    file,
    [
      "$handoffPath = ([string]$env:MKT_BROWSER_RELAY_HANDOFF_PATH).Trim()",
      "$snapshotArchive = ([string]$env:MKT_BROWSER_SNAPSHOT_RELAY_ARCHIVE).Trim()",
      "if (-not $handoffPath -or -not $snapshotArchive) { exit 1 }",
      "$waitForMarker = ([string]$env:MKT_BROWSER_DOWNLOADER_WAIT_FOR_MARKER).Trim()",
      "if ($waitForMarker) {",
      "  $deadline = [DateTime]::UtcNow.AddSeconds(10)",
      "  while (-not (Test-Path -LiteralPath $waitForMarker)) {",
      "    if ([DateTime]::UtcNow -ge $deadline) { throw 'The concurrent handoff marker was not released.' }",
      "    Start-Sleep -Milliseconds 10",
      "  }",
      "}",
      "[IO.File]::WriteAllText($handoffPath, $snapshotArchive, [Text.UTF8Encoding]::new($false))",
      "$afterHandoffMarker = ([string]$env:MKT_BROWSER_DOWNLOADER_AFTER_HANDOFF_MARKER).Trim()",
      "if ($afterHandoffMarker) { [IO.File]::WriteAllText($afterHandoffMarker, 'ready', [Text.UTF8Encoding]::new($false)) }",
      "$delayMilliseconds = 0",
      "[void][int]::TryParse(([string]$env:MKT_BROWSER_DOWNLOADER_AFTER_HANDOFF_DELAY_MS), [ref]$delayMilliseconds)",
      "if ($delayMilliseconds -gt 0) { Start-Sleep -Milliseconds $delayMilliseconds }",
    ].join("\n"),
    "utf8",
  );
}

function writeOriginalRelayStager(file, resultEnvironmentName) {
  writeFileSync(
    file,
    [
      'const { existsSync, writeFileSync } = require("node:fs");',
      'const token = process.env.MKTTOOL_RELEASE_TOKEN ?? "";',
      'const archivePath = process.env.MKTTOOL_RELAY_ARCHIVE ?? "";',
      `writeFileSync(process.env.${resultEnvironmentName}, JSON.stringify({`,
      '  tokenPresent: Boolean(token),',
      '  archivePath,',
      '  archivePresent: Boolean(archivePath) && existsSync(archivePath),',
      '  workingDirectory: process.cwd(),',
      '}));',
      'if (token || !archivePath || !existsSync(archivePath)) process.exitCode = 1;',
    ].join("\n"),
    "utf8",
  );
}

function createWrapperFixture(t, { mutate = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mktbrowser-tokenized-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const snapshotRoot = path.join(root, "token-consumer-snapshot");
  const scriptsDirectory = path.join(snapshotRoot, "apps", "desktop", "scripts");
  const packageRoot = path.join(root, "original-browser-checkout");
  const packageScriptsDirectory = path.join(packageRoot, "apps", "desktop", "scripts");
  const nodeDirectory = path.join(root, "node22");
  const corepackDirectory = path.join(nodeDirectory, "node_modules", "corepack", "dist");
  const yarnDirectory = path.join(root, "corepack-home", "v1");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(packageScriptsDirectory, { recursive: true });
  mkdirSync(corepackDirectory, { recursive: true });
  mkdirSync(yarnDirectory, { recursive: true });

  const fixtureWrapper = path.join(scriptsDirectory, path.basename(wrapperPath));
  const tokenFetcherPath = path.join(scriptsDirectory, "fetch-pinned-relay-for-tokenized-package.ps1");
  const originalRelayFetcherPath = path.join(packageScriptsDirectory, "fetch-pinned-relay.cjs");
  const snapshotArchivePath = path.join(
    snapshotRoot,
    "apps",
    "desktop",
    ".relay-payload",
    "MKTTool-Relay-v71.zip",
  );
  const nodePath = path.join(nodeDirectory, "node.exe");
  const corepackPath = path.join(corepackDirectory, "corepack.js");
  const yarnPath = path.join(yarnDirectory, "yarn.js");
  const wrongCorepackPath = path.join(root, "wrong-corepack.js");

  copyFileSync(wrapperPath, fixtureWrapper);
  copyFileSync(process.execPath, nodePath);
  mkdirSync(path.dirname(snapshotArchivePath), { recursive: true });
  writeFileSync(snapshotArchivePath, "verified snapshot Relay archive", "utf8");
  writePowerShellObserver(
    tokenFetcherPath,
    mutate === "corepack" ? "MKT_BROWSER_MUTATE_COREPACK" :
      (mutate === "yarn" ? "MKT_BROWSER_MUTATE_YARN" : null),
  );
  writeOriginalRelayStager(originalRelayFetcherPath, "MKT_BROWSER_HANDOFF_RESULT");
  writeFileSync(corepackPath, "// receipt-bound Corepack entrypoint\n", "utf8");
  writeFileSync(wrongCorepackPath, "// wrong Corepack entrypoint\n", "utf8");
  writeYarnObserver(yarnPath, "MKT_BROWSER_YARN_RESULT");

  return {
    fixtureWrapper,
    tokenFetcherPath,
    nodePath,
    corepackPath,
    yarnPath,
    wrongCorepackPath,
    packageRoot,
    snapshotArchivePath,
    downloaderResultPath: path.join(root, "downloader-result.json"),
    handoffResultPath: path.join(root, "handoff-result.json"),
    yarnResultPath: path.join(root, "yarn-result.json"),
  };
}

function wrapperEnvironment(fixture, overrides = {}) {
  return {
    ...process.env,
    MKT_BROWSER_NODE22_EXE: fixture.nodePath,
    MKT_BROWSER_NODE22_SHA256: sha256(fixture.nodePath),
    MKT_BROWSER_COREPACK22_ENTRYPOINT: fixture.corepackPath,
    MKT_BROWSER_COREPACK22_SHA256: sha256(fixture.corepackPath),
    MKT_BROWSER_YARN_ENTRYPOINT: fixture.yarnPath,
    MKT_BROWSER_YARN_VERSION: "4.5.0",
    MKT_BROWSER_YARN_SHA256: sha256(fixture.yarnPath),
    MKT_BROWSER_DOWNLOADER_RESULT: fixture.downloaderResultPath,
    MKT_BROWSER_HANDOFF_RESULT: fixture.handoffResultPath,
    MKT_BROWSER_YARN_RESULT: fixture.yarnResultPath,
    MKT_BROWSER_PACKAGE_ROOT: fixture.packageRoot,
    MKT_BROWSER_SNAPSHOT_RELAY_ARCHIVE: fixture.snapshotArchivePath,
    MKTTOOL_RELEASE_TOKEN: "test-release-token-with-bang!",
    NODE_OPTIONS: "--trace-warnings",
    NODE_EXTRA_CA_CERTS: "untrusted-ca.pem",
    NODE_USE_SYSTEM_CA: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    ELECTRON_RUN_AS_NODE: "1",
    ...overrides,
  };
}

function runWrapper(fixture, overrides = {}) {
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:off", "/c", fixture.fixtureWrapper], {
    cwd: path.dirname(path.dirname(fixture.fixtureWrapper)),
    encoding: "utf8",
    env: wrapperEnvironment(fixture, overrides),
    windowsHide: true,
  });
}

function runWrapperAsync(fixture, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:off", "/c", fixture.fixtureWrapper], {
      cwd: path.dirname(path.dirname(fixture.fixtureWrapper)),
      env: wrapperEnvironment(fixture, overrides),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("tokenized wrapper did not exit during concurrent handoff test"));
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
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test("the tokenized Windows wrapper requires and derives the receipt-bound toolchain", () => {
  const wrapper = readFileSync(wrapperPath, "ascii");
  assert.match(wrapper, /^@echo off\r?\nsetlocal DisableDelayedExpansion\r?\n/i);
  for (const name of [
    "MKT_BROWSER_NODE22_EXE",
    "MKT_BROWSER_NODE22_SHA256",
    "MKT_BROWSER_COREPACK22_ENTRYPOINT",
    "MKT_BROWSER_COREPACK22_SHA256",
    "MKT_BROWSER_YARN_ENTRYPOINT",
    "MKT_BROWSER_YARN_VERSION",
    "MKT_BROWSER_YARN_SHA256",
    "MKT_BROWSER_PACKAGE_ROOT",
  ]) {
    assert.match(wrapper, new RegExp(`if not defined ${name}`, "i"));
  }
  assert.doesNotMatch(wrapper, /if not defined MKTTOOL_RELEASE_TOKEN/i);
  assert.match(wrapper, /set "derived_corepack=%node_directory%node_modules\\corepack\\dist\\corepack\.js"/i);
  assert.match(wrapper, /Corepack entrypoint does not match the one derived from the pinned Node\.js executable/i);

  const fetcherInvocation = wrapper.indexOf(
    '"%powershell_exe%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%token_fetcher%"',
  );
  const tokenClear = wrapper.indexOf('set "MKTTOOL_RELEASE_TOKEN="', fetcherInvocation);
  const archiveSet = wrapper.indexOf('set "MKTTOOL_RELAY_ARCHIVE=%snapshot_relay_archive%"');
  const handoffInvocation = wrapper.indexOf('"%validated_node%" "%original_relay_fetcher%"');
  const archiveClear = wrapper.indexOf('set "MKTTOOL_RELAY_ARCHIVE="', archiveSet + 1);
  const yarnInvocation = wrapper.indexOf('"%validated_node%" "%validated_yarn%" workspace @mktbrowser/desktop build:win');
  assert.match(wrapper, /set "token_fetcher=%~dp0fetch-pinned-relay-for-tokenized-package\.ps1"/i);
  assert.match(wrapper, /set "original_relay_fetcher=%package_root%\\apps\\desktop\\scripts\\fetch-pinned-relay\.cjs"/i);
  assert.match(wrapper, /set "MKT_BROWSER_RELAY_HANDOFF_PATH=%relay_handoff_path%"/i);
  assert.match(wrapper, /call :create_relay_handoff_path/i);
  assert.match(wrapper, /set "relay_handoff_path=%TEMP%\\mktbrowser-relay-archive-handoff-%relay_handoff_id%\.txt"/i);
  assert.match(wrapper, /:create_relay_handoff_path[\s\S]*set "MKTTOOL_RELEASE_TOKEN="[\s\S]*-Command "New-Guid"/i);
  assert.match(wrapper, /call :validate_toolchain_tokenless/i);
  assert.ok(fetcherInvocation >= 0, "wrapper must use the PowerShell-only Relay fetcher while the token exists");
  assert.ok(tokenClear > fetcherInvocation, "wrapper must clear the token after Relay staging");
  assert.ok(archiveSet > tokenClear, "wrapper must expose the snapshot archive only after clearing the token");
  assert.ok(handoffInvocation > archiveSet, "wrapper must rehash the snapshot archive into the original checkout");
  assert.ok(archiveClear > handoffInvocation, "wrapper must clear the archive handoff after original-cache staging");
  assert.ok(yarnInvocation > tokenClear, "wrapper must start Yarn only after token removal");
  assert.ok(yarnInvocation > archiveClear, "wrapper must start Yarn after clearing the archive handoff");
  const revalidationAt = wrapper.lastIndexOf("call :validate_toolchain", yarnInvocation);
  assert.ok(revalidationAt > tokenClear, "wrapper must revalidate Node.js, Corepack, and Yarn after token removal");
  assert.match(wrapper.slice(revalidationAt, yarnInvocation), /^call :validate_toolchain\r?\nif errorlevel 1 goto :validation_failed\r?\npushd "%package_root%"\r?\n/i);
  assert.match(wrapper, /call :verify_sha256 "%validated_yarn%" "%MKT_BROWSER_YARN_SHA256%" "Yarn entrypoint"/i);
  assert.match(wrapper, /:verify_yarn_version[\s\S]*MKT_BROWSER_VALIDATED_NODE[\s\S]*MKT_BROWSER_VALIDATED_YARN[\s\S]*--version/i);
  assert.doesNotMatch(
    wrapper,
    /^\s*set\s+"yarn_[^"]*=/im,
    "batch locals named YARN_* become Yarn configuration and block the real package command",
  );
  for (const name of unsafeEnvironmentNames) {
    assert.ok(
      wrapper.indexOf(`set "${name}="`) < fetcherInvocation,
      `wrapper starts the token fetcher before scrubbing ${name}`,
    );
  }
});

test("concurrent tokenized wrappers retain invocation-scoped Relay handoffs", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  const fixture = createWrapperFixture(t);
  writeConcurrentPowerShellObserver(fixture.tokenFetcherPath);

  const secondArchivePath = path.join(fixture.packageRoot, "second-snapshot-relay.zip");
  const secondPackageRoot = path.join(path.dirname(fixture.packageRoot), "original-browser-checkout-second");
  const secondRelayFetcher = path.join(secondPackageRoot, "apps", "desktop", "scripts", "fetch-pinned-relay.cjs");
  const firstMarkerPath = path.join(path.dirname(fixture.packageRoot), "first-handoff-ready.txt");
  const secondHandoffResultPath = path.join(path.dirname(fixture.packageRoot), "handoff-result-second.json");
  const secondYarnResultPath = path.join(path.dirname(fixture.packageRoot), "yarn-result-second.json");
  const secondDownloaderResultPath = path.join(path.dirname(fixture.packageRoot), "downloader-result-second.json");
  mkdirSync(path.dirname(secondRelayFetcher), { recursive: true });
  writeFileSync(secondArchivePath, "second verified snapshot Relay archive", "utf8");
  writeOriginalRelayStager(secondRelayFetcher, "MKT_BROWSER_HANDOFF_RESULT");

  const first = runWrapperAsync(fixture, {
    MKT_BROWSER_DOWNLOADER_AFTER_HANDOFF_MARKER: firstMarkerPath,
    MKT_BROWSER_DOWNLOADER_AFTER_HANDOFF_DELAY_MS: "1000",
  });
  const second = runWrapperAsync(fixture, {
    MKT_BROWSER_PACKAGE_ROOT: secondPackageRoot,
    MKT_BROWSER_SNAPSHOT_RELAY_ARCHIVE: secondArchivePath,
    MKT_BROWSER_DOWNLOADER_WAIT_FOR_MARKER: firstMarkerPath,
    MKT_BROWSER_DOWNLOADER_RESULT: secondDownloaderResultPath,
    MKT_BROWSER_HANDOFF_RESULT: secondHandoffResultPath,
    MKT_BROWSER_YARN_RESULT: secondYarnResultPath,
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.status, 0, firstResult.stderr || "first wrapper did not complete");
  assert.equal(secondResult.status, 0, secondResult.stderr || "second wrapper did not complete");
  const firstHandoff = JSON.parse(readFileSync(fixture.handoffResultPath, "utf8"));
  const secondHandoff = JSON.parse(readFileSync(secondHandoffResultPath, "utf8"));
  assert.equal(path.resolve(firstHandoff.archivePath), path.resolve(fixture.snapshotArchivePath));
  assert.equal(path.resolve(secondHandoff.archivePath), path.resolve(secondArchivePath));
  assert.equal(
    existsSync(path.join(path.dirname(fixture.fixtureWrapper), "relay-archive-handoff.txt")),
    false,
    "concurrent wrappers must not create a shared snapshot-side handoff receipt",
  );
});

test("the PowerShell-only Relay fetcher receives the token while receipt-bound Yarn is tokenless", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t);
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture);

  assert.equal(result.status, 0, result.stderr || "wrapper did not complete");
  const downloader = JSON.parse(readFileSync(fixture.downloaderResultPath, "utf8"));
  const handoff = JSON.parse(readFileSync(fixture.handoffResultPath, "utf8"));
  const yarn = JSON.parse(readFileSync(fixture.yarnResultPath, "utf8"));
  assert.equal(downloader.tokenPresent, true);
  assert.equal(downloader.tokenLength, token.length);
  assert.deepEqual(downloader.inheritedUnsafe, []);
  assert.equal(handoff.tokenPresent, false);
  assert.equal(handoff.archivePresent, true);
  assert.equal(path.resolve(handoff.archivePath), path.resolve(fixture.snapshotArchivePath));
  assert.notEqual(path.resolve(fixture.snapshotArchivePath), path.join(path.resolve(fixture.packageRoot), ".relay-payload"));
  assert.equal(yarn.tokenPresent, false);
  assert.equal(yarn.tokenLength, 0);
  assert.equal(yarn.relayArchivePresent, false);
  assert.deepEqual(yarn.inheritedUnsafe, []);
  assert.equal(path.resolve(yarn.workingDirectory), path.resolve(fixture.packageRoot));
  assert.deepEqual(yarn.args, ["workspace", "@mktbrowser/desktop", "build:win"]);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});

test("a caller-supplied Corepack path that is not derived from node.exe fails before the token fetcher", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t);
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture, {
    MKT_BROWSER_COREPACK22_ENTRYPOINT: fixture.wrongCorepackPath,
    MKT_BROWSER_COREPACK22_SHA256: sha256(fixture.wrongCorepackPath),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Corepack entrypoint does not match the one derived from the pinned Node\.js executable/i);
  assert.equal(existsSync(fixture.downloaderResultPath), false, "mismatched Corepack reached the token fetcher");
  assert.equal(existsSync(fixture.yarnResultPath), false, "mismatched Corepack started packaging");
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});

test("a mismatched derived Corepack hash fails before the token fetcher", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t);
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture, { MKT_BROWSER_COREPACK22_SHA256: "0".repeat(64) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned Corepack entrypoint did not match its expected SHA-256/i);
  assert.equal(existsSync(fixture.downloaderResultPath), false, "mismatched Corepack hash reached the token fetcher");
  assert.equal(existsSync(fixture.yarnResultPath), false, "mismatched Corepack hash started packaging");
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});

test("a mismatched Node.js hash fails before the token fetcher", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t);
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture, { MKT_BROWSER_NODE22_SHA256: "0".repeat(64) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned Node\.js executable did not match its expected SHA-256/i);
  assert.equal(existsSync(fixture.downloaderResultPath), false, "mismatched Node.js hash reached the token fetcher");
  assert.equal(existsSync(fixture.yarnResultPath), false, "mismatched Node.js hash started packaging");
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});

test("revalidates Corepack after the token-bearing fetch before packaging", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t, { mutate: "corepack" });
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture, { MKT_BROWSER_MUTATE_COREPACK: fixture.corepackPath });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned Corepack entrypoint did not match its expected SHA-256/i);
  const downloader = JSON.parse(readFileSync(fixture.downloaderResultPath, "utf8"));
  assert.equal(downloader.tokenPresent, true);
  assert.equal(existsSync(fixture.yarnResultPath), false, "changed Corepack reached packaging");
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});

test("revalidates receipt-bound Yarn after the token-bearing fetch before packaging", { skip: process.platform !== "win32" }, (t) => {
  const fixture = createWrapperFixture(t, { mutate: "yarn" });
  const token = "test-release-token-with-bang!";
  const result = runWrapper(fixture, { MKT_BROWSER_MUTATE_YARN: fixture.yarnPath });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned Yarn entrypoint did not match its expected SHA-256/i);
  const downloader = JSON.parse(readFileSync(fixture.downloaderResultPath, "utf8"));
  assert.equal(downloader.tokenPresent, true);
  assert.equal(existsSync(fixture.yarnResultPath), false, "changed Yarn reached packaging");
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, "wrapper printed the release token");
});
