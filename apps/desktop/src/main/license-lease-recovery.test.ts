import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { recoverLicenseLeases } from "./license-lease-recovery.ts";

test("marks a lease released only after the recovery transport confirms release", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-recovery-"));
  const fullKey = "cb_live_secret_abcdef123456";

  try {
    const journal = await LicenseLeaseJournal.open(join(root, "leases.json"));
    const reserved = await journal.reserve({ profileId: "profile-a", key: fullKey });
    await journal.transition("profile-a", "starting", { childPid: 4123 });
    await journal.transition("profile-a", "active");

    const released: string[] = [];
    const summary = await recoverLicenseLeases(journal, {
      resolveProfile: async () => ({ status: "ready", value: { bridge: "profile-a" } }),
      resolveKey: async (fingerprint) =>
        fingerprint === reserved.keyFingerprint ? fullKey : null,
      release: async ({ record, key, profile }) => {
        assert.equal(record.profileId, "profile-a");
        assert.equal(key, fullKey);
        assert.equal(profile.bridge, "profile-a");
        released.push(record.profileId);
        return "confirmed";
      },
    });

    assert.deepEqual(released, ["profile-a"]);
    assert.deepEqual(summary, { confirmed: 1, pending: 0, skipped: 0 });
    assert.equal(journal.get("profile-a")?.state, "confirmed-released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a missing-profile lease pending without resolving a key or calling release", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-recovery-"));

  try {
    const journal = await LicenseLeaseJournal.open(join(root, "leases.json"));
    await journal.reserve({ profileId: "profile-missing", key: "cb_live_secret_abcdef123456" });
    await journal.transition("profile-missing", "starting");
    await journal.transition("profile-missing", "active");
    let keyResolutions = 0;
    let releaseCalls = 0;

    const summary = await recoverLicenseLeases(journal, {
      resolveProfile: async () => ({ status: "missing" }),
      resolveKey: async () => {
        keyResolutions += 1;
        return "should-not-be-read";
      },
      release: async () => {
        releaseCalls += 1;
        return "confirmed";
      },
    });

    assert.equal(keyResolutions, 0);
    assert.equal(releaseCalls, 0);
    assert.deepEqual(summary, { confirmed: 0, pending: 1, skipped: 0 });
    assert.equal(journal.get("profile-missing")?.state, "pending-recovery");
    assert.equal(journal.get("profile-missing")?.lastErrorCode, "PROFILE_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("releases an unstarted reservation locally without calling vendor recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-recovery-"));

  try {
    const journal = await LicenseLeaseJournal.open(join(root, "leases.json"));
    await journal.reserve({ profileId: "profile-never-started", key: "cb_live_secret_abcdef123456" });
    let dependencyCalls = 0;

    const summary = await recoverLicenseLeases(journal, {
      resolveProfile: async () => {
        dependencyCalls += 1;
        return { status: "missing" };
      },
      resolveKey: async () => {
        dependencyCalls += 1;
        return null;
      },
      release: async () => {
        dependencyCalls += 1;
        return "retry";
      },
    });

    assert.equal(dependencyCalls, 0);
    assert.deepEqual(summary, { confirmed: 1, pending: 0, skipped: 0 });
    assert.equal(journal.get("profile-never-started")?.state, "confirmed-released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps concurrent profile recovery isolated when one release is unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-lease-recovery-"));
  const keys = new Map([
    ["profile-a", "cb_live_secret_aaaaaa111111"],
    ["profile-b", "cb_live_secret_bbbbbb222222"],
  ]);

  try {
    const journal = await LicenseLeaseJournal.open(join(root, "leases.json"));
    const fingerprintToKey = new Map<string, string>();
    for (const [profileId, key] of keys) {
      const record = await journal.reserve({ profileId, key });
      fingerprintToKey.set(record.keyFingerprint, key);
      await journal.transition(profileId, "starting");
      await journal.transition(profileId, "active");
    }

    const attempts: string[] = [];
    const summary = await recoverLicenseLeases(journal, {
      resolveProfile: async (profileId) => ({ status: "ready", value: { profileId } }),
      resolveKey: async (fingerprint) => fingerprintToKey.get(fingerprint) ?? null,
      release: async ({ record, key, profile }) => {
        assert.equal(profile.profileId, record.profileId);
        assert.equal(key, keys.get(record.profileId));
        attempts.push(record.profileId);
        return record.profileId === "profile-a" ? "confirmed" : "retry";
      },
    });

    assert.deepEqual(attempts, ["profile-a", "profile-b"]);
    assert.deepEqual(summary, { confirmed: 1, pending: 1, skipped: 0 });
    assert.equal(journal.get("profile-a")?.state, "confirmed-released");
    assert.equal(journal.get("profile-b")?.state, "pending-recovery");
    assert.equal(journal.get("profile-b")?.lastErrorCode, "RELEASE_UNCONFIRMED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
