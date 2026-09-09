import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserProcessInfo } from "./browser-process-discovery.ts";
import {
  clearStaleDevToolsActivePort,
  DevToolsPortDiscoveryError,
  parseDevToolsActivePort,
  waitForOwnedDevToolsEndpoint,
  type DevToolsPortDiscoveryDeps,
} from "./devtools-port-discovery.ts";

const DATA_DIR = "C:/MKT Browser/profile-1";

test("parses only the bounded Chromium DevToolsActivePort schema", () => {
  assert.deepEqual(parseDevToolsActivePort("55497\n/devtools/browser/session-id\n"), {
    port: 55497,
    browserWebSocketPath: "/devtools/browser/session-id",
  });

  for (const invalid of [
    "",
    "55497\n",
    "0\n/devtools/browser/session-id\n",
    "65536\n/devtools/browser/session-id\n",
    "55497\n/devtools/page/session-id\n",
    "55497\n/devtools/browser/session-id\nextra\n",
    "x".repeat(513),
  ]) {
    assert.throws(() => parseDevToolsActivePort(invalid));
  }
});

test("removes the crash-era record before launch and tolerates an already-clean profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-active-port-"));
  const activePortPath = join(root, "DevToolsActivePort");
  try {
    await writeFile(activePortPath, "55497\n/devtools/browser/stale\n", "utf8");
    await clearStaleDevToolsActivePort(root);
    await assert.rejects(stat(activePortPath), hasCode("ENOENT"));
    await clearStaleDevToolsActivePort(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticates a reappeared record by process and listener ownership, not file time", async () => {
  const clock = createClock();
  let reads = 0;
  const deps = harnessDeps(clock, {
    readActivePortRecord: async () => {
      reads += 1;
      return { contents: "55497\n/devtools/browser/current\n" };
    },
  });

  const result = await discover(deps, 250);

  assert.equal(reads, 1);
  assert.equal(result.port, 55497);
  assert.equal(result.primaryPid, 20);
  assert.equal(
    result.timings.totalMs,
    result.timings.activePortMs + result.timings.processMs + result.timings.ownershipMs,
  );
});

test("never attaches when the listener belongs to a foreign process", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock, { ownerPids: [999] });

  await assert.rejects(discover(deps, 220), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.equal(error.diagnostics.primaryPid, 20);
    assert.deepEqual(error.diagnostics.portOwnerPids, [999]);
    assert.deepEqual(error.diagnostics.processPids, [20]);
    return true;
  });
});

test("rejects a listener owner whose process identity changes between OS snapshots", async () => {
  const clock = createClock();
  let processReads = 0;
  const deps = harnessDeps(clock);
  deps.enumerateProcesses = async () => {
    processReads += 1;
    return {
      processes:
        processReads % 2 === 1
          ? [browser(20)]
          : [{ pid: 20, commandLine: `foreign.exe --user-data-dir="${DATA_DIR}"` }],
      enumerated: true,
    };
  };

  await assert.rejects(discover(deps, 220), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "process");
    assert.ok(processReads >= 2);
    return true;
  });
});

test("rejects a listener that changes owners during authentication", async () => {
  const clock = createClock();
  let ownerReads = 0;
  const deps = harnessDeps(clock);
  deps.enumeratePortOwners = async () => {
    ownerReads += 1;
    return { inspected: true, pids: ownerReads === 1 ? [20] : [30] };
  };

  await assert.rejects(discover(deps, 220), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.ok(ownerReads >= 2);
    assert.deepEqual(error.diagnostics.portOwnerPids, [30]);
    return true;
  });
});

test("rejects a duplicate owner set that could mask a new PID", async () => {
  const clock = createClock();
  let ownerReads = 0;
  const deps = harnessDeps(clock, {
    processes: [browser(20), browser(30)],
  });
  deps.enumeratePortOwners = async () => {
    ownerReads += 1;
    return { inspected: true, pids: ownerReads % 2 === 1 ? [20, 20] : [20, 30] };
  };

  await assert.rejects(discover(deps, 220), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.ok(ownerReads >= 2);
    return true;
  });
});

