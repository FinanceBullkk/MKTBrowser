/**
 * Closing a running Chromium child, and escalating when it will not go.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. The
 * escalation - `Browser.close` over CDP, then SIGTERM, then SIGKILL - is the part of shutdown worth
 * reading on its own. `browser-driver-shutdown.test.ts` covers it, though it drives the whole
 * driver to get here rather than calling this module directly.
 */
import type { ProfileId } from "@mktbrowser/types";
import { enumerateBrowserProcessesUsingDataDir } from "./browser-process-discovery";
import {
  isPidAlive,
  writeProfileLifecycleLog,
  type TrackedBrowserProcess,
} from "./browser-process-tracking.ts";

/**
 * Shut down a running Chromium child the canonical way: send `Browser.close`
 * over CDP (macOS ⌘Q equivalent — flushes session-restore data), then wait
 * up to 4s for the process to exit on its own. If CDP fails or the process
 * is hung, fall back to SIGTERM, then SIGKILL.
 *
 * Idempotent — safe to call once from `close()` and again from the window
 * watcher; the second call no-ops because the child is already exiting.
 */
export type ShutdownMethod = "already-exited" | "Browser.close" | "SIGTERM" | "SIGKILL";

export async function terminateBrowserProcess(
  profileId: ProfileId,
  context: TrackedBrowserProcess,
): Promise<{ terminated: boolean; shutdownMethod: ShutdownMethod }> {
  const shutdownMethod = await gracefulShutdown(profileId, context);
  const { survivors, enumerated, forcedBrowserTermination } = await killBrowsersUsingDataDir(
    profileId,
    context,
  );
  const effectiveShutdownMethod = forcedBrowserTermination ? "SIGKILL" : shutdownMethod;
  // An unreadable process table is not evidence of termination. Claiming "complete" from one is
  // how a browser that still holds the licence seat gets recorded as closed.
  const terminated = !isPidAlive(context.pid) && survivors.length === 0 && enumerated;
  writeProfileLifecycleLog(
    profileId,
    context,
    terminated ? "SHUTDOWN-COMPLETE" : "SHUTDOWN-FAILED",
    {
      shutdownMethod: effectiveShutdownMethod,
      targetPid: survivors[0],
    },
  );
  return { terminated, shutdownMethod: effectiveShutdownMethod };
}

async function gracefulShutdown(
  profileId: ProfileId,
  r: TrackedBrowserProcess,
): Promise<ShutdownMethod> {
  const { pid } = r;
  const trackedPidWasAlive = isPidAlive(pid);

  // Source of truth is the OS, not `child.killed`/`exitCode`. Those flags lie
  // in a real case: the window watcher may have already fired a SIGTERM (so
  // `child.killed` is true) that Chromium ignored, and a subsequent Stop press
  // would then skip escalation and report "closed" while the browser lives on.
  // 1. Graceful CDP close (⌘Q equivalent — flushes session-restore). The
  //    websocket disconnects mid-call; timeout-bounded so a stuck send can
  //    never block the signal escalation below. Attempt it even when the tracked PID already
  //    exited because Windows launchers can hand CDP to an untracked browser process.
  if (r.gracefulClose || r.session) {
    writeProfileLifecycleLog(profileId, r, "Browser.close", {
      shutdownSource: "graceful-shutdown",
    });
    await withTimeout(r.gracefulClose ? r.gracefulClose() : r.session!.closeBrowser(), 3000);
    if (!trackedPidWasAlive) {
      if (r.session) await withTimeout(r.session.close(), 1000);
      // The tracked PID was a Windows launcher that already handed off, so the browser doing the
      // actual closing is one we are not watching. Returning here used to hand straight to the
      // data-dir sweep, whose first act is SIGKILL — landing on a browser three milliseconds into
      // flushing its own shutdown. CloakBrowser releases its licence seat during that flush and not
      // before, so killing it there costs a seat for the 7-17 minutes the lease takes to expire,
      // on a plan that has exactly one. Give the untracked browser the same 4s Browser.close budget
      // the tracked path gets; the sweep is still there for whatever ignores it.
      await waitForDataDirProcessesToExit(r.browserDataDir, 4000);
      return "Browser.close";
    }
    // Chromium needs ~500ms–2s to flush session-restore on macOS; 4s is margin.
    if (await waitForPidDeath(pid, 4000)) {
      if (r.session) await withTimeout(r.session.close(), 1000);
      return "Browser.close";
    }

    if (r.session) await withTimeout(r.session.close(), 1000);
  } else if (!trackedPidWasAlive) {
    return "already-exited";
  }

  // 2. SIGTERM by PID (not r.child.kill — don't trust the child flags).
  console.log(`[mkt-browser] shutdown pid=${pid}: Browser.close didn't exit in 4s → SIGTERM`);
  writeProfileLifecycleLog(profileId, r, "SIGTERM", {
    shutdownSource: "graceful-shutdown",
  });
  killPid(pid, "SIGTERM");
  if (await waitForPidDeath(pid, 2000)) return "SIGTERM";

  // 3. SIGKILL — the kernel guarantees this. We poll to confirm the process is
  //    genuinely gone before returning, so close() never reports a false
  //    "closed" while Chromium is still on screen.
  console.log(`[mkt-browser] shutdown pid=${pid}: SIGTERM didn't exit in 2s → SIGKILL`);
  writeProfileLifecycleLog(profileId, r, "SIGKILL", {
    shutdownSource: "graceful-shutdown",
    targetPid: pid,
  });
  killPid(pid, "SIGKILL");
  await waitForPidDeath(pid, 2000);
  return "SIGKILL";
}

