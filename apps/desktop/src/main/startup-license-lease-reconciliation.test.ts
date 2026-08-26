import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LICENSE_SEAT_COOLDOWN_MS, LicenseKeyPool } from "./license-key-pool.ts";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import { reconcileStartupOrphanLeases } from "./startup-license-lease-reconciliation.ts";

const KEY = "cb_live_secret_abcdef123456";
/** When the launch that left the lease behind happened. */
const LEASE_AT = Date.parse("2026-08-26T09:00:00.000Z");

/** A lease left `active` by a run that never got to close its browser, as the next start finds it. */
async function activeLeaseFixture(startedAtMs = LEASE_AT) {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-startup-lease-"));
  const clock = { t: LEASE_AT };
  const journal = await LicenseLeaseJournal.open(join(root, "leases.json"), { now: () => clock.t });
  await journal.reserve({ profileId: "profile-a", key: KEY });
  await journal.transition("profile-a", "starting");
  await journal.transition("profile-a", "active");

  clock.t = startedAtMs;
  const now = () => clock.t;
  return {
    root,
    clock,
    now,
    journal,
    cooldownMs: LICENSE_SEAT_COOLDOWN_MS,
    pool: new LicenseKeyPool({
      keys: [KEY],
      cooldownMs: LICENSE_SEAT_COOLDOWN_MS,
      now,
      leaseRecords: journal.snapshot(),
    }),
    recorder: new LicenseLeaseRecorder(journal),
  };
}

/** A sweep that read the process table and found no browser at all. */
const SWEPT_CLEAN = { closed: [], killed: [], enumerated: true, recoveries: [] };
/** A sweep that could not read the process table, so its silence proves nothing. */
const SWEEP_BLIND = { closed: [], killed: [], enumerated: false, recoveries: [] };

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

    assert.deepEqual(summary, { confirmed: 1, cooling: 0, expired: 0, pending: 0, skipped: 0 });
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

    assert.deepEqual(summary, { confirmed: 0, cooling: 1, expired: 0, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "cooling");
    assert.equal(fixture.pool.capacitySnapshot(fixture.journal.snapshot()).cooling, 1);
    assert.equal(
      fixture.pool.nextFreeAtMs(),
      fixture.clock.t + fixture.cooldownMs,
      "a killed orphan died just now, so its seat rests a full cooldown from now",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a verdict about a profile this journal never leased is skipped", async () => {
  const fixture = await activeLeaseFixture();
  try {
    const summary = await reconcileStartupOrphanLeases(
      {
        closed: [201],
        killed: [],
        // Blind, so profile-a's own lease is left for the cases below rather than settled here.
        enumerated: false,
        recoveries: [{ pid: 201, profileId: "profile-missing", seatReleased: true }],
      },
      fixture,
    );

    assert.deepEqual(summary, { confirmed: 0, cooling: 0, expired: 0, pending: 0, skipped: 1 });
    assert.equal(fixture.journal.get("profile-a")?.state, "active");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a durable write that fails leaves the lease pending rather than freeing the key", async () => {
  const fixture = await activeLeaseFixture();
  try {
    const logged: string[] = [];
    const summary = await reconcileStartupOrphanLeases(
      {
        closed: [202],
        killed: [],
        enumerated: false,
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

    assert.deepEqual(summary, { confirmed: 0, cooling: 0, expired: 0, pending: 1, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "active");
    assert.equal(fixture.pool.capacitySnapshot(fixture.journal.snapshot()).pendingRecovery, 1);
    assert.match(logged[0] ?? "", /startup lease reconciliation failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a reboot settles the lease no sweep can reach, and the wait ends on the vendor's clock", async () => {
  // The defect this closes: the browser died with the machine, so no orphan survives for the sweep
  // to find, no recovery is ever reported, and the key was held back with no deadline for ever.
  const bootedAtMs = LEASE_AT + 30 * 60_000;
  const fixture = await activeLeaseFixture(bootedAtMs + 2 * 60_000);
  try {
    assert.equal(fixture.pool.acquire("profile-b"), null, "held back before any verdict");
    assert.equal(fixture.pool.nextFreeAtMs(), null, "and with no deadline to report");

    const summary = await reconcileStartupOrphanLeases(SWEPT_CLEAN, { ...fixture, bootedAtMs });

    assert.deepEqual(summary, { confirmed: 0, cooling: 1, expired: 0, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "cooling");
    assert.equal(
      fixture.pool.nextFreeAtMs(),
      bootedAtMs + fixture.cooldownMs,
      "the seat rests from the boot that killed the browser, not from this start",
    );

    fixture.clock.t = bootedAtMs + fixture.cooldownMs;
    assert.equal(fixture.pool.availableCount(), 1, "and the key comes back on its own");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a lease whose rest ran out before this start is retired, not rested again", async () => {
  // Written as `cooling` it would be stamped with this moment, and the next start would read that
  // stamp as the beginning of the rest — a fresh lockout for every restart of the app.
  const bootedAtMs = LEASE_AT + 30 * 60_000;
  const fixture = await activeLeaseFixture(bootedAtMs + LICENSE_SEAT_COOLDOWN_MS + 60_000);
  try {
    const summary = await reconcileStartupOrphanLeases(SWEPT_CLEAN, { ...fixture, bootedAtMs });

    assert.deepEqual(summary, { confirmed: 0, cooling: 0, expired: 1, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "expired");
    assert.notEqual(fixture.pool.acquire("profile-b"), null, "the seat is free now");

    const nextStart = new LicenseKeyPool({
      keys: [KEY],
      cooldownMs: fixture.cooldownMs,
      now: fixture.now,
      leaseRecords: fixture.journal.snapshot(),
    });
    assert.equal(nextStart.availableCount(), 1, "and reopening the app must not rest it again");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("within one boot session a swept-clean process table rests the seat from now", async () => {
  // No restart, so nothing dates the browser's death: it could have been a moment ago, and the
  // vendor may still be counting the seat for a full lease.
  const fixture = await activeLeaseFixture(LEASE_AT + 60 * 60_000);
  try {
    const summary = await reconcileStartupOrphanLeases(SWEPT_CLEAN, {
      ...fixture,
      bootedAtMs: LEASE_AT - 60 * 60_000,
    });

    assert.deepEqual(summary, { confirmed: 0, cooling: 1, expired: 0, pending: 0, skipped: 0 });
    assert.equal(fixture.pool.nextFreeAtMs(), fixture.clock.t + fixture.cooldownMs);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a sweep that could not look leaves the lease exactly as it found it", async () => {
  const fixture = await activeLeaseFixture(LEASE_AT + 60 * 60_000);
  try {
    const summary = await reconcileStartupOrphanLeases(SWEEP_BLIND, {
      ...fixture,
      bootedAtMs: LEASE_AT - 60 * 60_000,
    });

    assert.deepEqual(summary, { confirmed: 0, cooling: 0, expired: 0, pending: 0, skipped: 0 });
    assert.equal(fixture.journal.get("profile-a")?.state, "active");
    assert.equal(fixture.pool.acquire("profile-b"), null, "an unread process table frees nothing");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
