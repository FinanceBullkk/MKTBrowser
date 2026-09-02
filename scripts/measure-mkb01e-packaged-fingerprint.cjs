#!/usr/bin/env node

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { mkdtemp } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { analyzeMeasurement, SURFACE_NAMES } = require("./fingerprint-measurement-analysis.cjs");
const {
  inspectExecutable,
  measureStockChrome,
  startProbeServer,
} = require("./fingerprint-measurement-cdp.cjs");
const {
  assertTemporaryPath,
  persist,
  preparedRecording,
  removeTemporaryTree,
  summarizeCoverage,
  summarizeLifecycle,
} = require("./fingerprint-measurement-evidence.cjs");
const { seedVerifiedStableEngineCache } = require("./fingerprint-engine-cache-fixture.cjs");
const {
  assertMeasurement,
  assertSeatFree,
  launchMktBrowser,
  measureCloakProfile,
  recoverProfilesAndSeat,
  waitForReadyRuntime,
} = require("./fingerprint-measurement-mcp.cjs");
const { buildProbeAssets } = require("./fingerprint-probe-source.cjs");
const { selectProfileFingerprint } = require("./fingerprint-profile-cohort-config.cjs");
const { locateSystemChrome } = require("./system-chrome-engine-fixture.cjs");

const PROFILE_COUNT = 5;
const RUN_COUNT = 2;
const EXPECTED_ENGINE_VERSION = "151.0.7922.108.2";
const EXPECTED_ENGINE_ARCHIVE_SHA256 =
  "7b16ae3070bfcbed9cd381d03d1a8d57a8baf8f4540650397d620eb8dbe89561";
const args = parseArgs(process.argv.slice(2));

