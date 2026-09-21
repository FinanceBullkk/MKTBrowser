const assert = require("node:assert/strict");
const { measureCdpEndpoint } = require("./fingerprint-measurement-cdp.cjs");
const { assertSeatFree } = require("./fingerprint-measurement-mcp.cjs");
const {
  collectShutdownEvidence,
  failureEvidence,
} = require("./cloak-sequential-product-evidence.cjs");
const {
  inspectLaunchedProcess,
  waitForPidExit,
} = require("./cloak-sequential-process-evidence.cjs");

const LAUNCH_SEQUENCE = ["P1", "P2", "P1", "P2"];
const MAX_TRANSITION_MS = 10_000;

async function runSequentialSequence(options) {
  const {
    app,
    profiles,
    probeUrl,
    userData,
    expectedEngineExecutable,
    receipt,
    persistReceipt,
    inspectProcess = inspectLaunchedProcess,
    waitForExit = waitForPidExit,
    measureProbe = measureCdpEndpoint,
    clock = Date.now,
    minimumOpenMs = 0,
    sleep = delay,
    inspectShutdown = collectShutdownEvidence,
  } = options;
  const launches = [];
  const capacityChecks = receipt.capacityChecks ?? [];
  receipt.capacityChecks = capacityChecks;
  const storedMarkers = new Set();
  const fingerprintSeedDigests = {};
  let priorCloseCompletedMs = null;
  let capacity = options.initialCapacity;

  for (let index = 0; index < LAUNCH_SEQUENCE.length; index += 1) {
    const alias = LAUNCH_SEQUENCE[index];
    const profileId = profiles[alias];
    assert.ok(profileId, `Missing ${alias}.`);
    if (Date.parse(capacity.capacity.freshUntil) < clock()) {
      capacity = await assertSeatFree(app, `${alias} launch ${index + 1} preflight`);
      capacityChecks.push(capacityEvidence(`before-${alias}-${index + 1}`, capacity));
    }

    receipt.attemptsUsed += 1;
    assert.ok(receipt.attemptsUsed <= receipt.attemptBudget, "Stage A launch budget exceeded.");
    receipt.currentStage = `launch-${index + 1}-${alias}`;
    await persistReceipt(receipt);

    const launchRequestedMs = clock();
    const launchRequestedAt = new Date(launchRequestedMs).toISOString();
    let launched;
    try {
      launched = await app.callTool("launch_profile", { profile_id: profileId });
    } catch (error) {
      launches.push({
        sequence: index + 1,
        profile: alias,
        status: "failed",
        launchRequestedAt,
        failure: failureEvidence(error),
      });
      receipt.launches = launches;
      await persistReceipt(receipt);
      throw error;
    }

    let primaryError = null;
    let processEvidence;
    let storage;
    let usableAtMs;
    try {
      const inventory = await app.callTool("list_profiles", {});
      const running = inventory.profiles.filter((profile) => profile.isRunning);
      assert.equal(running.length, 1, "More than one local profile is running.");
      assert.equal(running[0].id, profileId, "The wrong profile is running.");
      processEvidence = await inspectProcess({
        pid: launched.pid,
        userData,
        expectedEngineExecutable,
      });
      assert.equal(processEvidence.missingNativeFlags.length, 0, "Native fingerprint flags are missing.");
      assert.equal(processEvidence.executableMatchesPinnedRuntime, true);
      assert.equal(processEvidence.profileDataRootOwned, true);
      assert.equal(processEvidence.fingerprintDisabledFlagPresent, false);
      if (fingerprintSeedDigests[alias]) {
        assert.equal(
          fingerprintSeedDigests[alias],
          processEvidence.fingerprintSeedDigest,
          `${alias} native fingerprint seed changed across restart.`,
        );
      } else {
        fingerprintSeedDigests[alias] = processEvidence.fingerprintSeedDigest;
      }
      storage = await measureProbe({
        cdpEndpoint: launched.cdpEndpoint,
        probeUrl: `${probeUrl}?marker=${encodeURIComponent(alias)}`,
      });
      const expectedBefore = storedMarkers.has(alias) ? alias : null;
      assert.equal(storage.before, expectedBefore, `${alias} storage did not persist independently.`);
      assert.equal(storage.after, alias, `${alias} storage marker was not written.`);
      assert.equal(storage.marker, alias, `${alias} probe returned the wrong marker.`);
      storedMarkers.add(alias);
      usableAtMs = clock();
    } catch (error) {
      primaryError = error;
    }

    const startedAtMs = Date.parse(launched.startedAt);
    const dwellRemainingMs = Number.isFinite(startedAtMs)
      ? Math.max(0, minimumOpenMs - (clock() - startedAtMs))
      : 0;
    if (dwellRemainingMs > 0) await sleep(dwellRemainingMs);

    const closeRequestedMs = clock();
    let closeError = null;
    try {
      await app.callTool("close_profile", { profile_id: profileId });
    } catch (error) {
      closeError = error;
    }
    const closeCompletedMs = clock();
    let processExited = false;
    if (!closeError) processExited = await waitForExit(launched.pid, 8_000);
    if (!closeError && !processExited) closeError = new Error("Owned engine process remained after close.");
    const shutdown = await inspectShutdown(userData, profileId, new Date(closeRequestedMs).toISOString());

    if (!closeError) {
      try {
        capacity = await assertSeatFree(app, `after ${alias} launch ${index + 1}`);
        capacityChecks.push(capacityEvidence(`after-${alias}-${index + 1}`, capacity));
      } catch (error) {
        closeError = error;
      }
    }

    const transitionMs = usableAtMs === undefined
      ? null
      : priorCloseCompletedMs === null
        ? usableAtMs - launchRequestedMs
        : usableAtMs - priorCloseCompletedMs;
    launches.push({
      sequence: index + 1,
      profile: alias,
      status: primaryError || closeError ? "failed" : "passed",
      launchRequestedAt,
      launchResolvedAt: launched.startedAt,
      usableAt: usableAtMs === undefined ? null : new Date(usableAtMs).toISOString(),
      usableMsFromPriorClose: transitionMs,
      openDurationMs: Number.isFinite(startedAtMs) ? closeRequestedMs - startedAtMs : null,
      closeRequestedAt: new Date(closeRequestedMs).toISOString(),
      closeCompletedAt: new Date(closeCompletedMs).toISOString(),
      processExited,
      shutdown,
      runningCount: 1,
      storageBefore: storage?.before ?? null,
      storageAfter: storage?.after ?? null,
      process: processEvidence,
      ...(primaryError || closeError
        ? { failure: failureEvidence(new AggregateError(
            [primaryError, closeError].filter(Boolean),
            `${alias} launch ${index + 1} failed.`,
          )) }
        : {}),
    });
    receipt.launches = launches;
    await persistReceipt(receipt);

    if (primaryError || closeError) {
      throw new AggregateError(
        [primaryError, closeError].filter(Boolean),
        `${alias} launch ${index + 1} failed.`,
      );
    }
    assert.ok(
      transitionMs !== null && transitionMs <= MAX_TRANSITION_MS,
      `${alias} did not reach a usable local page within ${MAX_TRANSITION_MS} ms.`,
    );
    priorCloseCompletedMs = closeCompletedMs;
  }
  return { launches, capacityChecks, fingerprintSeedDigests };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stageAProbeAssets() {
  return {
    "/stage-a.html": {
      type: "text/html; charset=utf-8",
      body: "<!doctype html><meta charset=\"utf-8\"><title>Stage A</title><script src=\"/stage-a.js\"></script>",
    },
    "/stage-a.js": {
      type: "text/javascript; charset=utf-8",
      body: `globalThis.__runFingerprintMeasurement = () => {
  const marker = new URL(location.href).searchParams.get("marker");
  const before = localStorage.getItem("mkt-browser-stage-a");
  localStorage.setItem("mkt-browser-stage-a", marker);
  return { marker, before, after: localStorage.getItem("mkt-browser-stage-a") };
};`,
    },
  };
}

function capacityEvidence(stage, value) {
  const capacity = value.capacity;
  return {
    stage,
    requestStartedAt: value.requestedAt,
    requestCompletedAt: value.completedAt,
    observationCompletedAt: capacity.observedAt,
    freshUntil: capacity.freshUntil,
    local: {
      total: capacity.total,
      free: capacity.free,
      active: capacity.active,
      pendingRecovery: capacity.pendingRecovery,
      cooling: capacity.cooling,
    },
    vendor: { active: capacity.vendorActive, limit: capacity.vendorLimit },
    availability: capacity.availability,
    reason: capacity.reason,
  };
}

module.exports = { LAUNCH_SEQUENCE, capacityEvidence, runSequentialSequence, stageAProbeAssets };
