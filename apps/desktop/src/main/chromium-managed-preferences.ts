/**
 * macOS-side preference work that has to happen before a launch, not during it.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. It
 * stops the "reopen windows?" alert that crashes the stealth build.
 */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Tell macOS to skip the "reopen windows from previous crash?" alert
 * that NSPersistentUIRestorer shows when a previous launch died. The
 * alert is modal AppKit; CloakBrowser's stealth patches DCHECK on it
 * and crash with EXC_BREAKPOINT, creating a permanent boot loop.
 *
 * The engine bundle identifies as `org.chromium.Chromium` on macOS, so
 * a single defaults block covers it.
 */
export async function disableMacOsPersistentStateRestore(): Promise<void> {
  // Wipe the saved-state bundle entirely so the dialog has nothing to
  // restore from. Chromium will start fresh.
  const home = process.env.HOME ?? "";
  if (home) {
    const savedState = join(
      home,
      "Library",
      "Saved Application State",
      "org.chromium.Chromium.savedState",
    );
    await fsp.rm(savedState, { recursive: true, force: true }).catch(() => {});
  }
  // Defense in depth: turn off Apple's per-app persistence flags so
  // future crashes don't trigger the dialog either. These writes are
  // idempotent and silent if they already match.
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "NSQuitAlwaysKeepsWindows",
    "-bool",
    "false",
  ]).catch(() => {});
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "ApplePersistenceIgnoreState",
    "-bool",
    "true",
  ]).catch(() => {});
}
