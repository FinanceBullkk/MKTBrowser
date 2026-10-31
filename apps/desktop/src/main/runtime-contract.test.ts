import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MKT_BROWSER_BASE_CAPABILITIES,
  MKT_BROWSER_CAPABILITIES,
  MKT_BROWSER_CONTRACT_VERSION,
  MKT_BROWSER_ERROR_CODES,
  MKT_BROWSER_PROFILE_SCHEMA_VERSION,
} from "../../../../packages/types/src/index.ts";
import { describeEngineStatus } from "./engine-runtime-info.ts";
import { waitForCdpSessionReady } from "./cdpReadiness.ts";
import { resolveRuntimeCapabilities } from "../../../../packages/mcp-server/src/runtime-capabilities.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("publishes a versioned runtime contract", () => {
  assert.equal(MKT_BROWSER_CONTRACT_VERSION, 6);
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 3);
  assert.deepEqual(
    [...MKT_BROWSER_BASE_CAPABILITIES],
    [
      "profile-contract-v1",
      "runtime-info-v1",
      "install-readiness-v1",
      "idempotent-create-v1",
      "atomic-launch-v1",
      "managed-profile-v1",
      "operation-diagnostics-v1",
    ],
  );
  assert.deepEqual(
    [...MKT_BROWSER_CAPABILITIES],
    [
      "profile-contract-v1",
      "runtime-info-v1",
      "install-readiness-v1",
      "idempotent-create-v1",
      "atomic-launch-v1",
      "managed-profile-v1",
      "operation-diagnostics-v1",
      "local-install-ready-v1",
      "license-capacity-v1",
    ],
  );
});

test("keeps local-install readiness conditional and nonblocking at runtime", async () => {
  const server = source("packages/mcp-server/src/server.ts");
  const main = source("apps/desktop/src/main/index.ts");

  assert.match(server, /runtimeCapabilities/);
  assert.match(server, /localInstallReadiness/);
  assert.deepEqual(await resolveRuntimeCapabilities(), [...MKT_BROWSER_BASE_CAPABILITIES]);
  assert.deepEqual(
    await resolveRuntimeCapabilities(async () => [
      "license-capacity-v1",
      "license-capacity-v1",
    ]),
    [...MKT_BROWSER_BASE_CAPABILITIES, "license-capacity-v1"],
  );
  assert.deepEqual(
    await resolveRuntimeCapabilities(async () => {
      throw new Error("inspection failed");
    }),
    [...MKT_BROWSER_BASE_CAPABILITIES],
  );
  assert.match(server, /local-install-ready-v1/);
  assert.match(server, /readiness === "unavailable"/);
  assert.match(main, /localInstallInspector\?\.snapshot\(\)/);
  assert.doesNotMatch(main, /await localInstallInspector\.isReady\(\)/);
  assert.match(main, /WindowsLocalInstallInspector/);
  const companionCheck = main.slice(
    main.indexOf("async function checkRelayCompanion"),
    main.indexOf("const ADDITIONAL_LICENSE_KEYS_ENABLED"),
  );
  assert.equal(
    companionCheck.match(/localInstallInspector\?\.invalidate\(\);/g)?.length,
    2,
    "a Relay check must invalidate both the pre-check and post-check ownership snapshots",
  );
});

test("publishes measured license capacity without exposing lease or key identities", () => {
  assert.equal(MKT_BROWSER_CAPABILITIES.includes("license-capacity-v1"), true);
  const main = source("apps/desktop/src/main/index.ts");
  const server = source("packages/mcp-server/src/server.ts");
  const capacityModule = source("packages/mcp-server/src/runtime-license-capacity.ts");

  assert.match(main, /LicenseLeaseJournal\.open/);
  assert.match(main, /licenseSeatCoordinator\?\.snapshot\(\)/);
  assert.match(main, /licenseCapacity,/);
  assert.match(main, /refreshLicenseCapacity,/);
  assert.match(server, /name: "refresh_license_capacity"/);
  assert.match(server, /case "refresh_license_capacity"/);
  assert.doesNotMatch(
    main,
    /MktBrowserCapability\[\] = \["license-capacity-v1"\]/,
    "do not advertise complete lease capacity before driver lifecycle writes and startup recovery exist",
  );
  assert.match(server, /resolveRuntimeLicenseCapacity/);
  assert.doesNotMatch(capacityModule, /keyTail|keyFingerprint|profileId/);
});