test("follows a Windows launcher handoff to the owned primary process", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock, {
    processes: [
      { pid: 21, commandLine: `chrome.exe --type=renderer --user-data-dir="${DATA_DIR}"` },
      browser(30),
    ],
    ownerPids: [30],
  });

  const result = await discover(deps);

  assert.equal(result.primaryPid, 30);
  assert.deepEqual(result.processPids, [21, 30]);
});

test("fails closed when listener ownership cannot be inspected", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock, { ownerInspected: false });

  await assert.rejects(discover(deps, 120), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.equal(error.diagnostics.primaryPid, 20);
    assert.deepEqual(error.diagnostics.portOwnerPids, []);
    return true;
  });
});

test("does not return success after an ownership query exceeds the budget", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock, {
    enumeratePortOwners: async () => {
      await clock.sleep(1_000);
      return { inspected: true, pids: [20] };
    },
  });

  await assert.rejects(discover(deps, 100), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.ok(error.diagnostics.elapsedMs >= 1_000);
    return true;
  });
});

test("reports process stage when the identity refresh exceeds the budget", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock);
  let reads = 0;
  deps.enumerateProcesses = async () => {
    if (++reads === 2) await clock.sleep(1_000);
    return { enumerated: true, processes: [browser(20)] };
  };

  await assert.rejects(discover(deps, 100), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "process");
    assert.deepEqual(error.diagnostics.portOwnerPids, [20]);
    assert.equal(reads, 2);
    return true;
  });
});

test("reports ownership stage when the final listener snapshot exceeds the budget", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock);
  let reads = 0;
  deps.enumeratePortOwners = async () => {
    if (++reads === 2) await clock.sleep(1_000);
    return { inspected: true, pids: [20] };
  };

  await assert.rejects(discover(deps, 100), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "ownership");
    assert.equal(reads, 2);
    return true;
  });
});

test("times out at the active-port stage with bounded diagnostics", async () => {
  const clock = createClock();
  const deps = harnessDeps(clock, { activePortRecord: null });

  await assert.rejects(discover(deps, 30), (error: unknown) => {
    assert.ok(error instanceof DevToolsPortDiscoveryError);
    assert.equal(error.diagnostics.stage, "active-port");
    assert.equal(error.diagnostics.childPid, 20);
    assert.equal(error.diagnostics.elapsedMs, 30);
    return true;
  });
});

function browser(pid: number): BrowserProcessInfo {
  return {
    pid,
    commandLine: `chrome.exe --user-data-dir="${DATA_DIR}" --remote-debugging-port=0`,
  };
}

function createClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let now = 1_000;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function harnessDeps(
  clock: ReturnType<typeof createClock>,
  options: {
    activePortRecord?: { contents: string } | null;
    readActivePortRecord?: DevToolsPortDiscoveryDeps["readActivePortRecord"];
    processes?: BrowserProcessInfo[];
    ownerPids?: number[];
    ownerInspected?: boolean;
    enumeratePortOwners?: DevToolsPortDiscoveryDeps["enumeratePortOwners"];
  } = {},
): DevToolsPortDiscoveryDeps {
  const defaultRecord = {
    contents: "55497\n/devtools/browser/current\n",
  };
  return {
    now: clock.now,
    sleep: clock.sleep,
    readActivePortRecord:
      options.readActivePortRecord ??
      (async () =>
        Object.hasOwn(options, "activePortRecord") ? options.activePortRecord! : defaultRecord),
    enumerateProcesses: async () => ({
      processes: options.processes ?? [browser(20)],
      enumerated: true,
    }),
    enumeratePortOwners:
      options.enumeratePortOwners ??
      (async () => ({
        pids: options.ownerPids ?? (options.ownerInspected === false ? [] : [20]),
        inspected: options.ownerInspected ?? true,
      })),
    isAlive: () => true,
  };
}

function discover(deps: DevToolsPortDiscoveryDeps, budgetMs = 120) {
  return waitForOwnedDevToolsEndpoint({ dataDir: DATA_DIR, childPid: 20, budgetMs }, deps);
}

function hasCode(expected: string) {
  return (error: unknown) => (error as NodeJS.ErrnoException).code === expected;
}
