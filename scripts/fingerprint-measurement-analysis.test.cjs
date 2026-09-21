const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  analyzeMeasurement,
  classifyCohort,
  computeStableSubset,
  evaluateConsistency,
  findPairCollisions,
} = require("./fingerprint-measurement-analysis.cjs");
const { seedVerifiedStableEngineCache } = require("./fingerprint-engine-cache-fixture.cjs");
const { assertTemporaryPath } = require("./fingerprint-measurement-evidence.cjs");
const {
  assertSeatFree,
  capacityCheckFromError,
  recoverProfilesAndSeat,
} = require("./fingerprint-measurement-mcp.cjs");
const { buildProbeAssets } = require("./fingerprint-probe-source.cjs");
const { selectProfileFingerprint } = require("./fingerprint-profile-cohort-config.cjs");

function surface(value, supported = true) {
  return supported ? { supported: true, readings: { value } } : { supported: false };
}

function measurement(overrides = {}) {
  const document = {
    fonts: surface("font-shared"),
    audio: surface("audio-shared"),
    webgl1: surface("webgl-1"),
    webgl2: surface("webgl-2"),
    webgpu: surface("webgpu"),
    canvas: surface("canvas"),
    clientRects: surface("rects"),
    uaClientHints: surface("ua"),
    screenLocale: surface("locale"),
    aggregate: surface("aggregate"),
    ...overrides,
  };
  return {
    schemaVersion: 1,
    contexts: {
      document: { context: "document", surfaces: document },
      iframe: { context: "iframe", surfaces: structuredClone(document) },
      worker: {
        context: "worker",
        surfaces: {
          ...structuredClone(document),
          audio: surface(null, false),
          clientRects: surface(null, false),
          screenLocale: { supported: true, readings: { value: "locale", screen: null } },
        },
      },
      offscreenCanvas: {
        context: "offscreenCanvas",
        surfaces: {
          canvas: structuredClone(document.canvas),
          webgl1: structuredClone(document.webgl1),
          webgl2: structuredClone(document.webgl2),
          aggregate: surface("offscreen-aggregate"),
        },
      },
    },
  };
}

test("computes the stable subset from data and keeps full tuple separate", () => {
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    label: `P${index + 1}`,
    runs: [measurement({ canvas: surface(`canvas-${index}`) })],
  }));
  const stable = computeStableSubset(profiles, 0);
  assert.ok(stable.includes("fonts.value"));
  assert.ok(!stable.includes("canvas.value"));
  assert.equal(findPairCollisions(profiles, 0, stable).length, 10);
  assert.equal(findPairCollisions(profiles, 0, []).length, 0);
});

test("finds invariant vendor marks inside a surface whose other components vary", () => {
  const stock = measurement({
    audio: {
      supported: true,
      readings: { channelHash: "stock-audio", latency: { base: 1 } },
    },
  });
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    label: `P${index + 1}`,
    runs: [
      measurement({
        audio: {
          supported: true,
          readings: { channelHash: "cloak-audio", latency: { base: index + 2 } },
        },
      }),
      measurement({
        audio: {
          supported: true,
          readings: { channelHash: "cloak-audio", latency: { base: index + 2 } },
        },
      }),
    ],
  }));
  const stable = computeStableSubset(profiles, 0);
  assert.ok(stable.includes("audio.channelHash"));
  assert.ok(!stable.includes("audio.latency.base"));

  const cohort = classifyCohort(profiles, stock);
  assert.deepEqual(cohort.components["audio.channelHash"], {
    classification: "invariant-differs-from-stock",
    verdict: "FAIL",
  });
  assert.deepEqual(cohort.components["audio.latency.base"], {
    classification: "varies-by-profile",
    verdict: "PASS",
  });
  assert.equal(cohort.surfaces.audio.verdict, "FAIL");
  assert.equal(cohort.verdict, "FAIL");
});

test("blocks cohort verdicts when a declared document surface is unavailable", () => {
  const stock = measurement({ webgpu: surface(null, false) });
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    label: `P${index + 1}`,
    runs: [
      measurement({ webgpu: surface(null, false) }),
      measurement({ webgpu: surface(null, false) }),
    ],
  }));
  const cohort = classifyCohort(profiles, stock);
  assert.equal(cohort.verdict, "BLOCKED");
  assert.deepEqual(cohort.surfaces.webgpu, {
    classification: "not-measured",
    verdict: "BLOCKED",
  });
});

