import assert from "node:assert/strict";
import test from "node:test";
import {
  sweepOrphanedProfileBrowsers,
  type OrphanSweepDeps,
  type OrphanSweepEvent,
} from "./startup-orphan-sweep.ts";

const ROOT = "C:/Users/operator/MKT Browser";
const browser = (pid: number, port: number | null) => ({
  pid,
  commandLine:
    `chrome.exe --user-data-dir="${ROOT}/p${pid}/engines/cloakbrowser"` +
    (port === null ? "" : ` --remote-debugging-port=${port}`),
});

function harness(overrides: Partial<OrphanSweepDeps> = {}) {
  const events: OrphanSweepEvent[] = [];
  const killedPids: number[] = [];
  const closedPorts: number[] = [];
  const alive = new Set<number>();
  const deps: OrphanSweepDeps = {
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      killedPids.push(pid);
      alive.delete(pid);
    },
    log: (e) => events.push(e),
    sleep: async () => {},
    closeViaCdp: async (port) => {
      closedPorts.push(port);
      // A polite close works: every process on that port goes away.
      alive.clear();
    },
    discoverPort: async (process) => {
      const match = process.commandLine.match(/--remote-debugging-port=(\d+)/);
      const port = Number(match?.[1]);
      return Number.isInteger(port) && port > 0 ? port : null;
    },
    closeBudgetMs: 20,
    ...overrides,
  };
  return { deps, events, killedPids, closedPorts, alive };
}

test("closes an orphan through its own DevTools port so the seat comes back", async () => {
  const h = harness({
    enumerate: async () => ({ processes: [browser(101, 9222)], enumerated: true }),
  });
  h.alive.add(101);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, [101]);
  assert.deepEqual(out.killed, []);
  assert.deepEqual(out.recoveries, [
    { pid: 101, profileId: "p101", seatReleased: true },
  ]);
  assert.deepEqual(h.closedPorts, [9222]);
  assert.deepEqual(
    h.killedPids,
    [],
    "a kill here would keep the licence seat, defeating the sweep",
  );
  assert.equal(h.events[0]?.reason, "ORPHAN-SWEEP-CLOSED");
});

test("kills only when the polite close is impossible, and says which it was", async () => {
  // No port on the command line: there is no polite option, so the seat is lost and the log has
  // to say so rather than reporting a clean sweep.
  const noPort = harness({
    enumerate: async () => ({ processes: [browser(102, null)], enumerated: true }),
  });
  noPort.alive.add(102);
  const a = await sweepOrphanedProfileBrowsers(ROOT, noPort.deps);
  assert.deepEqual(a.killed, [102]);
  assert.deepEqual(a.recoveries, [
    { pid: 102, profileId: "p102", seatReleased: false },
  ]);
  assert.equal(noPort.events[0]?.reason, "ORPHAN-SWEEP-KILLED");
  assert.match(String(noPort.events[0]?.detail), /no owned DevTools port/);

  // Port present but the browser ignores Browser.close.
  const stubborn = harness({
    enumerate: async () => ({ processes: [browser(103, 9333)], enumerated: true }),
    closeViaCdp: async () => {},
  });
  stubborn.alive.add(103);
  const b = await sweepOrphanedProfileBrowsers(ROOT, stubborn.deps);
  assert.deepEqual(b.killed, [103]);
  assert.match(String(stubborn.events[0]?.detail), /still alive/);

  // The CDP call itself throws.
  const broken = harness({
    enumerate: async () => ({ processes: [browser(104, 9444)], enumerated: true }),
    closeViaCdp: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  broken.alive.add(104);
  const c = await sweepOrphanedProfileBrowsers(ROOT, broken.deps);
  assert.deepEqual(c.killed, [104]);
  assert.match(String(broken.events[0]?.detail), /Browser\.close failed/);

  const undiscoverable = harness({
    enumerate: async () => ({ processes: [browser(105, 0)], enumerated: true }),
    discoverPort: async () => {
      throw new Error("process query failed");
    },
  });
  undiscoverable.alive.add(105);
  const d = await sweepOrphanedProfileBrowsers(ROOT, undiscoverable.deps);
  assert.deepEqual(d.killed, [105]);
  assert.deepEqual(undiscoverable.closedPorts, []);
  assert.match(String(undiscoverable.events[0]?.detail), /port discovery failed/);
});

test("bounds a polite close request that never settles before opening the launch barrier", async () => {
  let closeSignal: AbortSignal | undefined;
  const h = harness({
    enumerate: async () => ({ processes: [browser(106, 9555)], enumerated: true }),
    closeViaCdp: async (_port, signal) => {
      closeSignal = signal;
      await new Promise<void>(() => {});
    },
  });
  h.alive.add(106);
  const startedAt = Date.now();

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.killed, [106]);
  assert.equal(closeSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 500, "hung CDP close escaped its startup budget");
  assert.match(String(h.events[0]?.detail), /request timed out after \d+ms/);
});

test("does nothing at all when the process table could not be read", async () => {
  // "Could not look" is not "nothing there". Guessing here could take down a live profile.
  const h = harness({ enumerate: async () => ({ processes: [], enumerated: false }) });
  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);
  assert.equal(out.enumerated, false);
  assert.deepEqual(h.killedPids, []);
  assert.deepEqual(h.closedPorts, []);
  assert.equal(h.events[0]?.reason, "ORPHAN-SWEEP-DISCOVERY-FAILED");
});

