/**
 * macOS-side preference work that has to happen before a launch, not during it.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. Both
 * entries exist because of a modal dialog: one suppresses Chrome for Testing's automation infobar,
 * the other stops the "reopen windows?" alert that crashes the stealth build.
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Suppress Chrome for Testing's "this build is only for automated testing"
 * infobar by writing the macOS managed-preference plist that the CfT
 * policy `CommandLineFlagSecurityWarningsEnabled` lives in. The path is
 * `/Library/Managed Preferences/com.google.chrome.for.testing.plist`,
 * which requires admin — but only ONCE; subsequent launches see the
 * file and skip the prompt.
 *
 * If the user declines admin (or just hits cancel), we swallow the
 * error and continue with the infobar visible. We don't keep prompting.
 */
export async function ensureCftInfobarSuppressed(): Promise<void> {
  // macOS reads managed prefs from BOTH paths; the per-user one wins on
  // recent macOS (Big Sur+), the system-wide one is the fallback. We
  // write both for max compatibility.
  const username = process.env.USER ?? "";
  const userPlistPath = `/Library/Managed Preferences/${username}/com.google.chrome.for.testing.plist`;
  const systemPlistPath = "/Library/Managed Preferences/com.google.chrome.for.testing.plist";
  const plistPath = systemPlistPath; // primary write target; user-dir handled in script below

  // Skip if already configured. Read the plist value to ensure it's
  // actually `false`, not just present.
  if (existsSync(plistPath) || existsSync(userPlistPath)) {
    try {
      const { stdout } = await execFileP("defaults", [
        "read",
        "/Library/Managed Preferences/com.google.chrome.for.testing",
        "CommandLineFlagSecurityWarningsEnabled",
      ]);
      if (stdout.trim() === "0") return;
    } catch {
      // Key missing — fall through and (re-)write below.
    }
  }

  // Sentinel file: if the user has previously declined the admin
  // prompt, remember that and do NOT re-prompt on every launch.
  const sentinelPath = `${app.getPath("userData")}/.cft-infobar-prompt-declined`;
  if (existsSync(sentinelPath)) return;

  // Write the plist to a tempfile in user-space first (no admin needed),
  // then `cp` it to /Library/Managed Preferences/ via osascript admin.
  // Avoids the shell-escaping nightmare of putting XML inside a nested
  // AppleScript double-quoted string.
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CommandLineFlagSecurityWarningsEnabled</key>
  <false/>
</dict>
</plist>
`;
  const tempPath = `${app.getPath("temp")}/mkt-browser-cft-policy-${process.pid}.plist`;
  await writeFile(tempPath, plistXml);

  const shellScript =
    `/bin/mkdir -p '/Library/Managed Preferences/${username}' && ` +
    `/bin/cp '${tempPath}' '${plistPath}' && ` +
    `/bin/chmod 644 '${plistPath}' && ` +
    `/usr/sbin/chown root:wheel '${plistPath}' && ` +
    `/bin/cp '${tempPath}' '${userPlistPath}' && ` +
    `/bin/chmod 644 '${userPlistPath}' && ` +
    `/usr/sbin/chown root:wheel '${userPlistPath}'`;
  const apple = `do shell script "${shellScript.replace(/"/g, '\\"')}" with administrator privileges with prompt "MKT Browser needs a one-time admin authorization to hide the 'Chrome for Testing' warning bar."`;

  try {
    await execFileP("osascript", ["-e", apple]);
    // Cleanup tempfile after copy succeeds (no admin needed since we own it).
    await fsp.unlink(tempPath).catch(() => {});
    console.log("[mkt-browser] CFT infobar suppressed via managed-preferences plist");
  } catch (e) {
    await fsp.unlink(tempPath).catch(() => {});
    // User cancelled or osascript failed. Plant the sentinel so we
    // don't pester them on every launch.
    try {
      await writeFile(sentinelPath, new Date().toISOString());
    } catch {
      // Sentinel write may fail in weird envs — not critical.
    }
    throw e;
  }
}

/**
 * Tell macOS to skip the "reopen windows from previous crash?" alert
 * that NSPersistentUIRestorer shows when a previous launch died. The
 * alert is modal AppKit; CloakBrowser's stealth patches DCHECK on it
 * and crash with EXC_BREAKPOINT, creating a permanent boot loop.
 *
 * Both Chromium-derived bundles share `org.chromium.Chromium` as their
 * bundle identifier on macOS, so a single defaults block covers CFT and
 * CloakBrowser.
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