test("checks restart equality while comparing only shared cross-context readings", () => {
  const first = measurement();
  const second = measurement();
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    label: `P${index + 1}`,
    runs: [structuredClone(first), structuredClone(second)],
  }));
  assert.equal(evaluateConsistency(profiles).verdict, "PASS");
  profiles[0].runs[1].contexts.document.surfaces.audio = surface("changed");
  assert.equal(evaluateConsistency(profiles).verdict, "FAIL");
});

test("requires complete equality for array readings across contexts", () => {
  const first = measurement();
  first.contexts.document.surfaces.screenLocale.readings.languages = ["en-US"];
  first.contexts.iframe.surfaces.screenLocale.readings.languages = ["en-US"];
  const second = structuredClone(first);
  second.contexts.iframe.surfaces.screenLocale.readings.languages = ["en-US", "fr-FR"];
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    label: `P${index + 1}`,
    runs: [structuredClone(first), structuredClone(second)],
  }));
  assert.equal(evaluateConsistency(profiles).verdict, "FAIL");
  assert.ok(
    evaluateConsistency(profiles).contextMismatches.some(
      (mismatch) => mismatch.context === "iframe" && mismatch.surface === "screenLocale",
    ),
  );
});

test("produces separate A, B, and C verdicts", () => {
  const stock = measurement({ audio: surface("stock-audio") });
  const profiles = Array.from({ length: 5 }, (_, index) => {
    const measured = measurement({
      audio: surface("cloak-audio"),
      canvas: surface(`canvas-${index}`),
      aggregate: surface(`aggregate-${index}`),
    });
    return { label: `P${index + 1}`, runs: [measured, structuredClone(measured)] };
  });
  const result = analyzeMeasurement({ profiles, stock });
  assert.equal(result.criterionA.verdict, "PASS");
  assert.equal(result.criterionB.verdict, "FAIL");
  assert.equal(result.criterionC.verdict, "FAIL");
});

test("emits syntactically valid probe assets", () => {
  const assets = buildProbeAssets();
  for (const route of ["/probe-runtime.js", "/probe-page.js", "/worker.js"]) {
    assert.doesNotThrow(() => new Function(assets[route].body));
  }
});

test("selects one valid fixed profile configuration from the stock cohort", () => {
  const stock = measurement({
    webgl1: {
      supported: true,
      readings: { unmaskedRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060)" },
    },
    uaClientHints: {
      supported: true,
      readings: { hardwareConcurrency: 12, deviceMemory: 8 },
    },
    screenLocale: {
      supported: true,
      readings: {
        language: "en-US",
        timezone: "Asia/Saigon",
        screen: { width: 1920, height: 1080 },
      },
    },
  });
  const selected = selectProfileFingerprint(stock, {
    devices: [{ id: "windows-laptop-nvidia", screens: [{ width: 1920, height: 1080 }] }],
    locales: [
      { id: "en-US", timezones: ["America/New_York"] },
      { id: "vi-VN", timezones: ["Asia/Ho_Chi_Minh"] },
    ],
  });
  assert.deepEqual(selected, {
    device: "windows-laptop-nvidia",
    localeId: "vi-VN",
    timezone: "Asia/Ho_Chi_Minh",
    screen: { width: 1920, height: 1080 },
    hardwareConcurrency: 12,
    deviceMemory: 8,
  });
});

