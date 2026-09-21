import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseCapacityObserver } from "./license-capacity-observer.ts";
import { LicenseKeyPool } from "./license-key-pool.ts";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import { LicenseSeatCoordinator } from "./license-seat-coordinator.ts";
import { reconcileStartupOrphanLeases } from "./startup-license-lease-reconciliation.ts";

// Load the production driver; only Electron and process launch are replaced in this test.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: "data:text/javascript,export const app = { getPath: () => '' };", shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const candidate = new URL(specifier.endsWith(".js") ? specifier.slice(0, -3) + ".ts" : `${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { ChromiumBrowserDriver } = await import("./ChromiumBrowserDriver.ts");
hooks.deregister();

async function fixture(
  keys = ["cb_fixture_primary"],
  coordinatorOptions?: {
    fetch: (input: string, init: RequestInit) => Promise<Response>;
    fastReuseEnabled?: boolean;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "mkt-licence-cooldown-"));
  const clock = { now: Date.now() };
  const journal = await LicenseLeaseJournal.open(join(root, "leases.json"), { now: () => clock.now });
  const pool = new LicenseKeyPool({ keys, cooldownMs: 1000, refusalCooldownMs: 2000, now: () => clock.now });
  const recorder = new LicenseLeaseRecorder(journal);
  const observer = coordinatorOptions
    ? new LicenseCapacityObserver({ fetch: coordinatorOptions.fetch })
    : undefined;
  const coordinator = observer
    ? new LicenseSeatCoordinator({
        pool,
        journal,
        observer,
        fastReuseEnabled: coordinatorOptions?.fastReuseEnabled ?? true,
      })
    : undefined;
  const driver = new ChromiumBrowserDriver({
    chromiumBootstrap: { getEngine: () => "cloakbrowser" } as never,
    profileManager: { get: () => ({ name: "Disposable fixture" }) } as never,
    licenseKeyPool: pool,
    licenseLeaseRecorder: recorder,
    licenseSeatCoordinator: coordinator,
    fastLicenseReuseEnabled: coordinatorOptions?.fastReuseEnabled,
    extensionStoreRoot: root,
  });
  const internals = driver as unknown as {
    releaseLicenseKey: (id: string, method: string, released?: boolean) => Promise<void>;
  };
  return { root, clock, journal, pool, recorder, observer, coordinator, driver, internals };
}