test("leaves renderers and helpers to die with their parent", async () => {
  const renderer = {
    pid: 201,
    commandLine: `chrome.exe --type=renderer --user-data-dir="${ROOT}/p1/engines/cloakbrowser"`,
  };
  const h = harness({
    enumerate: async () => ({ processes: [renderer, browser(202, 9222)], enumerated: true }),
  });
  h.alive.add(201);
  h.alive.add(202);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, [202]);
  assert.equal(h.killedPids.includes(201), false, "a renderer has no browser to close");
});

test("recovers an OS-assigned port for an orphan whose command line contains port zero", async () => {
  const orphan = browser(250, 0);
  const h = harness({
    enumerate: async () => ({ processes: [orphan], enumerated: true }),
    discoverPort: async (process, ownedPids) => {
      assert.equal(process.pid, 250);
      assert.equal(ownedPids.has(250), true);
      return 55497;
    },
  });
  h.alive.add(250);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, [250]);
  assert.deepEqual(h.closedPorts, [55497]);
  assert.deepEqual(h.killedPids, []);
});

test("never touches a PID the app already owns", async () => {
  const h = harness({
    enumerate: async () => ({ processes: [browser(301, 9222)], enumerated: true }),
    excludePids: [301],
  });
  h.alive.add(301);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, []);
  assert.deepEqual(h.killedPids, []);
  assert.equal(h.events[0]?.reason, "ORPHAN-SWEEP-NONE");
});

test("reports an empty sweep without pretending it failed", async () => {
  const h = harness({ enumerate: async () => ({ processes: [], enumerated: true }) });
  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);
  assert.equal(out.enumerated, true);
  assert.deepEqual(out.closed, []);
  assert.equal(h.events[0]?.reason, "ORPHAN-SWEEP-NONE");
});

test("does not create licence recovery evidence for a non-CloakBrowser layout", async () => {
  const cft = {
    pid: 401,
    commandLine: `chrome.exe --user-data-dir="${ROOT}/p401" --remote-debugging-port=9222`,
  };
  const nested = {
    pid: 402,
    commandLine:
      `chrome.exe --user-data-dir="${ROOT}/p402/nested/engines/cloakbrowser"` +
      " --remote-debugging-port=9223",
  };
  const h = harness({
    enumerate: async () => ({ processes: [cft, nested], enumerated: true }),
  });
  h.alive.add(401);
  h.alive.add(402);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, [401, 402]);
  assert.deepEqual(out.recoveries, []);
});
