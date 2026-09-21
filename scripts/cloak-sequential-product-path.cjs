#!/usr/bin/env node

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { mkdtemp } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startProbeServer } = require("./fingerprint-measurement-cdp.cjs");
const {
  removeTemporaryTree,
  summarizeLifecycle,
} = require("./fingerprint-measurement-evidence.cjs");
const { seedVerifiedStableEngineCache } = require("./fingerprint-engine-cache-fixture.cjs");
const { inspectFingerprintEnginePin } = require("./fingerprint-engine-pin.cjs");
const {
  assertSeatFree,
  capacityCheckFromError,
  launchMktBrowser,
  recoverProfilesAndSeat,
  waitForReadyRuntime,
} = require("./fingerprint-measurement-mcp.cjs");
const {
  classifyFailure,
  collectArtifactEvidence,
  createExclusiveReceipt,
  failureEvidence,
  parseArgs,
} = require("./cloak-sequential-product-evidence.cjs");
const { parseCommandLineFlags } = require("./cloak-sequential-process-evidence.cjs");
const {
  LAUNCH_SEQUENCE,
  capacityEvidence,
  runSequentialSequence,
  stageAProbeAssets,
} = require("./cloak-sequential-product-sequence.cjs");

async function main() {
  if (process.platform !== "win32") throw new Error("Stage A requires Windows.");
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("Pass --output <new-receipt-path>.");
  const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (!licenseKey) throw new Error("CLOAKBROWSER_LICENSE_KEY is required and is never recorded.");

  const repositoryRoot = path.resolve(__dirname, "..");
  const executable = path.resolve(
    args.executable ?? path.join(repositoryRoot, "apps/desktop/release/win-unpacked/MKTBrowser.exe"),
  );
  assert.ok(existsSync(executable), "Build the Windows directory package before Stage A.");
  const output = path.resolve(args.output);
  const minimumOpenMs = parseNonNegativeInteger(args["minimum-open-ms"] ?? "0", "--minimum-open-ms");
  const enginePin = await inspectFingerprintEnginePin(args);
  const artifact = await collectArtifactEvidence(repositoryRoot, executable);
  const receipt = {
    schemaVersion: 1,
    status: "prepared",
    preparedAt: new Date().toISOString(),
    attemptBudget: LAUNCH_SEQUENCE.length,
    attemptsUsed: 0,
    stopOnFirstFailure: true,
    automaticRetry: false,
    minimumOpenMs,
    sequence: [...LAUNCH_SEQUENCE],
    productPath: "packaged-mkt-browser-mcp",
    proxyGate: "OPEN-localhost-only",
    artifact,
    engine: {
      pinSequence: enginePin.authority.sequence,
      kind: enginePin.authority.engineKind,
      version: enginePin.version,
      archiveSha256: enginePin.archiveSha256,
      archiveSizeBytes: enginePin.authority.sizeBytes,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMbBefore: Math.round(os.freemem() / 1024 / 1024),
    },
    profiles: {
      P1: { seedConfigured: true },
      P2: { seedConfigured: true },
    },
    capacityChecks: [],
    launches: [],
    cleanup: { completed: false, disposableRootRemoved: false },
  };
  const persistReceipt = await createExclusiveReceipt(output, receipt);

  let app;
  let probeServer;
  let userData;
  let profileRows = [];
  let failure = null;
  let preserveForRecovery = false;
  const cleanupErrors = [];
  try {
    userData = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-stage-a-"));
    const engineCache = await seedVerifiedStableEngineCache({
      userData,
      expectedVersion: enginePin.version,
      expectedArchiveSha256: enginePin.archiveSha256,
      sourceRoot: enginePin.sourceRoot,
    });
    receipt.engine.runtimeSha256 = engineCache.runtimeSha256;
    receipt.status = "starting-app";
    await persistReceipt(receipt);

    probeServer = await startProbeServer(stageAProbeAssets());
    app = await launchMktBrowser({ executable, userData, licenseKey });
    const runtime = await waitForReadyRuntime(app, 120_000);
    assert.equal(runtime.contractVersion, 5, "Stage A requires control contract 5.");
    assert.equal(runtime.engine?.kind, "cloakbrowser", "Stage A did not select CloakBrowser.");
    assert.equal(runtime.engine?.version, enginePin.version, "The active engine version drifted.");
    receipt.runtime = {
      appVersion: runtime.appVersion,
      contractVersion: runtime.contractVersion,
      profileSchemaVersion: runtime.profileSchemaVersion,
      engineKind: runtime.engine.kind,
      engineVersion: runtime.engine.version,
    };

    profileRows = await createProfiles(app);
    const initialCapacity = await assertSeatFree(app, "Stage A initial preflight");
    receipt.capacityChecks.push(capacityEvidence("initial", initialCapacity));
    receipt.status = "running";
    await persistReceipt(receipt);

    const sequence = await runSequentialSequence({
      app,
      profiles: Object.fromEntries(profileRows.map((row) => [row.alias, row.id])),
      probeUrl: `${probeServer.origin}/stage-a.html`,
      userData,
      expectedEngineExecutable: path.join(
        userData,
        "chromium",
        "cloakbrowser",
        "runtime",
        "chrome.exe",
      ),
      initialCapacity,
      receipt,
      persistReceipt,
      minimumOpenMs,
    });
    receipt.launches = sequence.launches;
    receipt.profiles.P1.fingerprintSeedDigest = sequence.fingerprintSeedDigests.P1;
    receipt.profiles.P2.fingerprintSeedDigest = sequence.fingerprintSeedDigests.P2;
    assert.notEqual(
      receipt.profiles.P1.fingerprintSeedDigest,
      receipt.profiles.P2.fingerprintSeedDigest,
      "P1 and P2 unexpectedly used the same native fingerprint seed.",
    );
    receipt.lifecycle = await summarizeLifecycle(
      userData,
      profileRows.map((row) => row.id),
      LAUNCH_SEQUENCE.length,
    );
    assert.equal(receipt.lifecycle.completedCloses, LAUNCH_SEQUENCE.length);
    assert.equal(receipt.lifecycle.browserClose, LAUNCH_SEQUENCE.length);
    assert.equal(receipt.lifecycle.signalEscalations, 0);
    receipt.status = "passed";
    receipt.completedAt = new Date().toISOString();
    await persistReceipt(receipt);
  } catch (error) {
    failure = error;
    const failedCapacity = capacityCheckFromError(error);
    if (failedCapacity) {
      receipt.capacityChecks.push(
        capacityEvidence(`failed-${receipt.currentStage ?? "preflight"}`, failedCapacity),
      );
    }
    receipt.status = "failed";
    receipt.failure = {
      stage: receipt.currentStage ?? "preflight",
      ...failureEvidence(error, app?.diagnostics?.() ?? ""),
    };
    receipt.completedAt = new Date().toISOString();
    if (app) preserveForRecovery = !(await recoverProfilesAndSeat(app, profileRows));
  } finally {
    if (userData && profileRows.length > 0 && !receipt.lifecycle) {
      const expectedCloses = receipt.launches.filter((entry) => entry.closeRequestedAt).length;
      receipt.lifecycle = await summarizeLifecycle(
        userData,
        profileRows.map((row) => row.id),
        expectedCloses,
      ).catch(() => null);
    }
    if (app && !preserveForRecovery) {
      await app.stop().catch((error) => cleanupErrors.push(error));
    }
    if (probeServer) await probeServer.close().catch((error) => cleanupErrors.push(error));
    if (userData && !preserveForRecovery && cleanupErrors.length === 0) {
      await removeTemporaryTree(userData)
        .then(() => {
          receipt.cleanup.disposableRootRemoved = true;
        })
        .catch((error) => cleanupErrors.push(error));
    }
    receipt.cleanup.completed = !preserveForRecovery && cleanupErrors.length === 0;
    receipt.cleanup.preservedForRecovery = preserveForRecovery;
    delete receipt.currentStage;
    if (cleanupErrors.length > 0) {
      receipt.status = "failed";
      receipt.failure = { stage: "cleanup", category: "CLEANUP_FAILED" };
    }
    await persistReceipt(receipt).catch(() => undefined);
  }

  if (failure || cleanupErrors.length > 0) {
    const errors = [failure, ...cleanupErrors].filter(Boolean);
    throw new AggregateError(errors, "CloakBrowser Stage A failed.");
  }
  process.stdout.write(`Stage A passed; sanitized receipt: ${output}\n`);
}

function parseNonNegativeInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large.`);
  return parsed;
}

async function createProfiles(app) {
  const rows = [];
  for (const alias of ["P1", "P2"]) {
    const created = await app.callTool("create_profile", {
      name: `Phase 4 Stage A ${alias}`,
      seed: `260921-cloak-stage-a-${alias.toLowerCase()}`,
      tags: ["phase-4", "stage-a", "disposable"],
    });
    rows.push({ alias, id: created.id });
  }
  return rows;
}

function formatError(error) {
  const value = error instanceof Error ? error.stack ?? error.message : String(error);
  const key = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  return (key ? value.replaceAll(key, "<redacted-license>") : value)
    .replace(/https?:\/\/\S+/g, "<redacted-url>");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  LAUNCH_SEQUENCE,
  capacityEvidence,
  classifyFailure,
  failureEvidence,
  parseArgs,
  parseCommandLineFlags,
  runSequentialSequence,
};
