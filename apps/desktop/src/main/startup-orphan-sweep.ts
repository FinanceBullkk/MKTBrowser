import {
  debugPortFromCommandLine,
  enumerateBrowserProcessesUnderRoot,
  type BrowserProcessInfo,
} from "./browser-process-discovery.ts";

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
  closeViaCdp: (port: number) => Promise<void>;
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

  for (const orphan of orphans) {
    const port = debugPortFromCommandLine(orphan.commandLine);
    let politeFailure: string | null = null;

    if (port === null) {
      politeFailure = "no DevTools port on the command line";
    } else {
      try {
        await closeViaCdp(port);
        const deadline = Date.now() + budget;
        while (Date.now() < deadline && deps.isAlive(orphan.pid)) await sleep(150);
        if (deps.isAlive(orphan.pid)) politeFailure = `still alive ${budget}ms after Browser.close`;
      } catch (error) {
        politeFailure = `Browser.close failed: ${(error as Error).message}`;
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
