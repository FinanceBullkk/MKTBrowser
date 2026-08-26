import assert from "node:assert/strict";
import test from "node:test";
import { LicenseKeyPool, keyTail } from "./license-key-pool.ts";
import { fingerprintLicenseKey } from "./license-lease-journal.ts";

const KEYS = ["cb_aaaaaa111111", "cb_bbbbbb222222", "cb_cccccc333333"];

function poolAt(clock: { t: number }, keys = KEYS, cooldownMs = 1000) {
  return new LicenseKeyPool({ keys, cooldownMs, now: () => clock.t });
}

test("hands each profile its own key and reports what is left", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);

  const a = pool.acquire("p1");
  const b = pool.acquire("p2");

  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.notEqual(a, b, "two profiles must never share one key — the engine allows one session each");
  assert.equal(pool.availableCount(), 1);
  assert.equal(pool.keyFor("p1"), a);
});

test("re-acquiring for the same profile returns the same key", () => {
  // A retry after a failed launch must not silently burn a second seat on the same profile.
  const clock = { t: 0 };
  const pool = poolAt(clock);
  const first = pool.acquire("p1");
  assert.equal(pool.acquire("p1"), first);
  assert.equal(pool.availableCount(), KEYS.length - 1);
});

test("returns null rather than overbooking when every key is taken", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);
  for (let i = 0; i < KEYS.length; i++) assert.notEqual(pool.acquire("p" + i), null);
  assert.equal(pool.acquire("one-too-many"), null);
  assert.equal(pool.availableCount(), 0);
});

test("a clean close frees the key at once, an unclean one rests it", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);

  const clean = pool.acquire("p1");
  pool.release("p1", true);
  assert.equal(pool.availableCount(), KEYS.length, "Browser.close returns the seat immediately");
  assert.equal(pool.acquire("p2"), clean, "and the same key can go straight back out");
  pool.release("p2", true);

  // A close that reached SIGKILL leaves the seat held on the server. Handing the key out again
  // would send the next launch at a seat that is not actually free.
  pool.acquire("p3");
  pool.release("p3", false);
  assert.equal(pool.availableCount(), KEYS.length - 1);
  assert.equal(pool.snapshot().cooling, 1);

  clock.t += 1000;
  assert.equal(pool.availableCount(), KEYS.length, "and it comes back when the lease expires");
});

test("a refused key rests, so the next launch tries a different one", () => {
  // The pool's view can be stale: a seat may be held by a crashed browser or another machine.
  // Exit 76 is the correction, and rotation is what makes it useful.
  const clock = { t: 0 };
  const pool = poolAt(clock);

  const first = pool.acquire("p1");
  assert.notEqual(first, null);
  pool.markRefused(first!);

  const second = pool.acquire("p1");
  assert.notEqual(second, null);
  assert.notEqual(second, first, "a refused key must not be handed straight back");
  assert.equal(pool.snapshot().cooling, 1);

  clock.t += 1000;
  assert.equal(pool.snapshot().cooling, 0);
});

test("drops blanks and duplicates instead of advertising seats that do not exist", () => {
  // The same key twice is still one session. Counting it twice would promise capacity the engine
  // refuses, after the operator was told it was free.
  const clock = { t: 0 };
  const pool = poolAt(clock, ["cb_one", "  cb_one  ", "", "   ", "cb_two"]);
  assert.equal(pool.snapshot().total, 2);
  assert.equal(pool.availableCount(), 2);
});

test("never exposes a whole key", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);
  pool.acquire("p1");
  const snap = pool.snapshot();
  for (const k of snap.keys) {
    assert.equal(k.keyTail.length <= 6, true);
    for (const full of KEYS) assert.equal(k.keyTail === full, false);
  }
  assert.equal(JSON.stringify(snap).includes(KEYS[0]!), false, "a snapshot travels over IPC");
  assert.equal(keyTail("short"), "*****");
  assert.equal(keyTail("cb_aaaaaa111111"), "111111");
});

test("an empty pool is a valid state, not a crash", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock, []);
  assert.equal(pool.acquire("p1"), null);
  assert.equal(pool.availableCount(), 0);
  assert.equal(pool.snapshot().total, 0);
});

test("releasing a profile that holds nothing changes nothing", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);
  pool.release("never-launched", false);
  assert.equal(pool.availableCount(), KEYS.length);
});

test("capacity never counts pending recovery or cooling keys as free", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);
  const activeKey = pool.acquire("profile-active");
  const coolingKey = pool.acquire("profile-cooling");
  assert.notEqual(activeKey, null);
  assert.notEqual(coolingKey, null);
  pool.release("profile-cooling", false);

  const capacity = pool.capacitySnapshot([
    {
      keyFingerprint: fingerprintLicenseKey(KEYS[2]!),
      state: "pending-recovery",
    },
    {
      keyFingerprint: fingerprintLicenseKey(activeKey!),
      state: "active",
    },
  ]);

  assert.deepEqual(capacity, {
    total: 3,
    free: 0,
    active: 1,
    pendingRecovery: 1,
    cooling: 1,
  });
  assert.equal(JSON.stringify(capacity).includes(KEYS[0]!), false);
});