test("driver admission observes capacity, reserves durably, and makes one engine attempt", async () => {
  let observations = 0;
  const f = await fixture(["cb_fixture_primary"], {
    fetch: async () => {
      observations += 1;
      return new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 });
    },
  });
  try {
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      attempts += 1;
      return { id };
    } });

    assert.equal((await f.driver.launch("coordinated")).id, "coordinated");
    assert.equal(observations, 1);
    assert.equal(attempts, 1);
    assert.equal(f.journal.get("coordinated")?.state, "reserved");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reservation persistence failure prevents the engine attempt and releases memory capacity", async () => {
  const f = await fixture(["cb_fixture_primary"], {
    fetch: async () => new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 }),
  });
  try {
    Object.defineProperty(f.recorder, "reserved", {
      value: async () => { throw new Error("synthetic storage failure"); },
    });
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async () => {
      attempts += 1;
      return { id: "must-not-launch" };
    } });

    await assert.rejects(f.driver.launch("storage-failed"), /synthetic storage failure/);
    assert.equal(attempts, 0);
    assert.equal(f.pool.availableCount(), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("vendor refusal invalidates the observation and never retries the engine", async () => {
  const f = await fixture(["cb_fixture_primary"], {
    fetch: async () => new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 }),
  });
  try {
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      attempts += 1;
      await f.recorder.started(id, 123);
      throw Object.assign(new Error("synthetic vendor refusal"), { licenseExitCode: 76 });
    } });

    await assert.rejects(f.driver.launch("refused"), /Do not retry before/);
    assert.equal(attempts, 1);
    assert.equal(f.observer?.freshObservation(), null);
    assert.equal(f.journal.get("refused")?.state, "terminal-refused");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("close invalidates admission while capacity observation is pending", async () => {
  let resolveCapacity!: (response: Response) => void;
  const f = await fixture(["cb_fixture_primary"], {
    fetch: async () => await new Promise<Response>((resolve) => { resolveCapacity = resolve; }),
  });
  try {
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async () => {
      attempts += 1;
      return { id: "must-not-launch" };
    } });
    const launch = f.driver.launch("closing");
    await new Promise((resolve) => setImmediate(resolve));
    await f.driver.close("closing");
    resolveCapacity(new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 }));

    await assert.rejects(launch, /state changed while availability was checked/);
    assert.equal(attempts, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("closeAll cancels capacity admission before any engine attempt", async () => {
  let resolveCapacity!: (response: Response) => void;
  const f = await fixture(["cb_fixture_primary"], {
    fetch: async () => await new Promise<Response>((resolve) => { resolveCapacity = resolve; }),
  });
  try {
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async () => {
      attempts += 1;
      return { id: "must-not-launch" };
    } });
    const launch = f.driver.launch("closing-all");
    await new Promise((resolve) => setImmediate(resolve));
    const closing = f.driver.closeAll({ shutdown: true });
    resolveCapacity(new Response(JSON.stringify({ active: 0, limit: 1 }), { status: 200 }));

    await assert.rejects(launch, /state changed while availability was checked/);
    await closing;
    assert.equal(attempts, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Browser.close persists cooling and prevents any engine attempt before the deadline", async () => {
  const f = await fixture();
  try {
    const key = f.pool.acquire("closed")!;
    await f.recorder.reserved("closed", key);
    await f.recorder.started("closed", 123);
    await f.recorder.active("closed");
    await f.internals.releaseLicenseKey("closed", "Browser.close");
    assert.equal(f.journal.get("closed")?.state, "cooling");
    assert.equal(f.pool.capacitySnapshot(f.journal.snapshot()).free, 0);
    assert.equal(f.pool.capacitySnapshot(f.journal.snapshot()).retryAt, new Date(f.clock.now + 1000).toISOString());
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      attempts += 1;
      return { id };
    } });
    for (const elapsed of [0, 500, 999]) {
      f.clock.now = Date.parse(f.journal.get("closed")!.updatedAt) + elapsed;
      await assert.rejects(f.driver.launch("next"), /Do not retry before/);
    }
    assert.equal(attempts, 0);
    f.clock.now += 1;
    assert.equal((await f.driver.launch("next")).id, "next");
    assert.equal(attempts, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("refusal never rotates to another free key and survives restart with a longer wait", async () => {
  const f = await fixture(["cb_fixture_primary", "cb_fixture_second"]);
  try {
    let attempts = 0;
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      attempts += 1;
      await f.recorder.started(id, 123);
      throw Object.assign(new Error("synthetic vendor refusal"), { licenseExitCode: 76 });
    } });
    await assert.rejects(f.driver.launch("refused"), /No automatic retry/);
    assert.equal(attempts, 1);
    assert.equal(f.pool.availableCount(), 1);
    assert.equal(f.journal.get("refused")?.state, "terminal-refused");
    const restarted = new LicenseKeyPool({
      keys: ["cb_fixture_primary"], cooldownMs: 1000, refusalCooldownMs: 2000,
      now: () => f.clock.now, leaseRecords: f.journal.snapshot(),
    });
    f.clock.now += 1999;
    assert.equal(restarted.acquire("next"), null);
    f.clock.now += 1;
    assert.equal(restarted.acquire("next"), "cb_fixture_primary");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("pre-spawn failure releases only its unstarted reservation immediately", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.driver, "launchTracked", { value: async () => { throw new Error("profile missing"); } });
    await assert.rejects(f.driver.launch("unstarted"), /profile missing/);
    assert.equal(f.journal.get("unstarted")?.state, "confirmed-released");
    assert.equal(f.pool.availableCount(), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a transient refusal-write failure cannot downgrade the cooldown during cleanup", async () => {
  const f = await fixture();
  try {
    const transition = f.journal.transition.bind(f.journal);
    let refusedWrites = 0;
    f.journal.transition = async (...args) => {
      if (args[1] === "terminal-refused" && refusedWrites++ === 0) throw new Error("transient storage failure");
      return transition(...args);
    };
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      await f.recorder.started(id, 123);
      throw Object.assign(new Error("synthetic vendor refusal"), { licenseExitCode: 76 });
    } });
    await assert.rejects(f.driver.launch("refused"), /journal terminal-refused failed/);
    assert.equal(f.journal.get("refused")?.state, "terminal-refused");
    assert.equal(refusedWrites, 2, "cleanup retries only the durable write, never the engine launch");
    const reopenedJournal = await LicenseLeaseJournal.open(join(f.root, "leases.json"));
    const restarted = new LicenseKeyPool({
      keys: ["cb_fixture_primary"], cooldownMs: 1000, refusalCooldownMs: 2000,
      now: () => f.clock.now, leaseRecords: reopenedJournal.snapshot(),
    });
    assert.equal(restarted.nextFreeAtMs(), f.clock.now + 2000);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("repeated refusal-write failure keeps a conservative wait across two restarts", async () => {
  const f = await fixture();
  try {
    const transition = f.journal.transition.bind(f.journal);
    f.journal.transition = async (...args) => {
      if (args[1] === "terminal-refused") throw new Error("storage unavailable");
      return transition(...args);
    };
    Object.defineProperty(f.driver, "launchTracked", { value: async (id: string) => {
      await f.recorder.started(id, 123);
      throw Object.assign(new Error("synthetic vendor refusal"), { licenseExitCode: 76 });
    } });
    await assert.rejects(f.driver.launch("refused"), /journal terminal-refused failed/);
    const journal = await LicenseLeaseJournal.open(join(f.root, "leases.json"), { now: () => f.clock.now });
    assert.equal(journal.get("refused")?.state, "starting");
    const options = { keys: ["cb_fixture_primary"], cooldownMs: 1000, refusalCooldownMs: 2000, now: () => f.clock.now };
    const pool = new LicenseKeyPool({ ...options, leaseRecords: journal.snapshot() });
    await reconcileStartupOrphanLeases({ enumerated: true, closed: [], killed: [], recoveries: [] }, {
      journal, pool, recorder: new LicenseLeaseRecorder(journal), now: options.now,
      cooldownMs: 1000, refusalCooldownMs: 2000,
    });
    assert.equal(journal.get("refused")?.lastErrorCode, "LICENCE_RELEASE_UNCONFIRMED");
    assert.equal(pool.nextFreeAtMs(), f.clock.now + 2000);
    const restarted = new LicenseKeyPool({ ...options, leaseRecords: journal.snapshot() });
    assert.equal(restarted.nextFreeAtMs(), pool.nextFreeAtMs());
    f.clock.now += 1000;
    assert.equal(restarted.acquire("next"), null);
    assert.equal(restarted.capacitySnapshot(journal.snapshot()).free, 0);
    f.clock.now += 1000;
    assert.equal(restarted.acquire("next"), "cb_fixture_primary");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
