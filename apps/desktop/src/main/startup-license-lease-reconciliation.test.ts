import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseKeyPool } from "./license-key-pool.ts";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import { reconcileStartupOrphanLeases } from "./startup-license-lease-reconciliation.ts";

async function activeLeaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-startup-lease-"));
  const journal = await LicenseLeaseJournal.open(join(root, "leases.json"));
  const key = "cb_live_secret_abcdef123456";
  await journal.reserve({ profileId: "profile-a", key });
  await journal.transition("profile-a", "starting");
  await journal.transition("profile-a", "active");
  const pool = new LicenseKeyPool({ keys: [key], leaseRecords: journal.snapshot() });
  return {
    root,
    journal,
    pool,
    recorder: new LicenseLeaseRecorder(journal),
  };
}

test("confirms a startup lease only after Browser.close ended its exact orphan", async () => {
  const fixture = await activeLeaseFixture();
  try {
    assert.equal(fixture.pool.capacitySnapshot(fixture.journal.snapshot()).pendingRecovery, 1);

    const summary = await reconcileStartupOrphanLeases(
      {
        closed: [101],
        killed: [],
        enumerated: true,
        recoveries: [{ pid: 101, profileId: "profile-a", seatReleased: true }],
      },
      fixture,
    );

    assert.deepEqual(summary, { confirmed: 1, cooling: 0, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "confirmed-released");
    assert.deepEqual(fixture.pool.capacitySnapshot(fixture.journal.snapshot()), {
      total: 1,
      free: 1,
      active: 0,
      pendingRecovery: 0,
      cooling: 0,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps a startup lease cooling when the orphan required a hard kill", async () => {
  const fixture = await activeLeaseFixture();
  try {
    const summary = await reconcileStartupOrphanLeases(
      {
        closed: [],
        killed: [101],
        enumerated: true,
        recoveries: [{ pid: 101, profileId: "profile-a", seatReleased: false }],
      },
      fixture,
    );

    assert.deepEqual(summary, { confirmed: 0, cooling: 1, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "cooling");
    assert.equal(fixture.pool.capacitySnapshot(fixture.journal.snapshot()).cooling, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("leaves an unmatched or failed startup verdict pending", async () => {
  const fixture = await activeLeaseFixture();
  try {
    const logged: string[] = [];
    const missing = await reconcileStartupOrphanLeases(
      {
        closed: [201],
        killed: [],
        enumerated: true,
        recoveries: [{ pid: 201, profileId: "profile-missing", seatReleased: true }],
      },
      fixture,
    );
    assert.deepEqual(missing, { confirmed: 0, cooling: 0, pending: 0, skipped: 1 });

    const failed = await reconcileStartupOrphanLeases(
      {
        closed: [202],
        killed: [],
        enumerated: true,
        recoveries: [{ pid: 202, profileId: "profile-a", seatReleased: true }],
      },
      {
        ...fixture,
        recorder: {
          released: async () => {
            throw new Error("durable write failed");
          },
        },
        log: (message) => logged.push(message),
      },
    );

    assert.deepEqual(failed, { confirmed: 0, cooling: 0, pending: 1, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "active");
    assert.equal(fixture.pool.capacitySnapshot(fixture.journal.snapshot()).pendingRecovery, 1);
    assert.match(logged[0] ?? "", /startup lease reconciliation failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
