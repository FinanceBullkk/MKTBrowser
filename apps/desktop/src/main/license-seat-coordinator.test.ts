import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseCapacityObserver } from "./license-capacity-observer.ts";
import { LicenseKeyPool } from "./license-key-pool.ts";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import {
  LicenseSeatAdmissionError,
  LicenseSeatCoordinator,
} from "./license-seat-coordinator.ts";

async function fixture(active = 0, limit = 1) {
  const root = await mkdtemp(join(tmpdir(), "mkt-seat-coordinator-"));
  const clock = { wall: Date.now(), monotonic: 1_000 };
  const key = "cb_fixture_primary";
  const journal = await LicenseLeaseJournal.open(join(root, "leases.json"), {
    now: () => clock.wall,
  });
  const pool = new LicenseKeyPool({ keys: [key], cooldownMs: 60_000, now: () => clock.wall });
  const observer = new LicenseCapacityObserver({
    fetch: async () => new Response(JSON.stringify({ active, limit }), { status: 200 }),
    wallNow: () => clock.wall,
    monotonicNow: () => clock.monotonic,
  });
  const coordinator = new LicenseSeatCoordinator({
    pool,
    journal,
    observer,
    fastReuseEnabled: true,
  });
  return { root, clock, key, journal, pool, observer, coordinator };
}

test("fresh vendor availability retires a proven local cooling hold without claiming release", async () => {
  const f = await fixture();
  try {
    const recorder = new LicenseLeaseRecorder(f.journal);
    const key = f.pool.acquire("closed")!;
    await recorder.reserved("closed", key);
    await recorder.started("closed", 123);
    await recorder.active("closed");
    await recorder.released("closed", false);
    f.pool.release("closed", false);

    assert.equal(f.coordinator.snapshot().availability, "cooling");
    const refreshed = await f.coordinator.refresh();
    assert.equal(refreshed.availability, "ready");
    assert.equal(refreshed.free, 1);
    assert.equal(f.journal.get("closed")?.state, "expired");
    assert.equal(f.journal.get("closed")?.lastErrorCode, "FRESH_CAPACITY_AVAILABLE");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("occupied vendor capacity blocks before an engine attempt", async () => {
  const f = await fixture(1, 1);
  try {
    let attempts = 0;
    await assert.rejects(
      f.coordinator.runAdmission("p1", async () => {
        attempts += 1;
        return "launched";
      }),
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "VENDOR_CAPACITY_OCCUPIED",
    );
    assert.equal(attempts, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("duplicate admission is rejected immediately and never queued behind the first launch", async () => {
  const f = await fixture();
  try {
    let resolveFirst!: () => void;
    let attempts = 0;
    const first = f.coordinator.runAdmission("p1", async () => {
      attempts += 1;
      await new Promise<void>((resolve) => { resolveFirst = resolve; });
      return "p1";
    });

    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      f.coordinator.runAdmission("p2", async () => {
        attempts += 1;
        return "p2";
      }),
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "ADMISSION_BUSY",
    );
    assert.equal(attempts, 1);
    resolveFirst();
    assert.equal(await first, "p1");
    assert.equal(attempts, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("coalesces refresh end to end and never queues an admission behind it", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    let resolveFirst!: (response: Response) => void;
    const observer = new LicenseCapacityObserver({
      fetch: async () => {
        calls += 1;
        if (calls > 1) return jsonCapacity(0, 1);
        return await new Promise<Response>((resolve) => { resolveFirst = resolve; });
      },
    });
    const coordinator = new LicenseSeatCoordinator({
      pool: f.pool,
      journal: f.journal,
      observer,
      fastReuseEnabled: true,
    });

    const first = coordinator.refresh();
    const duplicate = coordinator.refresh();
    assert.equal(first, duplicate);
    assert.equal(calls, 1);

    let attempts = 0;
    await assert.rejects(
      coordinator.runAdmission("p1", async () => {
        attempts += 1;
        return "p1";
      }),
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "ADMISSION_BUSY",
    );
    assert.equal(attempts, 0);

    resolveFirst(jsonCapacity(0, 1));
    assert.equal((await first).availability, "ready");
    assert.equal((await duplicate).availability, "ready");

    assert.equal(await coordinator.runAdmission("p1", async () => {
      attempts += 1;
      return "p1";
    }), "p1");
    assert.equal(attempts, 1);
    assert.equal(calls, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("local one-session policy still blocks a second launch when vendor limit is greater than one", async () => {
  const f = await fixture(0, 4);
  try {
    await f.coordinator.runAdmission("p1", async () => "p1");
    assert.equal(f.pool.snapshot().inUse, 1);
    await assert.rejects(
      f.coordinator.runAdmission("p2", async () => "p2"),
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "LOCAL_SESSION_ACTIVE",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("state invalidation during a capacity request prevents a later engine attempt", async () => {
  const f = await fixture();
  try {
    let resolveResponse!: (response: Response) => void;
    const observer = new LicenseCapacityObserver({
      fetch: async () => await new Promise<Response>((resolve) => { resolveResponse = resolve; }),
    });
    const coordinator = new LicenseSeatCoordinator({
      pool: f.pool,
      journal: f.journal,
      observer,
      fastReuseEnabled: true,
    });
    let attempts = 0;
    const admission = coordinator.runAdmission("p1", async () => {
      attempts += 1;
      return "p1";
    });
    await new Promise((resolve) => setImmediate(resolve));
    coordinator.invalidate("close");
    resolveResponse(new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 }));

    await assert.rejects(
      admission,
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "LOCAL_STATE_CHANGED",
    );
    assert.equal(attempts, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("state invalidation while retiring a cooling hold prevents a later engine attempt", async () => {
  const f = await fixture();
  try {
    const recorder = new LicenseLeaseRecorder(f.journal);
    const key = f.pool.acquire("closed")!;
    await recorder.reserved("closed", key);
    await recorder.started("closed", 123);
    await recorder.active("closed");
    await recorder.released("closed", false);
    f.pool.release("closed", false);

    let retireStarted!: () => void;
    let finishRetire!: () => void;
    const started = new Promise<void>((resolve) => { retireStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishRetire = resolve; });
    const expireBlockingKeyLease = f.journal.expireBlockingKeyLease.bind(f.journal);
    f.journal.expireBlockingKeyLease = async (...args) => {
      retireStarted();
      await gate;
      return expireBlockingKeyLease(...args);
    };

    let attempts = 0;
    const admission = f.coordinator.runAdmission("p1", async () => {
      attempts += 1;
      return "p1";
    });
    await started;
    f.coordinator.invalidate("close");
    finishRetire();

    await assert.rejects(
      admission,
      (error: unknown) =>
        error instanceof LicenseSeatAdmissionError && error.reason === "LOCAL_STATE_CHANGED",
    );
    assert.equal(attempts, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rollback mode preserves local cooldown admission without calling the vendor observer", async () => {
  const f = await fixture();
  try {
    let observations = 0;
    const coordinator = new LicenseSeatCoordinator({
      pool: f.pool,
      journal: f.journal,
      observer: new LicenseCapacityObserver({
        fetch: async () => {
          observations += 1;
          throw new Error("rollback mode must not observe vendor capacity");
        },
      }),
      fastReuseEnabled: false,
    });

    assert.equal(await coordinator.runAdmission("p1", async () => "p1"), "p1");
    assert.equal(observations, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

function jsonCapacity(active: number, limit: number): Response {
  return new Response(JSON.stringify({ active, limit }), { status: 200 });
}