async function main() {
  if (process.platform !== "win32") throw new Error("Fingerprint measurement requires Windows.");
  if (!args.output) throw new Error("Pass --output <raw-json-path>.");
  const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (!licenseKey) {
    throw new Error("CLOAKBROWSER_LICENSE_KEY is required and is never written to output.");
  }

  const executable = path.resolve("apps/desktop/release/win-unpacked/MKTBrowser.exe");
  assert.ok(existsSync(executable), "Build the Windows directory package before measurement.");
  const rawOutput = assertTemporaryPath(args.output);
  const redactedOutput = path.resolve(args["redacted-output"] ?? `${args.output}.redacted.json`);
  const userData = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-phase02-fingerprint-"));
  const probeServer = await startProbeServer(buildProbeAssets());
  const probeUrl = `${probeServer.origin}/probe.html`;
  const recording = preparedRecording({
    label: args.label ?? "phase-02-cloak-baseline",
    profileCount: PROFILE_COUNT,
    runCount: RUN_COUNT,
    surfaceNames: SURFACE_NAMES,
  });
  await persist(rawOutput, recording);

  let app;
  let failure = null;
  const cleanupErrors = [];
  let preserveAppForSeatRecovery = false;
  try {
    const stock = await measureStockChrome({
      chromeExecutable: args.chrome ? path.resolve(args.chrome) : locateSystemChrome(),
      probeUrl,
    });
    assertMeasurement(stock.measurement, "stock Chrome");
    recording.stock = stock;
    await persist(rawOutput, recording);

    const engineCache = await seedVerifiedStableEngineCache({
      userData,
      expectedVersion: EXPECTED_ENGINE_VERSION,
      expectedArchiveSha256: EXPECTED_ENGINE_ARCHIVE_SHA256,
    });
    app = await launchMktBrowser({ executable, userData, licenseKey });
    const runtime = await waitForReadyRuntime(app, 20 * 60_000);
    assert.equal(runtime.engine.kind, "cloakbrowser", "The app did not select CloakBrowser.");
    assert.equal(
      runtime.engine.version,
      EXPECTED_ENGINE_VERSION,
      "The Stable .2 pin is not active.",
    );
    await assertSeatFree(app, "initial preflight");

    const options = await app.callTool("list_fingerprint_options", {});
    const fingerprint = selectProfileFingerprint(stock.measurement, options);
    await createProfiles(app, recording, fingerprint);
    recording.preflight = {
      preparedBeforeFirstProfileLaunch: true,
      runtime,
      engineCache,
      packagedExecutable: await inspectExecutable(executable),
      configuredFromStockControl: true,
    };
    await persist(rawOutput, recording);

    for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
      for (const row of recording.profiles) {
        await assertSeatFree(app, `${row.label} run ${runIndex + 1} preflight`);
        row.runs[runIndex] = await measureCloakProfile(app, row.id, probeUrl);
        await persist(rawOutput, recording);
      }
    }

    const profiles = recording.profiles.map(({ label, runs }) => ({ label, runs }));
    const analysis = analyzeMeasurement({ profiles, stock: stock.measurement });
    const lifecycle = await summarizeLifecycle(
      userData,
      recording.profiles.map((row) => row.id),
      PROFILE_COUNT * RUN_COUNT,
    );
    assert.equal(
      lifecycle.completedCloses,
      lifecycle.expectedCloses,
      "A profile close is missing.",
    );
    assert.equal(
      lifecycle.browserClose,
      lifecycle.expectedCloses,
      "A profile missed Browser.close.",
    );
    assert.equal(lifecycle.signalEscalations, 0, "A profile close escalated to a signal.");
    await persist(redactedOutput, {
      schemaVersion: 1,
      label: recording.label,
      measuredAt: new Date().toISOString(),
      engine: {
        appVersion: runtime.appVersion,
        kind: runtime.engine.kind,
        version: runtime.engine.version,
        archiveSha256: engineCache.archiveSha256,
        runtimeSha256: engineCache.runtimeSha256,
        executableSha256: recording.preflight.packagedExecutable.sha256,
      },
      stock: { version: stock.executable.version, sha256: stock.executable.sha256 },
      pool: { profiles: PROFILE_COUNT, runsPerProfile: RUN_COUNT, oneAtATime: true },
      profileLabels: profiles.map((profile) => profile.label),
      coverage: summarizeCoverage(profiles, stock.measurement, SURFACE_NAMES),
      lifecycle,
      analysis,
      evidenceNote:
        "Aliases preserve equality and difference relationships without retaining host-identifying fingerprint values.",
    });
    process.stdout.write(`Raw fingerprint evidence written to ${rawOutput}\n`);
    process.stdout.write(`Redacted comparison evidence written to ${redactedOutput}\n`);
  } catch (error) {
    failure = error;
    preserveAppForSeatRecovery = app
      ? !(await recoverProfilesAndSeat(app, recording.profiles))
      : false;
  } finally {
    let appStopped = true;
    if (app && !preserveAppForSeatRecovery) {
      await app.stop().catch((error) => {
        appStopped = false;
        cleanupErrors.push(error);
      });
    }
    await probeServer.close().catch((error) => cleanupErrors.push(error));
    if (!preserveAppForSeatRecovery && appStopped) {
      await removeTemporaryTree(userData).catch((error) => cleanupErrors.push(error));
    }
  }
  if (failure && cleanupErrors.length > 0) {
    throw new AggregateError([failure, ...cleanupErrors], "Fingerprint measurement failed.");
  }
  if (failure) throw failure;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Fingerprint cleanup failed.");
  }
}

async function createProfiles(app, recording, fingerprint) {
  for (const row of recording.profiles) {
    const created = await app.callTool("create_profile", {
      name: `Phase 02 disposable ${row.label}`,
      seed: row.seed,
      fingerprint,
    });
    row.id = created.id;
    row.configuredFingerprint = created.fingerprint;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    parsed[values[index].replace(/^--/, "")] = values[index + 1];
  }
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});

function formatError(error, indent = "") {
  const base = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const nested =
    error instanceof AggregateError
      ? error.errors.map((item) => formatError(item, `${indent}  `)).join("\n")
      : "";
  const combined = nested ? `${base}\n${indent}Causes:\n${nested}` : base;
  const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  const redacted = licenseKey ? combined.replaceAll(licenseKey, "<redacted-license>") : combined;
  return redacted.replace(/https?:\/\/\S+/g, "<redacted-url>");
}