test("waits for startup recovery before the first explicit capacity refresh", () => {
  const main = source("apps/desktop/src/main/index.ts");
  const refreshStart = main.indexOf("const refreshLicenseCapacity = async () =>");
  const refreshEnd = main.indexOf("browserDriver = new ChromiumBrowserDriver", refreshStart);
  const refresh = main.slice(refreshStart, refreshEnd);

  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "capacity refresh wiring is missing");
  assert.ok(
    refresh.indexOf("localInstallInspector?.invalidate();") <
      refresh.indexOf("licenseSeatCoordinator?.refresh()"),
    "an explicit Web retry must invalidate the install snapshot before it can observe capacity",
  );
  assert.ok(
    refresh.indexOf("await startupOrphanSweep") <
      refresh.indexOf("licenseSeatCoordinator?.refresh()"),
    "vendor capacity refresh must not race startup lease reconciliation",
  );
});

test("locks the canonical Windows app before opening shared licence state", () => {
  const main = source("apps/desktop/src/main/index.ts");
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  const journal = main.indexOf("LicenseLeaseJournal.open");

  assert.ok(lock >= 0, "normal Windows sessions must acquire Electron's process lock");
  assert.ok(journal > lock, "shared licence state must open only after the process lock is held");
  assert.match(main, /if \(normalWindowsSession && !app\.requestSingleInstanceLock\(\)\) app\.exit\(0\)/);
});

test("keeps every failing layer separately addressable", () => {
  for (const code of [
    "INVALID_INPUT",
    "FORBIDDEN",
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_RUNNING",
    "PROFILE_ALREADY_RUNNING",
    "PROXY_REJECTED",
    "ENGINE_UNAVAILABLE",
    "UNKNOWN_TOOL",
    "MANAGED_PROFILE_LOCKED",
    "PROFILE_DELETION_PENDING",
    "INTERNAL_ERROR",
  ]) {
    assert.equal((MKT_BROWSER_ERROR_CODES as readonly string[]).includes(code), true, code);
  }
});

test("reports an engine version only when one is actually installed", () => {
  assert.deepEqual(
    describeEngineStatus("cloakbrowser", {
      kind: "ready",
      version: "145.0.0.0",
      binaryPath: "C:/engine/chrome.exe",
    }),
    { kind: "cloakbrowser", version: "145.0.0.0", status: "ready" },
  );

  // A stage that knows its target version still reports it, so a caller can distinguish "preparing
  // the approved version" from "preparing something unexpected".
  assert.deepEqual(
    describeEngineStatus("cloakbrowser", {
      kind: "downloading",
      bytesReceived: 1,
      bytesTotal: 2,
      version: "151.0.7922.108.2",
      engine: "cloakbrowser",
      attempt: 1,
      maxAttempts: 5,
      resuming: false,
    }),
    { kind: "cloakbrowser", version: "151.0.7922.108.2", status: "downloading" },
  );

  for (const status of [
    { kind: "missing" } as const,
    { kind: "fetching-manifest" } as const,
    { kind: "error", engine: "cloakbrowser", message: "checksum mismatch" } as const,
    { kind: "dev-system", binaryPath: "C:/chrome.exe" } as const,
  ]) {
    const described = describeEngineStatus("cloakbrowser", status);
    assert.equal(described.version, null, status.kind);
    assert.equal(described.status, status.kind);
  }
});

