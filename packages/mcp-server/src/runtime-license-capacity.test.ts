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
