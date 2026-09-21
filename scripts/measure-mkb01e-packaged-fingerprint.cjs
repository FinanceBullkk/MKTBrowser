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
const { inspectFingerprintEnginePin } = require("./fingerprint-engine-pin.cjs");
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
const args = parseArgs(process.argv.slice(2));
// Historical .2 defaults live in fingerprint-engine-pin.cjs. An override must provide both
// version and digest, agree with local authority/cache, and be recorded with the measurement.
// Explicit time to wait after close; it is not proof that the vendor has released its seat.
const seatSettleMs = Number(args["seat-settle-seconds"] ?? 0) > 0
  ? Number(args["seat-settle-seconds"]) * 1000
  : undefined;

// Retained diagnostic experiment only: retries can prolong the vendor hold. Zero is the
// default and stops at the first refusal; an explicit retry window is not a seat-recovery fix.
const seatRetryMinutes = Number(args["seat-retry-minutes"] ?? 0);

/** Timestamped progress, so a long run can be read while it is still running. */
const step = (message) => process.stdout.write(`${new Date().toISOString()}  ${message}\n`);

async function main() {
  if (process.platform !== "win32") throw new Error("Fingerprint measurement requires Windows.");
  if (!args.output) throw new Error("Pass --output <raw-json-path>.");
  const enginePin = await inspectFingerprintEnginePin(args);
  if (!Number.isFinite(seatRetryMinutes) || seatRetryMinutes < 0 ||
      (args["seat-settle-seconds"] !== undefined &&
       (!Number.isFinite(Number(args["seat-settle-seconds"])) || Number(args["seat-settle-seconds"]) < 0))) {
    throw new Error("Seat timing arguments must be finite, non-negative numbers.");
  }
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
  recording.enginePin = enginePin.authority;
  recording.enginePinVerification = enginePin.verification;
  await persist(rawOutput, recording);

  step(`run start — pool ${PROFILE_COUNT} x ${RUN_COUNT} runs, seat settle ${(seatSettleMs ?? 5000) / 1000}s`);
  let app;
  let failure = null;
  const cleanupErrors = [];
  let preserveAppForSeatRecovery = false;
  try {
    const engineCache = await seedVerifiedStableEngineCache({
      userData,
      expectedVersion: enginePin.version,
      expectedArchiveSha256: enginePin.archiveSha256,
      sourceRoot: enginePin.sourceRoot,
    });
    step(`engine cache seeded - ${engineCache.version}`);
    const stock = await measureStockChrome({
      chromeExecutable: args.chrome ? path.resolve(args.chrome) : locateSystemChrome(),
      probeUrl,
    });
    assertMeasurement(stock.measurement, "stock Chrome");
    step(`stock control measured — ${stock.executable.version}`);
    recording.stock = stock;
    await persist(rawOutput, recording);

    app = await launchMktBrowser({ executable, userData, licenseKey });
    const runtime = await waitForReadyRuntime(app, 20 * 60_000);
    assert.equal(runtime.engine.kind, "cloakbrowser", "The app did not select CloakBrowser.");
    assert.equal(
      runtime.engine.version,
      enginePin.version,
      "The requested engine pin is not active.",
    );
    step(`app ready — engine ${runtime.engine.kind} ${runtime.engine.version}`);
    await assertSeatFree(app, "initial preflight");

    const options = await app.callTool("list_fingerprint_options", {});
    const fingerprint = selectProfileFingerprint(stock.measurement, options);
    await createProfiles(app, recording, fingerprint);
    step(`${recording.profiles.length} profiles created`);
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
        step(`${row.label} run ${runIndex + 1} — launching`);
        row.runs[runIndex] = await measureCloakProfile(app, row.id, probeUrl, {
          settleMs: seatSettleMs,
          seatRetryMinutes,
          log: step,
        });
        step(`${row.label} run ${runIndex + 1} — measured, closed, seat settled`);
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
        localPinSequence: enginePin.authority.sequence,
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
