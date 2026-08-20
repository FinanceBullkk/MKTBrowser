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
    closeBudgetMs: 20,
    ...overrides,
  };
  return { deps, events, killedPids, closedPorts, alive };
}

test("closes an orphan through its own DevTools port so the seat comes back", async () => {
  const h = harness({ enumerate: async () => ({ processes: [browser(101, 9222)], enumerated: true }) });
  h.alive.add(101);

  const out = await sweepOrphanedProfileBrowsers(ROOT, h.deps);

  assert.deepEqual(out.closed, [101]);
  assert.deepEqual(out.killed, []);
  assert.deepEqual(h.closedPorts, [9222]);
  assert.deepEqual(h.killedPids, [], "a kill here would keep the licence seat, defeating the sweep");
  assert.equal(h.events[0]?.reason, "ORPHAN-SWEEP-CLOSED");
});

test("kills only when the polite close is impossible, and says which it was", async () => {
  // No port on the command line: there is no polite option, so the seat is lost and the log has
  // to say so rather than reporting a clean sweep.
  const noPort = harness({ enumerate: async () => ({ processes: [browser(102, null)], enumerated: true }) });
  noPort.alive.add(102);
  const a = await sweepOrphanedProfileBrowsers(ROOT, noPort.deps);
  assert.deepEqual(a.killed, [102]);
  assert.equal(noPort.events[0]?.reason, "ORPHAN-SWEEP-KILLED");
  assert.match(String(noPort.events[0]?.detail), /no DevTools port/);

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