test("capacity treats an unreconciled reservation as pending instead of free", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock);

  assert.deepEqual(
    pool.capacitySnapshot([
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "reserved",
      },
    ]),
    {
      total: 3,
      free: 2,
      active: 0,
      pendingRecovery: 1,
      cooling: 0,
    },
  );
});

test("a lease left unreleased by an earlier run starts its key cooling, not idle", () => {
  // The bug this exists to stop: the pool was rebuilt from settings alone, so a seat the vendor was
  // still counting came back as `idle`, the next launch picked it, and the engine refused it.
  const clock = { t: 10 * 60_000 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "pending-recovery",
        updatedAt: new Date(clock.t - 60_000).toISOString(),
      },
    ],
  });

  assert.equal(pool.availableCount(), 2);
  assert.equal(pool.snapshot().keys[0]!.state, "cooling");
  assert.notEqual(pool.acquire("p1"), KEYS[0], "a resting key must not be handed out");
});

test("cooling is counted from when the lease last moved, not from startup", () => {
  // A lease that went quiet 16 minutes before this process started has one minute left, not
  // seventeen. Measuring from startup would punish every restart with a full fresh lease.
  const clock = { t: 100 * 60_000 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "cooling",
        updatedAt: new Date(clock.t - 16 * 60_000).toISOString(),
      },
    ],
  });

  assert.equal(pool.availableCount(), 2);
  clock.t += 61_000;
  assert.equal(pool.availableCount(), 3, "the key must return on the vendor's clock");
});

test("an old active record never expires by timestamp because the browser may have kept heartbeating", () => {
  const clock = { t: 100 * 60_000 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "active",
        updatedAt: new Date(clock.t - 60 * 60_000).toISOString(),
      },
    ],
  });

  assert.equal(pool.availableCount(), 2, "an orphan may have heartbeated after the old journal time");
  clock.t += 16 * 60_000;
  assert.equal(pool.availableCount(), 2);
  clock.t += 60 * 60_000;
  assert.equal(pool.availableCount(), 2, "only explicit recovery may free an active record");
});

test("a confirmed release and an unstarted reservation both leave the key idle", () => {
  // `confirmed-released` proves the seat came back. `reserved` never reached the engine, so no
  // session was ever opened — resting either one would withhold capacity the operator has.
  const clock = { t: 0 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "confirmed-released",
        updatedAt: new Date(clock.t).toISOString(),
      },
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[1]!),
        state: "reserved",
        updatedAt: new Date(clock.t).toISOString(),
      },
    ],
  });

  assert.equal(pool.availableCount(), 3);
});

test("nextFreeAtMs names the wait only when every key is resting", () => {
  const clock = { t: 0 };
  const pool = poolAt(clock, [KEYS[0]!], 1000);

  assert.equal(pool.nextFreeAtMs(), null, "a free key is not a wait");

  pool.acquire("p1");
  assert.equal(pool.nextFreeAtMs(), null, "a key held by an open profile has no deadline");

  pool.release("p1", false);
  assert.equal(pool.nextFreeAtMs(), 1000);

  clock.t = 1000;
  assert.equal(pool.nextFreeAtMs(), null, "the cooldown has run");
});

test("a reconciled lease rests from when its browser actually died", () => {
  // A restart is the one death this app can date: nothing survives a boot, so the vendor's clock
  // started then and not when the operator happened to reopen the app.
  const clock = { t: 100 * 60_000 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "active",
        updatedAt: new Date(clock.t - 60 * 60_000).toISOString(),
      },
    ],
  });
  assert.equal(pool.availableCount(), 2, "held back until a verdict arrives");

  const bootedAtMs = clock.t - 5 * 60_000;
  pool.reconcilePersistedLease(fingerprintLicenseKey(KEYS[0]!), false, bootedAtMs);

  assert.equal(pool.nextFreeAtMs(), null, "other keys are free, so there is no wait to name");
  assert.equal(pool.snapshot().keys[0]!.cooldownEndsAt, new Date(bootedAtMs + 17 * 60_000).toISOString());
  clock.t = bootedAtMs + 17 * 60_000;
  assert.equal(pool.availableCount(), 3, "and it returns 17 minutes after the boot, not after this start");
});

test("a reconciled lease whose rest already ran out returns its key at once", () => {
  const clock = { t: 100 * 60_000 };
  const pool = new LicenseKeyPool({
    keys: KEYS,
    cooldownMs: 17 * 60_000,
    now: () => clock.t,
    leaseRecords: [
      {
        keyFingerprint: fingerprintLicenseKey(KEYS[0]!),
        state: "active",
        updatedAt: new Date(clock.t - 90 * 60_000).toISOString(),
      },
    ],
  });

  pool.reconcilePersistedLease(fingerprintLicenseKey(KEYS[0]!), false, clock.t - 60 * 60_000);

  assert.equal(pool.availableCount(), 3);
  assert.equal(pool.snapshot().keys[0]!.state, "idle");
});