/** SIGKILL every process still holding `dataDir`. Final safety net so a Stop
 *  can never leave a Chromium window behind. */
async function killBrowsersUsingDataDir(
  profileId: ProfileId,
  context: TrackedBrowserProcess,
): Promise<{
  survivors: number[];
  enumerated: boolean;
  forcedBrowserTermination: boolean;
}> {
  const { processes, enumerated } = await enumerateBrowserProcessesUsingDataDir(
    context.browserDataDir,
  );
  if (!enumerated) {
    // Nothing was swept because nothing could be listed. Saying so is the whole point: the
    // alternative is an empty survivor list that reads exactly like a clean shutdown.
    writeProfileLifecycleLog(profileId, context, "SWEEP-DISCOVERY-FAILED", {
      shutdownSource: "data-dir-sweep",
    });
    return { survivors: [], enumerated: false, forcedBrowserTermination: false };
  }
  const pids = processes.map((process) => process.pid);
  if (pids.length === 0) {
    return { survivors: [], enumerated: true, forcedBrowserTermination: false };
  }
  const forcedBrowserTermination = processes.some(
    (process) => !/(?:^|\s)--type(?:=|\s)/.test(process.commandLine),
  );
  console.log(
    `[mkt-browser] sweep: SIGKILL ${pids.length} lingering proc(s) for ${context.browserDataDir}: ${pids.join(", ")}`,
  );
  for (const pid of pids) {
    writeProfileLifecycleLog(profileId, context, "SIGKILL", {
      shutdownSource: "data-dir-sweep",
      targetPid: pid,
    });
    killPid(pid, "SIGKILL");
  }
  await Promise.all(pids.map((pid) => waitForPidDeath(pid, 2000)));
  return { survivors: pids.filter(isPidAlive), enumerated: true, forcedBrowserTermination };
}

/** Resolve when `p` settles or after `ms`, whichever comes first. Never
 *  rejects — a hung or failing shutdown step must not block the kill path. */
export function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    p.then(
      () => {},
      () => {},
    ),
    sleep(ms),
  ]);
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (already dead) or EPERM — nothing more we can do here.
  }
}

/**
 * Poll until `pid` is no longer alive or the timeout elapses. Returns true if
 * the process is confirmed dead. Uses the OS (`kill -0`) as the authority, so
 * it's immune to stale ChildProcess flags and works no matter which code path
 * (Stop button, window watcher, external ⌘Q) initiated the shutdown.
 */
async function waitForPidDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

export async function isCdpEndpointReachable(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Poll until nothing holds `dataDir` any more, or the budget runs out. Unlike waitForPidDeath this
 * asks the OS which processes claim the directory, which is the only way to wait on a browser whose
 * PID we never tracked. A discovery failure ends the wait rather than extending it — the sweep that
 * follows is the backstop, and blocking shutdown on a broken enumeration would be worse.
 */
async function waitForDataDirProcessesToExit(dataDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { processes, enumerated } = await enumerateBrowserProcessesUsingDataDir(dataDir);
      if (!enumerated) return false;
      if (processes.length === 0) return true;
    } catch {
      return false;
    }
    await sleep(150);
  }
  const final = await enumerateBrowserProcessesUsingDataDir(dataDir);
  return final.enumerated && final.processes.length === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
