/**
 * Keeping a profile's Chromium data directory in a state a launch can actually use.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. The
 * doc comment on `ensureSessionRestore` came back with it: in the driver it had drifted about three
 * hundred lines from the function it describes and sat above `detectChromiumVersion` instead.
 */
import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import type { BrowserEngine } from "@mktbrowser/settings-store";
import { isPidAlive } from "./browser-process-tracking.ts";

export function browserDataDirForEngine(profileDataDir: string, engine: BrowserEngine): string {
  // Chrome profile data is not safely reusable across different Chromium
  // forks/major versions. CloakBrowser 145 SIGTRAPs on profile roots that
  // were previously opened by CFT 147/148, so keep its browser state in a
  // separate user-data-dir while preserving the logical MKT Browser profile.
  if (engine === "cloakbrowser") {
    return join(profileDataDir, "engines", "cloakbrowser");
  }
  return profileDataDir;
}

/**
 * Delete `SingletonLock` / `SingletonSocket` / `SingletonCookie` symlinks
 * if their target PID is no longer alive. Chromium refuses to launch
 * with these present (it interprets them as "another instance is using
 * this profile") and the failure manifests as a silent CDP "socket hang
 * up" — process exits seconds after spawn without any error to stderr.
 *
 * Safe to call before every launch: if the PID IS alive, we leave the
 * lock alone (real concurrent instance, let the second launch fail
 * loudly).
 */
export async function cleanStaleSingletonLocks(dataDir: string): Promise<void> {
  const candidates = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  const { readlink } = await import("node:fs/promises");

  const lockPath = join(dataDir, "SingletonLock");
  let staleLockTarget: string | null = null;
  try {
    const lockTarget = await readlink(lockPath);
    const pid = pidFromSingletonTarget(lockTarget);
    if (pid !== null && !isPidAlive(pid)) {
      staleLockTarget = lockTarget;
    }
  } catch {
    // No lock to inspect.
  }

  if (staleLockTarget) {
    await unlinkSingletonFiles(dataDir, candidates, `dead lock ${staleLockTarget}`);
    return;
  }

  for (const name of candidates) {
    const path = join(dataDir, name);
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      continue; // Not a symlink or doesn't exist — skip.
    }

    const pid = pidFromSingletonTarget(target);
    if (pid !== null && !isPidAlive(pid)) {
      try {
        await fsp.unlink(path);
        console.log(
          `[mkt-browser] cleaned stale ${name} (was → ${target}, pid ${pid} not running)`,
        );
      } catch {
        // ignore
      }
      continue;
    }

    // SingletonSocket points at a temp socket path. If the socket target
    // no longer exists, remove the symlink even when no PID is encoded.
    if (name === "SingletonSocket" && !existsSync(target)) {
      await fsp.unlink(path).catch(() => {});
      console.log(`[mkt-browser] cleaned stale ${name} (missing target ${target})`);
    }
  }
}

function pidFromSingletonTarget(target: string): number | null {
  // Lock format is usually "<hostname>-<pid>". Socket paths sometimes
  // include the same suffix in an intermediate dir.
  const m = target.match(/-(\d+)(?:[/]|$)/);
  if (!m?.[1]) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}


async function unlinkSingletonFiles(
  dataDir: string,
  names: string[],
  reason: string,
): Promise<void> {
  for (const name of names) {
    const path = join(dataDir, name);
    await fsp.unlink(path).catch(() => {});
  }
  console.log(`[mkt-browser] cleaned stale Singleton files (${reason})`);
}

/**
 * Whether the profile has a session Chromium can restore on launch. Used to
 * decide if we should open the start page (only on a genuine first run).
 * Chromium writes tab/session state under `Default/Sessions/`; older builds
 * also keep `Default/Current Session`. Any of these present → restorable.
 */
export async function hasRestorableSession(dataDir: string): Promise<boolean> {
  const sessionsDir = join(dataDir, "Default", "Sessions");
  try {
    const entries = await fsp.readdir(sessionsDir);
    if (entries.length > 0) return true;
  } catch {
    // no Sessions dir yet
  }
  return existsSync(join(dataDir, "Default", "Current Session"));
}

/**
 * Ensure the profile's Chrome `Default/Preferences` JSON has
 * `session.restore_on_startup = 1` so a relaunch reopens the tabs that
 * were open when the user last closed the window. Called before each
 * spawn — Chromium must NOT be running, otherwise we'll corrupt its
 * pref file (Chromium writes Preferences atomically with no flock).
 */
export async function ensureSessionRestore(dataDir: string): Promise<void> {
  const prefsPath = join(dataDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(prefsPath, "utf8");
    prefs = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Profile hasn't been launched yet — create minimal prefs and let
    // Chromium fill in the rest on first run.
  }
  const session = (prefs.session as Record<string, unknown>) ?? {};
  const profileSection = (prefs.profile as Record<string, unknown>) ?? {};

  // 1 = restore last session ("Continue where you left off")
  // 5 = new tab page (Chromium default)
  session.restore_on_startup = 1;

  // Mark the previous run as a clean exit. If Chromium crashed or we
  // killed it ungracefully, exit_type gets stuck on "Crashed" and the
  // next launch shows the "Restore tabs?" infobar (or silently skips
  // restore on some builds, including CloakBrowser). Forcing "Normal"
  // here defuses both — combined with --restore-last-session CLI flag
  // and our gracefulShutdown via CDP Browser.close, tabs reliably come
  // back across stop → launch cycles.
  profileSection.exit_type = "Normal";
  profileSection.exited_cleanly = true;

  prefs.session = session;
  prefs.profile = profileSection;

  await fsp.mkdir(join(dataDir, "Default"), { recursive: true });
  // Atomic-ish write: write to .tmp then rename.
  const tmpPath = `${prefsPath}.mkt-browser.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(prefs));
  await fsp.rename(tmpPath, prefsPath);
}