test("copies only Stable .2 runtime payload entries, never embedded profile data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-fingerprint-engine-fixture-"));
  const sourceRoot = path.join(root, "source");
  const userData = path.join(root, "user-data");
  const runtime = path.join(sourceRoot, "runtime");
  try {
    await mkdir(path.join(runtime, "locales"), { recursive: true });
    await mkdir(path.join(runtime, "ttk-profile-sensitive", "Default"), { recursive: true });
    await writeFile(path.join(runtime, "chrome.exe"), "stable-runtime", "utf8");
    await writeFile(path.join(runtime, "chrome.dll"), "stable-library", "utf8");
    await writeFile(path.join(runtime, "locales", "en-US.pak"), "locale", "utf8");
    await writeFile(
      path.join(runtime, "ttk-profile-sensitive", "Default", "Login Data"),
      "must-not-copy",
      "utf8",
    );
    await writeFile(
      path.join(sourceRoot, "current.json"),
      JSON.stringify({
        version: "151.0.7922.108.2",
        sha256: "archive-hash",
        binaryRelative: "runtime/chrome.exe",
        ignoredMetadata: "not-copied",
      }),
      "utf8",
    );

    const result = await seedVerifiedStableEngineCache({
      userData,
      expectedVersion: "151.0.7922.108.2",
      expectedArchiveSha256: "archive-hash",
      sourceRoot,
    });

    assert.equal(
      result.runtimeSha256,
      createHash("sha256").update("stable-runtime").digest("hex"),
    );
    assert.ok(existsSync(path.join(userData, "chromium", "cloakbrowser", "runtime", "chrome.dll")));
    assert.ok(
      existsSync(
        path.join(userData, "chromium", "cloakbrowser", "runtime", "locales", "en-US.pak"),
      ),
    );
    assert.ok(
      !existsSync(
        path.join(userData, "chromium", "cloakbrowser", "runtime", "ttk-profile-sensitive"),
      ),
    );
    const copiedMetadata = JSON.parse(
      await readFile(path.join(userData, "chromium", "cloakbrowser", "current.json"), "utf8"),
    );
    assert.deepEqual(copiedMetadata, {
      version: "151.0.7922.108.2",
      sha256: "archive-hash",
      binaryRelative: "runtime/chrome.exe",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps raw fingerprint evidence inside the temporary directory", () => {
  assert.equal(
    assertTemporaryPath(path.join(os.tmpdir(), "mkt-fingerprint", "raw.json")),
    path.resolve(os.tmpdir(), "mkt-fingerprint", "raw.json"),
  );
  assert.throws(
    () => assertTemporaryPath(path.resolve("raw-fingerprint.json")),
    /must stay inside the temporary directory/,
  );
  assert.throws(
    () => assertTemporaryPath(os.tmpdir()),
    /must stay inside the temporary directory/,
  );
});

test("accepts only a fresh completed provider observation as a free seat", async () => {
  const calls = [];
  const capacity = {
    total: 1,
    free: 1,
    active: 0,
    pendingRecovery: 0,
    cooling: 0,
    availability: "ready",
    reason: "CAPACITY_AVAILABLE",
    observedAt: "2026-09-21T10:00:00.000Z",
    freshUntil: "2026-09-21T10:00:05.000Z",
    vendorActive: 0,
    vendorLimit: 1,
  };
  const result = await assertSeatFree(
    {
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { licenseCapacity: capacity };
      },
    },
    "synthetic preflight",
  );
  assert.deepEqual(calls, [["refresh_license_capacity", {}]]);
  assert.deepEqual(result.capacity, capacity);
  assert.ok(Date.parse(result.completedAt) >= Date.parse(result.requestedAt));
});

test("rejects a local free count without fresh provider availability", async () => {
  let failure;
  await assert.rejects(
    assertSeatFree(
      {
        callTool: async () => ({
          licenseCapacity: {
            total: 1,
            free: 1,
            active: 0,
            pendingRecovery: 0,
            cooling: 0,
            availability: "unable-to-verify",
            reason: "CAPACITY_NOT_CHECKED",
          },
        }),
      },
      "synthetic unknown state",
    ),
    (error) => {
      failure = error;
      return /not ready/.test(error.message);
    },
  );
  assert.deepEqual(capacityCheckFromError(failure)?.capacity, {
    total: 1,
    free: 1,
    active: 0,
    pendingRecovery: 0,
    cooling: 0,
    availability: "unable-to-verify",
    reason: "CAPACITY_NOT_CHECKED",
  });
});

test("cleans a refused disposable app when no local seat recovery remains", async () => {
  const calls = [];
  const app = {
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === "get_runtime_info") {
        return {
          licenseCapacity: { total: 1, free: 0, active: 0, pendingRecovery: 0, cooling: 1 },
        };
      }
      return {};
    },
  };
  assert.equal(await recoverProfilesAndSeat(app, [{ id: "P1" }, { id: null }]), true);
  assert.deepEqual(calls, [
    ["close_profile", { profile_id: "P1" }],
    ["get_runtime_info", {}],
  ]);
});
