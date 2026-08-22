import {
  dataDirFromCommandLine,
  debugPortFromCommandLine,
  enumerateBrowserProcessesUnderRoot,
  enumerateLoopbackPortOwners,
  type BrowserProcessInfo,
} from "./browser-process-discovery.ts";
import {
  parseDevToolsActivePort,
  readDevToolsActivePortRecord,
} from "./devtools-port-discovery.ts";

/**
 * Close browsers left behind by an app that did not exit cleanly.
 *
 * `before-quit` already calls `closeAll()`, so the normal path leaves nothing behind. This is for
 * the abnormal one: Task Manager, a power cut, a crash. The child Chromium survives, and because
 * CloakBrowser releases its licence seat only during its own shutdown flush, that survivor holds
 * the seat until the lease expires — measured at 7 to 17 minutes. On a plan with exactly one seat
 * the operator simply cannot open anything for that long, the app reports zero profiles running,
 * and nothing on screen connects the two facts.
 *
 * The whole point is closing them POLITELY. `Browser.close` over the orphan's own DevTools port
 * hands the seat back; SIGKILL keeps it, which would make this sweep a slower way to stay locked
 * out. So a kill here is a failure with a consolation prize, and is logged as one.
 */

export type OrphanSweepReason =
  | "ORPHAN-SWEEP-NONE"
  | "ORPHAN-SWEEP-CLOSED"
  | "ORPHAN-SWEEP-KILLED"
  | "ORPHAN-SWEEP-DISCOVERY-FAILED";

export interface OrphanSweepEvent {
  reason: OrphanSweepReason;
  pid?: number;
  port?: number | null;
  /** Why the polite close did not happen. Absent when it did. */
  detail?: string;
}

export interface OrphanSweepOutcome {
  closed: number[];
  killed: number[];
  enumerated: boolean;
}

export interface OrphanSweepDeps {
  enumerate?: (root: string) => Promise<{ processes: BrowserProcessInfo[]; enumerated: boolean }>;
  /**
   * Send `Browser.close` to a browser listening on `port`. Injected rather than imported so this
   * module stays free of the CDP client: the caller already owns one, and keeping the dependency
   * out means the logic here is testable with plain `node --test` and no transport at all.
   */
  closeViaCdp: (port: number, signal: AbortSignal) => Promise<void>;
  discoverPort?: (
    process: BrowserProcessInfo,
    ownedPids: ReadonlySet<number>,
  ) => Promise<number | null>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  log: (event: OrphanSweepEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  /** PIDs this app already owns. Empty at startup; a guard for any later caller. */
  excludePids?: readonly number[];
  /** How long a polite close gets before the kill. */
  closeBudgetMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A renderer or GPU helper shares the data dir but has no browser to close; the parent takes it. */
function isBrowserProcess(candidate: BrowserProcessInfo): boolean {
  return !/(?:^|\s)--type(?:=|\s)/.test(candidate.commandLine);
}

export async function sweepOrphanedProfileBrowsers(
  profilesRoot: string,
  deps: OrphanSweepDeps,
): Promise<OrphanSweepOutcome> {
  const enumerate = deps.enumerate ?? enumerateBrowserProcessesUnderRoot;
  const closeViaCdp = deps.closeViaCdp;
  const discoverPort = deps.discoverPort ?? discoverOwnedOrphanDevToolsPort;
  const sleep = deps.sleep ?? defaultSleep;
  const budget = deps.closeBudgetMs ?? 5000;
  const exclude = new Set(deps.excludePids ?? []);

  const { processes, enumerated } = await enumerate(profilesRoot);
  if (!enumerated) {
    // Not "nothing to sweep" — "could not look". Killing on a guess here would be the worst of
    // both: no orphan cleared and possibly a live profile taken down.
    deps.log({ reason: "ORPHAN-SWEEP-DISCOVERY-FAILED" });
    return { closed: [], killed: [], enumerated: false };
  }

  const orphans = processes.filter((p) => isBrowserProcess(p) && !exclude.has(p.pid));
  if (orphans.length === 0) {
    deps.log({ reason: "ORPHAN-SWEEP-NONE" });
    return { closed: [], killed: [], enumerated: true };
  }

  const closed: number[] = [];
  const killed: number[] = [];
  const ownedPids = new Set(processes.map((process) => process.pid));

  for (const orphan of orphans) {
    let port: number | null = null;
    let politeFailure: string | null = null;

    try {
      port = await discoverPort(orphan, ownedPids);
    } catch {
      politeFailure = "DevTools port discovery failed";
    }

    if (politeFailure === null) {
      if (port === null) {
        politeFailure = "no owned DevTools port could be recovered";
      } else {
        const closeDeadline = Date.now() + budget;
        try {
          await requestBrowserClose(closeViaCdp, port, Math.max(1, closeDeadline - Date.now()));
          while (Date.now() < closeDeadline && deps.isAlive(orphan.pid)) await sleep(150);
          if (deps.isAlive(orphan.pid)) {
            politeFailure = `still alive ${budget}ms after Browser.close`;
          }
        } catch (error) {
          politeFailure = `Browser.close failed: ${(error as Error).message}`;
        }
      }
    }

    if (politeFailure === null) {
      closed.push(orphan.pid);
      deps.log({ reason: "ORPHAN-SWEEP-CLOSED", pid: orphan.pid, port });
      continue;
    }

    // Consolation prize: the window goes away, the seat does not.
    deps.kill(orphan.pid);
    killed.push(orphan.pid);
    deps.log({ reason: "ORPHAN-SWEEP-KILLED", pid: orphan.pid, port, detail: politeFailure });
  }

  return { closed, killed, enumerated: true };
}

function requestBrowserClose(
  closeViaCdp: OrphanSweepDeps["closeViaCdp"],
  port: number,
  budgetMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Browser.close request timed out after ${budgetMs}ms`));
    }, budgetMs);

    let request: Promise<void>;
    try {
      request = closeViaCdp(port, controller.signal);
    } catch (error) {
      clearTimeout(timeout);
      controller.abort();
      reject(error);
      return;
    }

    request.then(
      () => {
        clearTimeout(timeout);
        controller.abort();
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        controller.abort();
        reject(error);
      },
    );
  });
}

async function discoverOwnedOrphanDevToolsPort(
  orphan: BrowserProcessInfo,
  ownedPids: ReadonlySet<number>,
): Promise<number | null> {
  const candidates: number[] = [];
  const dataDir = dataDirFromCommandLine(orphan.commandLine);
  if (dataDir) {
    const record = await readDevToolsActivePortRecord(dataDir).catch(() => null);
    if (record) {
      try {
        candidates.push(parseDevToolsActivePort(record.contents).port);
      } catch {
        // A partial or stale record is not authority; the legacy command-line value may still be.
      }
    }
  }
  const commandLinePort = debugPortFromCommandLine(orphan.commandLine);
  if (commandLinePort !== null && !candidates.includes(commandLinePort)) {
    candidates.push(commandLinePort);
  }

  for (const port of candidates) {
    const owners = await enumerateLoopbackPortOwners(port);
    if (
      owners.inspected &&
      owners.pids.includes(orphan.pid) &&
      owners.pids.every((pid) => ownedPids.has(pid))
    ) {
      return port;
    }
  }
  return null;
}
