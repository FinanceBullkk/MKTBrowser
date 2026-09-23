import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeLicenseCapacity } from "./runtime-license-capacity.js";
import { buildRuntimeInfo } from "./server.js";

test("returns only a complete measured license capacity summary", async () => {
  const measured = {
    total: 4,
    free: 1,
    active: 1,
    pendingRecovery: 1,
    cooling: 1,
    keyFingerprint: "must-not-cross-the-runtime-boundary",
    profileId: "profile-secret",
  };
  assert.deepEqual(await resolveRuntimeLicenseCapacity(async () => measured), {
    total: 4,
    free: 1,
    active: 1,
    pendingRecovery: 1,
    cooling: 1,
  });

  assert.equal(
    await resolveRuntimeLicenseCapacity(async () => ({ ...measured, free: 2 })),
    null,
  );
  assert.equal(
    await resolveRuntimeLicenseCapacity(async () => {
      throw new Error("journal unavailable");
    }),
    null,
  );
});

test("includes measured capacity in the authenticated runtime report", async () => {
  const measured = { total: 2, free: 0, active: 1, pendingRecovery: 1, cooling: 0 };
  const runtime = await buildRuntimeInfo({
    appVersion: "0.3.12",
    licenseCapacity: async () => measured,
  });

  assert.deepEqual(runtime.licenseCapacity, measured);
});

test("reports the fail-closed local-install snapshot before advertising readiness", async () => {
  for (const readiness of ["checking", "failed", "unavailable", "ready"] as const) {
    const runtime = await buildRuntimeInfo({
      localInstallReadiness: () => readiness,
      // A generic capability provider cannot bypass the current install snapshot.
      runtimeCapabilities: () => ["local-install-ready-v1"],
    });

    assert.equal(runtime.localInstallReadiness, readiness);
    assert.equal(runtime.capabilities.includes("install-readiness-v1"), true);
    assert.equal(runtime.capabilities.includes("local-install-ready-v1"), readiness === "ready");
  }

  let current: "ready" | "checking" = "ready";
  const provider = () => current;
  let runtime = await buildRuntimeInfo({ localInstallReadiness: provider });
  assert.equal(runtime.localInstallReadiness, "ready");
  assert.equal(runtime.capabilities.includes("local-install-ready-v1"), true);

  current = "checking";
  runtime = await buildRuntimeInfo({ localInstallReadiness: provider });
  assert.equal(runtime.localInstallReadiness, "checking");
  assert.equal(runtime.capabilities.includes("local-install-ready-v1"), false);
});

test("preserves only a valid aggregate manual retry deadline", async () => {
  const measured = { total: 1, free: 0, active: 0, pendingRecovery: 0, cooling: 1,
    retryAt: "2026-09-21T04:30:00.000Z" };
  const runtime = await buildRuntimeInfo({ licenseCapacity: () => ({ ...measured, key: "secret" }) });
  assert.deepEqual(runtime.licenseCapacity, measured);
  for (const retryAt of ["invalid", "2026-02-30T04:30:00.000Z", 123, null]) {
    assert.equal(await resolveRuntimeLicenseCapacity(() => ({ ...measured, retryAt })), null);
  }
  assert.equal(await resolveRuntimeLicenseCapacity(() => ({ ...measured, free: 1, cooling: 0 })), null);
});

test("preserves only complete sanitized availability and vendor observation pairs", async () => {
  const measured = {
    total: 1,
    free: 1,
    active: 0,
    pendingRecovery: 0,
    cooling: 0,
    availability: "ready",
    reason: "CAPACITY_AVAILABLE",
    observedAt: "2026-09-21T05:00:00.000Z",
    freshUntil: "2026-09-21T05:00:05.000Z",
    vendorActive: 0,
    vendorLimit: 1,
    keyFingerprint: "must-not-cross-the-runtime-boundary",
  };
  assert.deepEqual(await resolveRuntimeLicenseCapacity(() => measured), {
    total: 1,
    free: 1,
    active: 0,
    pendingRecovery: 0,
    cooling: 0,
    availability: "ready",
    reason: "CAPACITY_AVAILABLE",
    observedAt: "2026-09-21T05:00:00.000Z",
    freshUntil: "2026-09-21T05:00:05.000Z",
    vendorActive: 0,
    vendorLimit: 1,
  });

  for (const invalid of [
    { ...measured, reason: undefined },
    { ...measured, availability: "free" },
    { ...measured, reason: "provider said yes" },
    { ...measured, freshUntil: undefined },
    { ...measured, freshUntil: "2026-09-21T04:59:59.000Z" },
    { ...measured, vendorLimit: undefined },
    { ...measured, vendorActive: 2 },
    { ...measured, observedAt: undefined, freshUntil: undefined },
  ]) {
    assert.equal(await resolveRuntimeLicenseCapacity(() => invalid), null);
  }
});