test("exposes get_runtime_info and classifies failures by code, not by message", () => {
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /name: "get_runtime_info"/);
  assert.match(server, /case "get_runtime_info"/);
  // The dispatch catch must derive the code from the taxonomy; a hand-written ternary chain is how
  // an unclassified failure silently becomes INTERNAL_ERROR again.
  assert.match(server, /const code = toErrorCode\(e\)/);
  assert.match(server, /return err\(/);
  assert.equal(server.includes("throw new Error(`Profile"), false);
  assert.equal(server.includes("throw new Error(`Unknown tool"), false);

  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /throw engineUnavailable\(/);
  assert.match(driver, /throw proxyRejected\(/);
});

test("verifies proxy egress before starting the bridge or either engine launcher", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  const verifyIndex = driver.indexOf("await verifyProxyGeoLaunch");
  const bridgeIndex = driver.indexOf("await startBridgeForProfile");
  const sdkIndex = driver.indexOf("await launchCloakBrowserSdkLifecycle");
  const spawnIndex = driver.indexOf("child = spawn(chromiumPath");

  assert.ok(verifyIndex >= 0, "proxy egress preflight is missing");
  assert.ok(bridgeIndex > verifyIndex, "the proxy bridge starts before egress verification");
  assert.ok(sdkIndex > bridgeIndex, "the SDK engine starts before the proxy bridge is ready");
  assert.ok(spawnIndex > bridgeIndex, "the engine spawns before the proxy bridge is ready");
  assert.match(driver.slice(verifyIndex, bridgeIndex), /reject: proxyRejected/);
});

