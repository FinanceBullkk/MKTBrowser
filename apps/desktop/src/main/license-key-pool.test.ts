import assert from "node:assert/strict";
import test from "node:test";
import { LicenseKeyPool, keyTail } from "./license-key-pool.ts";

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
  assert.equal(keyTail("short"), "short");
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
