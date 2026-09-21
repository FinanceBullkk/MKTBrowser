const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectShutdownEvidence,
} = require("./cloak-sequential-product-evidence.cjs");
const {
  LAUNCH_SEQUENCE,
  failureEvidence,
  parseArgs,
  parseCommandLineFlags,
  runSequentialSequence,
} = require("./cloak-sequential-product-path.cjs");

function readyCapacity() {
  const now = Date.now();
  return {
    requestedAt: new Date(now).toISOString(),
    completedAt: new Date(now + 1).toISOString(),
    capacity: {
      total: 1,
      free: 1,
      active: 0,
      pendingRecovery: 0,
      cooling: 0,
      availability: "ready",
      reason: "CAPACITY_AVAILABLE",
      observedAt: new Date(now + 1).toISOString(),
      freshUntil: new Date(now + 5_000).toISOString(),
      vendorActive: 0,
      vendorLimit: 1,
    },
  };
}

function fakeHarness({ failLaunch = null, now = Date.now } = {}) {
  const ids = { P1: "profile-one", P2: "profile-two" };
  const running = new Set();
  const storage = new Map();
  let launchCalls = 0;
  const app = {
    callTool: async (name, args) => {
      if (name === "refresh_license_capacity") return { licenseCapacity: readyCapacity().capacity };
      if (name === "launch_profile") {
        launchCalls += 1;
        if (failLaunch === launchCalls) throw new Error("ENGINE_UNAVAILABLE synthetic refusal");
        running.add(args.profile_id);
        return {
          id: args.profile_id,
          cdpEndpoint: `http://127.0.0.1:${45000 + launchCalls}`,
          pid: 1000 + launchCalls,
          startedAt: new Date(now()).toISOString(),
        };
      }
      if (name === "list_profiles") {
        return {
          profiles: Object.values(ids).map((id) => ({ id, isRunning: running.has(id) })),
        };
      }
      if (name === "close_profile") {
        running.delete(args.profile_id);
        return { closed: args.profile_id };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  return {
    app,
    ids,
    getLaunchCalls: () => launchCalls,
    probe: async ({ probeUrl }) => {
      const alias = new URL(probeUrl).searchParams.get("marker");
      const before = storage.get(alias) ?? null;
      storage.set(alias, alias);
      return { marker: alias, before, after: alias };
    },
  };
}

test("runs exactly P1 P2 P1 P2 with one launch call per step", async () => {
  const fake = fakeHarness();
  const receipt = { attemptBudget: 4, attemptsUsed: 0, launches: [] };
  const persisted = [];
  const result = await runSequentialSequence({
    app: fake.app,
    profiles: fake.ids,
    probeUrl: "http://127.0.0.1/stage-a.html",
    userData: "C:\\temp\\stage-a",
    expectedEngineExecutable: "C:\\temp\\stage-a\\chrome.exe",
    initialCapacity: readyCapacity(),
    receipt,
    persistReceipt: async (value) => persisted.push(structuredClone(value)),
    inspectProcess: async ({ pid }) => ({
      executableSha256: "a".repeat(64),
      executableMatchesPinnedRuntime: true,
      profileDataRootOwned: true,
      nativeFingerprintFlagCount: 13,
      missingNativeFlags: [],
      fingerprintSeedDigest: pid % 2 === 1 ? "p1-seed" : "p2-seed",
      fingerprintDisabledFlagPresent: false,
      proxyFlagPresent: false,
    }),
    waitForExit: async () => true,
    clock: (() => {
      let value = Date.now();
      return () => (value += 10);
    })(),
    measureProbe: fake.probe,
  });
  assert.equal(fake.getLaunchCalls(), 4);
  assert.equal(receipt.attemptsUsed, 4);
  assert.deepEqual(result.launches.map((entry) => entry.profile), LAUNCH_SEQUENCE);
  assert.deepEqual(result.launches.map((entry) => entry.storageBefore), [null, null, "P1", "P2"]);
  assert.ok(persisted.length >= 8);
});

test("stops on the first refused launch without consuming later attempts", async () => {
  const fake = fakeHarness({ failLaunch: 2 });
  const receipt = { attemptBudget: 4, attemptsUsed: 0, launches: [] };
  await assert.rejects(
    runSequentialSequence({
      app: fake.app,
      profiles: fake.ids,
      probeUrl: "http://127.0.0.1/stage-a.html",
      userData: "C:\\temp\\stage-a",
      expectedEngineExecutable: "C:\\temp\\stage-a\\chrome.exe",
      initialCapacity: readyCapacity(),
      receipt,
      persistReceipt: async () => {},
      inspectProcess: async ({ pid }) => ({
        executableSha256: "a".repeat(64),
        executableMatchesPinnedRuntime: true,
        profileDataRootOwned: true,
        nativeFingerprintFlagCount: 13,
        missingNativeFlags: [],
        fingerprintSeedDigest: pid % 2 === 1 ? "p1-seed" : "p2-seed",
        fingerprintDisabledFlagPresent: false,
        proxyFlagPresent: false,
      }),
      waitForExit: async () => true,
      clock: Date.now,
      measureProbe: fake.probe,
    }),
    /synthetic refusal/,
  );
  assert.equal(fake.getLaunchCalls(), 2);
  assert.equal(receipt.attemptsUsed, 2);
});

test("honors a bounded minimum open duration before every close", async () => {
  let now = Date.now();
  const fake = fakeHarness({ now: () => now });
  const receipt = { attemptBudget: 4, attemptsUsed: 0, launches: [] };
  const sleeps = [];
  const result = await runSequentialSequence({
    app: fake.app,
    profiles: fake.ids,
    probeUrl: "http://127.0.0.1/stage-a.html",
    userData: "C:\\temp\\stage-a",
    expectedEngineExecutable: "C:\\temp\\stage-a\\chrome.exe",
    initialCapacity: readyCapacity(),
    receipt,
    persistReceipt: async () => {},
    inspectProcess: async ({ pid }) => ({
      executableSha256: "a".repeat(64),
      executableMatchesPinnedRuntime: true,
      profileDataRootOwned: true,
      nativeFingerprintFlagCount: 13,
      missingNativeFlags: [],
      fingerprintSeedDigest: pid % 2 === 1 ? "p1-seed" : "p2-seed",
      fingerprintDisabledFlagPresent: false,
      proxyFlagPresent: false,
    }),
    waitForExit: async () => true,
    clock: () => now,
    minimumOpenMs: 5_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    measureProbe: async (options) => {
      now += 500;
      return fake.probe(options);
    },
  });
  assert.equal(sleeps.length, 4);
  assert.ok(result.launches.every((entry) => entry.openDurationMs >= 5_000));
});

test("parses only complete pairs and extracts command-line flags", () => {
  assert.deepEqual(parseArgs(["--output", "receipt.json"]), { output: "receipt.json" });
  assert.throws(() => parseArgs(["--output"]), /Invalid argument/);
  const flags = parseCommandLineFlags(
    'chrome.exe --fingerprint=12345 --user-data-dir="C:\\Temp\\Profile One" --no-sandbox',
  );
  assert.equal(flags.get("fingerprint"), "12345");
  assert.equal(flags.get("user-data-dir"), "C:\\Temp\\Profile One");
  assert.equal(flags.get("no-sandbox"), "");
});

test("records a stable licence reason and exit code without retaining raw diagnostics", () => {
  const error = new Error(
    'launch_profile failed: {"error":{"code":"ENGINE_UNAVAILABLE","message":"CloakBrowser: the licence server could not be reached, so the browser refused to start."}}',
  );
  const evidence = failureEvidence(
    error,
    "secret-key https://cloakbrowser.dev/path Chromium pid 123 exited code=78 signal=— " +
      "DevTools endpoint ready childPid=123 primaryPid=123 port=45678 CDP ready port=45678",
  );
  assert.deepEqual(evidence, {
    category: "CAPACITY_OR_LICENCE_REFUSAL",
    mcpCode: "ENGINE_UNAVAILABLE",
    licenceReason: "LICENSE_SERVER_UNREACHABLE",
    licenseExitCode: 78,
    appDiagnostic: {
      licenceExitObserved: true,
      devToolsEndpointReady: true,
      primaryProcessMatchesSpawnedChild: true,
      cdpReady: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /secret-key|cloakbrowser\.dev|123|45678/);
});

test("records process handoff as a boolean without retaining process identifiers", () => {
  const evidence = failureEvidence(
    new Error("profile launch failed"),
    "DevTools endpoint ready childPid=123 primaryPid=456 port=789",
  );

  assert.deepEqual(evidence, {
    category: "PRODUCT_PATH_FAILED",
    appDiagnostic: {
      devToolsEndpointReady: true,
      primaryProcessMatchesSpawnedChild: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /123|456|789/);
});

test("maps every documented CloakBrowser denial to a stable reason", () => {
  const cases = [
    ["session limit is reached", "LICENSE_SESSION_LIMIT", 76],
    ["licence key is missing, invalid, or expired", "LICENSE_KEY_INVALID", 77],
    ["licence server could not be reached", "LICENSE_SERVER_UNREACHABLE", 78],
    ["local licence state is not writable", "LICENSE_LOCAL_STATE_NOT_WRITABLE", 79],
  ];
  for (const [message, licenceReason, licenseExitCode] of cases) {
    assert.deepEqual(failureEvidence(new Error(message)), {
      category: "CAPACITY_OR_LICENCE_REFUSAL",
      licenceReason,
      licenseExitCode,
    });
  }
});

test("normalizes every coordinator admission failure without retaining operator messages", () => {
  const cases = [
    ["Another browser availability check is already running. Try once after it finishes.", "ADMISSION_BUSY"],
    ["No CloakBrowser licence key is configured on this PC.", "NO_LICENSE_KEY"],
    ["A browser profile is already open. Close it before opening another profile.", "LOCAL_SESSION_ACTIVE"],
    ["MKT Browser is recovering a prior browser session. Finish recovery before trying once.", "LOCAL_RECOVERY_PENDING"],
    ["Local browser capacity is still cooling. Check availability before trying once.", "LOCAL_CAPACITY_UNAVAILABLE"],
    ["Browser state changed while availability was checked. Check again before trying once.", "LOCAL_STATE_CHANGED"],
    ["The licence provider reports that all session capacity is in use.", "VENDOR_CAPACITY_OCCUPIED"],
    ["The licence provider denied the capacity check. Verify the configured licence.", "VENDOR_ACCESS_DENIED"],
    ["The licence provider rate-limited the capacity check. Wait before checking again.", "VENDOR_RATE_LIMITED"],
    ["The licence provider returned an unreadable capacity response.", "VENDOR_RESPONSE_MALFORMED"],
    ["The licence provider did not answer the capacity check in time.", "VENDOR_REQUEST_TIMEOUT"],
    ["The licence provider could not be reached to verify capacity.", "VENDOR_UNREACHABLE"],
    ["MKT Browser could not durably record licence capacity state.", "JOURNAL_PERSISTENCE_FAILED"],
  ];

  for (const [message, admissionReason] of cases) {
    const evidence = failureEvidence(new Error(
      `launch_profile failed: ${JSON.stringify({
        error: { code: "ENGINE_UNAVAILABLE", message },
      })}`,
    ));
    assert.deepEqual(evidence, {
      category: "CAPACITY_OR_LICENCE_REFUSAL",
      mcpCode: "ENGINE_UNAVAILABLE",
      admissionReason,
    });
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(message.slice(0, 16), "i"));
  }
});

test("retains only bounded shutdown facts from the profile lifecycle log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-stage-a-evidence-"));
  const profileId = "sensitive-profile-id";
  try {
    const requestedAt = "2026-09-21T13:00:01.000Z";
    const records = [
      { timestamp: "2026-09-21T13:00:00.000Z", profileId, reason: "SHUTDOWN-COMPLETE", shutdownMethod: "SIGKILL", pid: 111 },
      { timestamp: "2026-09-21T13:00:02.000Z", profileId, reason: "CHILD-EXIT", exitCode: 0, pid: 222, port: 333 },
      { timestamp: "2026-09-21T13:00:03.000Z", profileId, reason: "SHUTDOWN-COMPLETE", shutdownMethod: "Browser.close", pid: 222, port: 333 },
    ];
    await writeFile(
      path.join(root, "profile-shutdown.log"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const evidence = await collectShutdownEvidence(root, profileId, requestedAt);
    assert.deepEqual(evidence, {
      completed: true,
      shutdownMethod: "Browser.close",
      childExitObserved: true,
      childExitCode: 0,
      childExitSignalled: false,
    });
    assert.doesNotMatch(JSON.stringify(evidence), /sensitive-profile-id|111|222|333/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