test("reports the installed release, not the MCP contract constant", () => {
  // These are two different numbers and they drift. MKT_BROWSER_MCP_SERVER_VERSION tracks the
  // wire contract and moved last at 0.3.1; the desktop release is on its own cadence. While
  // `get_runtime_info` returned the constant, a 0.3.6 install answered "0.3.1" to the one question
  // an operator asks after installing — did the new build actually land — and the answer looked
  // like a failed install every time.
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(server, /appVersion\?: string;/);
  assert.match(server, /appVersion: appVersion \?\? MKT_BROWSER_MCP_SERVER_VERSION,/);

  // The fallback only exists for standalone/mock runs. The desktop app has a real version and
  // must pass it at every construction site, or the constant silently becomes the answer again.
  const desktop = source("apps/desktop/src/main/index.ts");
  const sites = [...desktop.matchAll(/createMktBrowserMcpServer\(\{/g)];
  assert.ok(sites.length > 0, "no createMktBrowserMcpServer call found to check");
  for (const site of sites) {
    const optionsBlock = desktop.slice(site.index, site.index + 800);
    assert.match(
      optionsBlock,
      /appVersion: app\.getVersion\(\),/,
      `createMktBrowserMcpServer at offset ${site.index} does not pass appVersion: app.getVersion()`,
    );
  }
});

test("bounds a CDP readiness fetch that never settles", async () => {
  const budgetMs = 30;
  const startedAt = Date.now();

  await assert.rejects(
    waitForCdpSessionReady(9222, { connect: async () => {} }, budgetMs, {
      fetch: () => new Promise(() => {}),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    /within 30ms/,
  );

  assert.ok(Date.now() - startedAt < 500, "hung fetch escaped the readiness budget");
});

test("bounds a CDP connect that never settles", async () => {
  const budgetMs = 30;
  const startedAt = Date.now();

  await assert.rejects(
    waitForCdpSessionReady(9222, { connect: () => new Promise(() => {}) }, budgetMs, {
      fetch: async (url) => ({
        ok: true,
        json: async () => (url.endsWith("/json/list") ? [{ type: "page" }] : {}),
      }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    /within 30ms/,
  );

  assert.ok(Date.now() - startedAt < 500, "hung connect escaped the readiness budget");
});

test("records each successful CDP readiness stage separately", async () => {
  const timings = await waitForCdpSessionReady(9222, { connect: async () => {} }, 100, {
    fetch: async (url) => ({
      ok: true,
      json: async () => (url.endsWith("/json/list") ? [{ type: "page" }] : {}),
    }),
    sleep: async () => {},
  });

  assert.ok(timings.versionMs >= 0);
  assert.ok(timings.pageTargetMs >= 0);
  assert.ok(timings.attachMs >= 0);
  assert.equal(timings.totalMs, timings.versionMs + timings.pageTargetMs + timings.attachMs);
});

test("lets Chromium assign the DevTools port instead of consuming fixed ports", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  const desktop = source("apps/desktop/src/main/index.ts");
  const processDiscovery = source("apps/desktop/src/main/browser-process-discovery.ts");
  const processWorker = source("apps/desktop/src/main/windows-process-query-worker.ts");

  assert.doesNotMatch(driver, /nextPort\s*=\s*9222/);
  assert.doesNotMatch(driver, /allocatePort\(\)/);
  assert.match(driver, /--remote-debugging-port=0/);
  assert.match(driver, /waitForOwnedDevToolsEndpoint/);
  assert.match(driver, /await this\.startupBarrier/);
  assert.match(driver, /prelaunchProcesses\.processes\.length > 0/);
  assert.match(desktop, /startupBarrier: startupOrphanSweep/);
  assert.match(driver, /MKT_BROWSER_PACKAGED_CONTRACT_VERIFY === "1" \? 60_000 : 15_000/);
  assert.match(
    driver,
    /discoveryBudgetMs = readinessBudgetMs - \(Date\.now\(\) - readinessStartedAtMs\)/,
  );
  assert.match(processDiscovery, /System32.*netstat\.exe/);
  assert.match(processDiscovery, /System32.*WindowsPowerShell.*powershell\.exe/);
  assert.match(processDiscovery, /Get-CimInstance -Query \$query -ErrorAction Stop/);
  assert.match(processWorker, /Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]/);
  assert.match(processWorker, /Buffer\.byteLength\(this\.output, "utf8"\) > MAX_OUTPUT_BYTES/);
  assert.match(processWorker, /MAX_OUTPUT_BYTES = 1_048_576/);
  assert.doesNotMatch(processDiscovery, /Get-NetTCPConnection/);
  assert.doesNotMatch(processDiscovery, /LocalAddress -in @\('127\.0\.0\.1','0\.0\.0\.0'\)/);
});

test("keeps browser ownership until failed launches and shutdown sweeps finish", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");

  assert.match(driver, /launchingProcesses = new Map<ProfileId, LaunchingProcess>/);
  assert.match(
    driver,
    /await this\.cleanupFailedLaunch\([\s\S]*?profileId,[\s\S]*?error,[\s\S]*?seatRefused \? false : undefined,[\s\S]*?leaseReserved,[\s\S]*?\)/,
  );
  assert.match(driver, /pending\.childExit = \{ exitCode: code, signal \}/);
  assert.match(driver, /writeProfileLifecycleLog\(profileId, pending, "CHILD-EXIT", childExit\)/);
  assert.match(driver, /await terminateBrowserProcess\(profileId, pending\)/);
  // Ownership is dropped only once termination reports success, whatever shape that check takes.
  assert.match(driver, /if \(!outcome\.terminated\) \{/);
  assert.match(driver, /survived failed-launch cleanup/);
  assert.match(driver, /record\.windowWatcher\.stop\(\)/);
  assert.match(driver, /await terminateBrowserProcess\(profileId, record\)/);
  assert.match(driver, /this\.running\.delete\(profileId\)/);
  assert.match(driver, /const traceTarget = tracingInitialBootstrap/);

  // Bậc thang tắt tiến trình rời sang module riêng ngày 18/09/2026. Cùng những điều kiện đó, đọc
  // ở chỗ chúng đang nằm - chứ không phải bỏ đi vì file cũ không còn chứa chúng.
  const shutdown = source("apps/desktop/src/main/browser-shutdown-sequence.ts");
  assert.match(shutdown, /shutdownSource: "data-dir-sweep"/);
  assert.match(shutdown, /"SHUTDOWN-COMPLETE" : "SHUTDOWN-FAILED"/);
  assert.match(shutdown, /effectiveShutdownMethod = forcedBrowserTermination \? "SIGKILL"/);
});

test("serializes window watcher polls and requires process death for CDP-unreachable close", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");

  assert.doesNotMatch(driver, /setInterval\(async/);
  // Chỗ dựng bộ theo dõi vẫn ở driver; thân vòng lặp rời sang module riêng ngày 18/09/2026.
  assert.match(driver, /\(\) => isPidAlive\(record\.pid\)/);

  const watcher = source("apps/desktop/src/main/browser-window-watcher.ts");
  assert.doesNotMatch(watcher, /setInterval\(async/);
  assert.match(watcher, /timer = setTimeout\(\(\) => void poll\(\), 1000\)/);
  assert.match(watcher, /const fetchTimeout = setTimeout\(\(\) => controller\.abort\(\), 1000\)/);
  assert.match(watcher, /A failed poll cannot prove the page count stayed at zero/);
  assert.match(watcher, /Date\.now\(\) - unreachableSinceMs > 1500 && !isProcessAlive\(\)/);
});

test("reports a licence refusal as a refusal, not as a crash", () => {
  // CloakBrowser opens its DevTools port before the licence verdict lands, so a seat refusal
  // reaches the launch path as a process that started, passed readiness, and then vanished. Left
  // as `Chromium exited during launch with code 76` it reads as an engine crash and sends whoever
  // sees it hunting for one. The mapped text names the session limit and what to do about it.
  // The verdict is classified in licence-verdict.ts, which has behavioural tests of its own, and
  // wrapped here because engineUnavailable lives in the MCP package.
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /classifyLaunchExit\(exitCode, stage\)/);
  assert.match(driver, /const refusal = engineUnavailable\(licenceReason\);/);
  // Tagged with the exit code so key rotation can tell a seat refusal from a real failure
  // without matching on operator-facing wording that is meant to be rewritten.
  assert.match(driver, /licenseExitCode\?: number \}\)\.licenseExitCode = exitCode/);

  // Every during-launch exit is classified, and the licence verdict is waited for before a launch
  // is called a success. Sampling `childExit` once, while the engine was still alive, is exactly
  // how a refused key came back as a running profile with a pid and an endpoint.
  assert.doesNotMatch(driver, /throw new Error\(\s*`Chromium exited during/);
  assert.match(driver, /await settleLicenceVerdict\(launchProcess, child, spawnedAtMs\)/);
  assert.match(driver, /await sdkLifecycle\.settleLicenceVerdict\(spawnedAtMs\)/);

  // The mapping is only useful if it still covers the codes the engine actually exits with.
  const channel = source("apps/desktop/src/main/cloakbrowser-pro-channel.ts");
  for (const code of ["76", "77", "78", "79"]) {
    assert.match(channel, new RegExp(`\n  ${code}:`), `licence exit ${code} has no message`);
  }
});

test("uses the SDK only for enabled Windows Cloak and retains fallback orphan recovery", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  const policy = source("apps/desktop/src/main/license-lifecycle-policy.ts");
  assert.match(driver, /shouldUseCloakBrowserSdkLifecycle\(this\.fastLicenseReuse\)/);
  assert.match(driver, /detached: shouldDetachBrowserProcess\(this\.fastLicenseReuse\)/);
  assert.match(policy, /fastReuseEnabled && platform === "win32"/);

  // Detached fallback modes still depend on the orphan sweep for conservative recovery.
  const index = source("apps/desktop/src/main/index.ts");
  assert.match(index, /sweepOrphanedProfileBrowsers\(/);
  assert.match(index, /reconcileStartupOrphanLeases\(/);
  assert.match(index, /startupBarrier: startupOrphanSweep/);
});

test("ships the exact SDK runtime dependencies in packaged builds", () => {
  const builder = source("apps/desktop/electron-builder.yml");
  assert.match(builder, /cloakbrowser: "0\.5\.10"/);
  assert.match(builder, /playwright-core: "1\.62\.0"/);
});

test("successful archive import reports that restored extensions are disabled", () => {
  const app = source("apps/desktop/src/renderer/src/App.tsx");
  const main = source("apps/desktop/src/main/index.ts");
  const preload = source("apps/desktop/src/preload/create-mkt-browser-api.ts");

  assert.match(main, /const disabledExtensions = restored\.extensions\?\.length \?\? 0/);
  assert.match(preload, /disabledExtensions: number/);
  assert.match(app, /result\.disabledExtensions/);
  assert.match(app, /archived extension/);
  assert.match(app, /review and re-enable only the ones you trust/);
  assert.match(main, /await reclaimStaleArchiveStaging\(dataRoot\)/);
  assert.ok(
    main.indexOf("await reclaimStaleArchiveStaging(dataRoot)") <
      main.indexOf("profileManager = new ProfileManager"),
    "stale decrypted staging must be reclaimed before the profile store opens",
  );
});

function source(relativePath: string): string {
  // Line endings are normalized because Windows CI checks these files out with CRLF while a Linux
  // checkout keeps LF. Without this, an assertion written with "\n" passes locally and fails on the
  // runner, and — worse — a *negative* assertion written with "\n" passes everywhere for the wrong
  // reason: the string it looks for can never appear, so it proves nothing. That happened here on
  // 23 August, and the vacuous pass is the half that would have survived unnoticed.
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8").replace(/\r\n/g, "\n");
}
