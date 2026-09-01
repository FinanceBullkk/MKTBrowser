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
      "license-capacity-v1",
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

test("publishes measured license capacity without exposing lease or key identities", () => {
  assert.equal(MKT_BROWSER_CAPABILITIES.includes("license-capacity-v1"), true);
  const main = source("apps/desktop/src/main/index.ts");
  const server = source("packages/mcp-server/src/server.ts");
  const capacityModule = source("packages/mcp-server/src/runtime-license-capacity.ts");

  assert.match(main, /LicenseLeaseJournal\.open/);
  assert.match(main, /capacitySnapshot\(licenseLeaseJournal\.snapshot\(\)\)/);
  assert.match(main, /licenseCapacity,/);
  assert.doesNotMatch(
    main,
    /MktBrowserCapability\[\] = \["license-capacity-v1"\]/,
    "do not advertise complete lease capacity before driver lifecycle writes and startup recovery exist",
  );
  assert.match(server, /resolveRuntimeLicenseCapacity/);
  assert.doesNotMatch(capacityModule, /keyTail|keyFingerprint|profileId/);
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

test("verifies proxy egress before starting the bridge or spawning the engine", () => {
  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  const verifyIndex = driver.indexOf("await verifyProxyGeoLaunch");
  const bridgeIndex = driver.indexOf("await startBridgeForProfile");
  const spawnIndex = driver.indexOf("const child = spawn(chromiumPath");

  assert.ok(verifyIndex >= 0, "proxy egress preflight is missing");
  assert.ok(bridgeIndex > verifyIndex, "the proxy bridge starts before egress verification");
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
  assert.match(processDiscovery, /Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]/);
  assert.match(processDiscovery, /maxBuffer: MAX_WINDOWS_PROCESS_OUTPUT_BYTES/);
  assert.doesNotMatch(processDiscovery, /Get-NetTCPConnection/);
  assert.doesNotMatch(processDiscovery, /LocalAddress -in @\('127\.0\.0\.1','0\.0\.0\.0'\)/);
});

test("builds one hashed package and verifies that artifact in a fresh CI job", () => {
  const workflow = source(".github/workflows/windows-pipeline.yml");

  assert.match(workflow, /quality:/);
  assert.match(workflow, /package:\s*\n\s+needs: quality/);
  assert.match(workflow, /packaged-contract:\s*\n\s+needs: package/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /Get-FileHash[^\n]+SHA256/);
  assert.match(workflow, /verify-packaged-runtime-contract\.cjs --repeat/);

  // Repeated stability runs are dispatched by hand, so the iteration count is an input. It must
  // reach the verifier through the environment; interpolating it into the command line would let
  // a dispatch input become shell syntax on the runner.
  assert.match(workflow, /MKT_CONTRACT_ITERATIONS: \$\{\{.*inputs\.contract_iterations/);
  assert.match(workflow, /--repeat "\$env:MKT_CONTRACT_ITERATIONS"/);

  // A stability streak is a claim about one engine, and the verifier links whichever Chrome the
  // runner image ships. The declared version travels with the dispatch so drift fails the run.
  assert.ok(
    workflow.includes("MKT_BROWSER_EXPECTED_ENGINE_VERSION: ${{ inputs.expected_engine_version }}"),
    "the stability dispatch must declare the engine version it expects",
  );
});

test("prepares a pinned verifier engine on Windows jobs", () => {
  const workflow = source(".github/workflows/windows-pipeline.yml");
  const release = source(".github/workflows/release-candidate.yml");
  const fixture = source("scripts/system-chrome-engine-fixture.cjs");
  const preparation = source(".github/scripts/prepare-windows-packaged-verifier.ps1");

  assert.match(
    workflow,
    /Prepare pinned packaged verifier engine[\s\S]+prepare-windows-packaged-verifier\.ps1/,
  );
  assert.match(preparation, /chromeVersion = "152\.0\.7977\.64"/);
  assert.match(
    preparation,
    /chromeSha256 = "b0db25dea445822429d8ebd36d53344cadcd63127308759456964029bbe18004"/,
  );
  assert.match(
    preparation,
    /chromeExecutableSha256 = "79832d1e60cbad9323c07339f9608bc0ce93cb9242b9b5481c04a0c536720980"/,
  );
  assert.ok(
    preparation.indexOf("Get-FileHash") < preparation.indexOf("Expand-Archive"),
    "the verifier must authenticate the archive before extraction",
  );
  assert.match(
    preparation,
    /extracted = Join-Path \$env:RUNNER_TEMP [^\n]+[\s\S]+Remove-Item[^\n]+\$extracted[\s\S]+Expand-Archive/,
  );
  assert.match(preparation, /MKT_BROWSER_SYSTEM_CHROME=\$executable/);
  assert.match(fixture, /process\.env\.MKT_BROWSER_SYSTEM_CHROME/);
  assert.ok(
    release.indexOf("Prepare pinned packaged verifier engine") <
      release.indexOf("Verify the runtime contract against the installed application"),
    "the installed-contract job must prepare its engine before running the verifier",
  );
});

test("exposes one required merge gate that a push cannot satisfy and a skip cannot fake", () => {
  const gate = source(".github/workflows/pr-release-gate.yml");
  const push = source(".github/workflows/release.yml");
  const pipeline = source(".github/workflows/windows-pipeline.yml");

  assert.ok(
    gate.includes("mktbrowser-pr-release-gate:"),
    "the required status check must exist under a stable name",
  );
  assert.ok(gate.includes("  pull_request:"), "the gate workflow triggers on pull_request");

  // Measured on 22 August, after the first attempt at this gate shipped. An `if:` condition stops a
  // job from running but not from publishing a check run under its name, and GitHub counts a
  // skipped required check as satisfied. The push workflow therefore reported
  // `mktbrowser-pr-release-gate: skipped` on the same head commit as the real result, which would
  // have let a failing pipeline merge. The name must not exist outside the pull-request workflow.
  assert.ok(
    !push.includes("mktbrowser-pr-release-gate"),
    "the push workflow must never publish a check under the required name, not even skipped",
  );
  assert.ok(
    !pipeline.includes("mktbrowser-pr-release-gate"),
    "the reusable pipeline must not publish a check under the required name",
  );
  assert.ok(
    !push.includes("pull_request"),
    "the push workflow must not run on pull_request, or it would republish pipeline check names",
  );

  // The gate must run even when the pipeline fails, and must inspect the result rather than merely
  // depending on it. A gate skipped alongside a failing pipeline reports satisfied.
  assert.ok(gate.includes("if: always()"), "the gate must run even when the pipeline fails");
  assert.ok(gate.includes("needs: [windows]"));
  assert.ok(gate.includes("PIPELINE: ${{ needs.windows.result }}"));
  assert.ok(
    gate.includes('if [ "$PIPELINE" != "success" ]; then'),
    "the gate must fail unless the pipeline reported success",
  );

  // The coverage floor only exists if the required pipeline runs it. A contract that lives in a
  // script nobody invokes is the same shape of mistake as a check that never ran on the artifact.
  assert.ok(
    pipeline.includes("run: yarn test:critical-coverage"),
    "the required pipeline must run the critical coverage contract",
  );

  // Phase 4 builds exactly one installer, from a frozen tree, in one place. With an unsigned release
  // two installers are indistinguishable by inspection, so a second way to produce one is not a
  // convenience but a way to lose track of which file is the release.
  const surfaces: Array<{ name: string; contents: string }> = [
    { name: "the reusable pipeline", contents: pipeline },
    { name: "the push workflow", contents: push },
    { name: "the gate workflow", contents: gate },
  ];
  for (const surface of surfaces) {
    assert.ok(
      !surface.contents.includes("build:win"),
      `${surface.name} must not build an installer`,
    );
  }
});

test("builds the release candidate once, from a named commit, and never rebuilds it", () => {
  const candidate = source(".github/workflows/release-candidate.yml");

  // Manual only. A release that can start from a push starts from whatever the branch happened to
  // be, and the artifact does not record which that was.
  assert.ok(candidate.includes("on:\n  workflow_dispatch:"));
  assert.ok(!candidate.includes("\n  push:"));
  assert.ok(!candidate.includes("\n  pull_request:"));

  // The operator names the commit being frozen and the run refuses a different one.
  assert.ok(candidate.includes("confirm_commit:"));
  assert.ok(candidate.includes('case "$GITHUB_SHA" in'));

  // Two builds of one tree, compared on the payload rather than on the compressed installer.
  assert.ok(candidate.includes("attempt: [a, b]"));
  assert.ok(candidate.includes("normalized-payload-manifest.cjs --compare"));

  // Only build A's installer is kept, and attestation consumes that uploaded file rather than
  // building again. A rebuild between verification and attestation attests a different file.
  assert.ok(candidate.includes("if: matrix.attempt == 'a'"));
  assert.ok(candidate.includes("name: Download the verified candidate installer"));
  assert.ok(candidate.includes("emit-release-provenance.cjs"));
  const attestSection = candidate.slice(candidate.indexOf("  attest:"));
  assert.ok(!attestSection.includes("build:win"), "attestation must not rebuild the installer");

  // Provenance refuses to attest a dirty working tree, so nothing may be unpacked into the
  // checkout. On 23 August the artifacts were downloaded into it, git reported untracked files, and
  // the guard rejected a build that was in fact attestable. The guard was right; the download path
  // was wrong, and a false alarm from a correct rule still teaches people to route around it.
  // Only download destinations matter here. Upload steps name paths inside the checkout by
  // definition, since that is where the build wrote them.
  const downloadSections = candidate.split("uses: actions/download-artifact@").slice(1);
  assert.ok(downloadSections.length >= 2, "the attest and compare jobs both download artifacts");
  for (const section of downloadSections) {
    const destination = section.match(/^\s+path: (\S.*)$/m)?.[1];
    assert.ok(destination, "every artifact download must name where it lands");
    assert.ok(
      destination.startsWith("${{ runner.temp }}"),
      `artifact downloads must land outside the checkout, found ${destination}`,
    );
  }
});

test("disables the setup-node package-manager cache in every workflow that uses it", () => {
  // The action probes for a cache using its bundled Yarn 1, which refuses to run against a project
  // pinned to yarn@4.5.0 through `packageManager`. On 23 August this took down the comparison and
  // attestation jobs of the first real release-candidate run, before either had done any work, and
  // the run read as a reproducibility failure when nothing had been compared at all.
  for (const workflow of [
    ".github/workflows/windows-pipeline.yml",
    ".github/workflows/release-candidate.yml",
    ".github/workflows/release.yml",
    ".github/workflows/pr-release-gate.yml",
  ]) {
    const contents = source(workflow);
    const setupSteps = contents.split("uses: actions/setup-node@").length - 1;
    const disabled = contents.split("package-manager-cache: false").length - 1;
    assert.equal(
      disabled,
      setupSteps,
      `${workflow} has ${setupSteps} setup-node step(s) but disables the cache ${disabled} time(s)`,
    );
  }
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
  assert.match(driver, /shutdownSource: "data-dir-sweep"/);
  assert.match(driver, /"SHUTDOWN-COMPLETE" : "SHUTDOWN-FAILED"/);
  assert.match(driver, /effectiveShutdownMethod = forcedBrowserTermination \? "SIGKILL"/);
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
  assert.match(index, /reconcileStartupOrphanLeases\(/);
  assert.match(index, /startupBarrier: startupOrphanSweep/);
});

test("routes every GitHub Actions job through a GitHub-hosted runner", () => {
  // The pipeline left the self-hosted `mktbrowser` pool on 1 September 2026. A hosted runner hands
  // every job a fresh VM that is discarded afterwards, which is what the clean-machine gates
  // actually need, and it removes the persistent-runner failure that skipped the package jobs when
  // a PowerShell shell lost the action-managed PATH.
  //
  // This reads runner routing rather than whole-file text: `self-hosted` still appears in
  // windows-pipeline.yml as a fallback image label, and that is not a routing target.
  const workflowPaths = [
    ".github/workflows/pr-release-gate.yml",
    ".github/workflows/release-candidate.yml",
    ".github/workflows/release.yml",
    ".github/workflows/windows-pipeline.yml",
  ];
  let runsOnCount = 0;

  for (const workflowPath of workflowPaths) {
    const workflow = source(workflowPath);

    for (const match of workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)) {
      runsOnCount += 1;
      assert.match(
        match[1]!.trim(),
        /^(?:ubuntu|windows)-latest$/,
        `${workflowPath} routes a job somewhere other than a GitHub-hosted runner`,
      );
    }
  }

  assert.equal(runsOnCount, 9);
  const windowsPipeline = source(".github/workflows/windows-pipeline.yml");
  assert.equal(windowsPipeline.match(/runs-on: windows-latest/g)?.length, 3);
});

test("does not send fork pull requests to jobs that carry repository secrets", () => {
  const gate = source(".github/workflows/pr-release-gate.yml");
  const push = source(".github/workflows/release.yml");

  assert.match(
    gate,
    /windows:[\s\S]+if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]+uses: \.\/\.github\/workflows\/windows-pipeline\.yml/,
  );
  assert.equal(gate.includes("secrets: inherit"), false);
  assert.equal(push.includes("secrets: inherit"), false);
});

function source(relativePath: string): string {
  // Line endings are normalized because Windows CI checks these files out with CRLF while a Linux
  // checkout keeps LF. Without this, an assertion written with "\n" passes locally and fails on the
  // runner, and — worse — a *negative* assertion written with "\n" passes everywhere for the wrong
  // reason: the string it looks for can never appear, so it proves nothing. That happened here on
  // 23 August, and the vacuous pass is the half that would have survived unnoticed.
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8").replace(/\r\n/g, "\n");
}
