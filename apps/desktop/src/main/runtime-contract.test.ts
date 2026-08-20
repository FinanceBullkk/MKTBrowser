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
  assert.equal(MKT_BROWSER_CONTRACT_VERSION, 4);
  assert.equal(MKT_BROWSER_PROFILE_SCHEMA_VERSION, 3);
  assert.deepEqual(
    [...MKT_BROWSER_BASE_CAPABILITIES],
    [
      "profile-contract-v1",
      "runtime-info-v1",
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
      "idempotent-create-v1",
      "atomic-launch-v1",
      "managed-profile-v1",
      "operation-diagnostics-v1",
      "local-install-ready-v1",
    ],
  );
});

test("keeps the local-install capability conditional at runtime", async () => {
  const server = source("packages/mcp-server/src/server.ts");
  const main = source("apps/desktop/src/main/index.ts");

  assert.match(server, /runtimeCapabilities/);
  assert.deepEqual(await resolveRuntimeCapabilities(), [...MKT_BROWSER_BASE_CAPABILITIES]);
  assert.deepEqual(
    await resolveRuntimeCapabilities(async () => [
      "local-install-ready-v1",
      "local-install-ready-v1",
    ]),
    [...MKT_BROWSER_BASE_CAPABILITIES, "local-install-ready-v1"],
  );
  assert.deepEqual(
    await resolveRuntimeCapabilities(async () => {
      throw new Error("inspection failed");
    }),
    [...MKT_BROWSER_BASE_CAPABILITIES],
  );
  assert.match(main, /local-install-ready-v1/);
  assert.match(main, /WindowsLocalInstallInspector/);
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
    describeEngineStatus("cft", {
      kind: "downloading",
      bytesReceived: 1,
      bytesTotal: 2,
      version: "148.0.0.0",
      engine: "cft",
      attempt: 1,
      maxAttempts: 5,
      resuming: false,
    }),
    { kind: "cft", version: "148.0.0.0", status: "downloading" },
  );

  for (const status of [
    { kind: "missing" } as const,
    { kind: "fetching-manifest" } as const,
    { kind: "error", engine: "cft", message: "checksum mismatch" } as const,
    { kind: "dev-system", binaryPath: "C:/chrome.exe" } as const,
  ]) {
    const described = describeEngineStatus("cft", status);
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

test("keeps browser ownership until failed launches and shutdown sweeps finish", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");

  assert.match(driver, /launchingProcesses = new Map<ProfileId, LaunchingProcess>/);
  assert.match(driver, /await this\.cleanupFailedLaunch\(profileId, error\)/);
  assert.match(driver, /pending\.childExit = \{ exitCode: code, signal \}/);
  assert.match(driver, /writeProfileLifecycleLog\(profileId, pending, "CHILD-EXIT", childExit\)/);
  assert.match(driver, /if \(await terminateBrowserProcess\(profileId, pending\)\)/);
  assert.match(driver, /record\.windowWatcher\.stop\(\)/);
  assert.match(driver, /await terminateBrowserProcess\(profileId, record\)/);
  assert.match(driver, /this\.running\.delete\(profileId\)/);
  assert.match(driver, /shutdownSource: "data-dir-sweep"/);
  assert.match(driver, /"SHUTDOWN-COMPLETE" : "SHUTDOWN-FAILED"/);
  assert.match(driver, /const traceTarget = tracingInitialBootstrap/);
});

test("serializes window watcher polls and requires process death for CDP-unreachable close", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");

  assert.doesNotMatch(driver, /setInterval\(async/);
  assert.match(driver, /timer = setTimeout\(\(\) => void poll\(\), 1000\)/);
  assert.match(driver, /const fetchTimeout = setTimeout\(\(\) => controller\.abort\(\), 1000\)/);
  assert.match(driver, /A failed poll cannot prove the page count stayed at zero/);
  assert.match(driver, /\(\) => isPidAlive\(record\.pid\)/);
  assert.match(driver, /Date\.now\(\) - unreachableSinceMs > 1500 && !isProcessAlive\(\)/);
});

test("reports a licence refusal as a refusal, not as a crash", () => {
  // CloakBrowser opens its DevTools port before the licence verdict lands, so a seat refusal
  // reaches the launch path as a process that started, passed readiness, and then vanished. Left
  // as `Chromium exited during launch with code 76` it reads as an engine crash and sends whoever
  // sees it hunting for one. The mapped text names the session limit and what to do about it.
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /const licenseReason = licenseExitMessage\(exitCode\);/);
  assert.match(driver, /if \(licenseReason\) throw engineUnavailable\(licenseReason\);/);

  // The mapping is only useful if it still covers the codes the engine actually exits with.
  const channel = source("apps/desktop/src/main/cloakbrowser-pro-channel.ts");
  for (const code of ["76", "77", "78", "79"]) {
    assert.match(channel, new RegExp(`\n  ${code}:`), `licence exit ${code} has no message`);
  }
});

test("spawns the engine detached so a crashed app leaves a reclaimable browser", () => {
  // detached:false puts the browser in the app's Windows job object, so force-killing the app
  // kills the browser the one way that keeps its licence seat, and leaves nothing behind that
  // could be asked to release it. Detached, the startup sweep can still close it politely - or
  // the operator can close the window, which does the same thing.
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.match(driver, /detached: true,/);
  assert.equal(driver.includes("detached: false"), false);

  // The sweep is the other half: without it a detached browser is just a stray window.
  const index = source("apps/desktop/src/main/index.ts");
  assert.match(index, /sweepOrphanedProfileBrowsers\(/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
