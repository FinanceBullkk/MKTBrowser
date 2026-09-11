import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Which Chromium-derived binary the bootstrap downloads on first run.
 *   - "cft": Chrome for Testing — Google's official automation channel and a reproducible
 *     compatibility engine. It is not identity-isolation evidence.
 *   - "cloakbrowser": the licensed provider engine selected for controlled testing. Provider
 *     modifications and licence status do not prove that native identity surfaces are isolated;
 *     the current release keeps that claim explicitly open. The binary is downloaded to the user
 *     machine and never bundled.
 */
export type BrowserEngine = "cft" | "cloakbrowser";

export interface AppSettings {
  /** Theme — "dark" only for now, kept for forward compatibility */
  theme: "dark";
  /** Whether to spawn local MCP HTTP server on app start */
  mcpHttpEnabled: boolean;
  /** Which Chromium binary to download + run. Switching requires app restart. */
  browserEngine: BrowserEngine;
  /**
   * CloakBrowser licence key. Without one the engine is stuck on the last
   * openly published build (146.0.7680.177.5, May 2026); with one it tracks
   * the current Chrome major. A free key from https://cloakbrowser.dev/free
   * allows one profile open at a time.
   *
   * The Pro binary re-checks this on every launch, so it is a runtime
   * dependency, not just a download credential.
   */
  cloakBrowserLicenseKey: string;
  /**
   * Every CloakBrowser key this installation may use.
   *
   * The engine binds a session to the key it was handed at spawn and refuses a second one. When a
   * separately verified multi-seat entitlement is enabled, the pool can use one key per profile;
   * the default one-seat runtime deliberately does not activate these stored extras. The pool also
   * absorbs the cooldown — a key whose seat was not released cleanly rests for its lease while the
   * others keep working, instead of locking the whole app out.
   *
   * `cloakBrowserLicenseKey` remains the primary and is what the engine download and manifest
   * checks use; it is folded into this list automatically so an existing install keeps working.
   */
  cloakBrowserLicenseKeys: string[];
  /**
   * Close browsers left behind by an app that did not exit cleanly, at startup.
   *
   * An orphan holds the engine's licence seat until its lease expires — measured between 7 and 17
   * minutes — during which the app shows zero profiles running and every launch fails. The sweep
   * closes them over their own DevTools port, which is what hands the seat back.
   *
   * Off is for the case where two copies of the app share one profiles folder, where one copy's
   * "orphan" is the other's live profile.
   */
  startupOrphanSweep: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  mcpHttpEnabled: true,
  // Fresh profile-manager installs need no vendor licence. Explicit saved selections are retained.
  browserEngine: "cft",
  cloakBrowserLicenseKey: "",
  cloakBrowserLicenseKeys: [],
  startupOrphanSweep: true,
};

/**
 * The key list, with the single primary key folded in and duplicates dropped.
 *
 * The primary comes first so an install that predates the list behaves exactly as before. A key
 * listed twice would advertise two sessions where the engine grants one, so the operator would be
 * told a profile can open and then be refused.
 */
function normalizeLicenseKeys(raw: Record<string, unknown>): string[] {
  const primary = typeof raw.cloakBrowserLicenseKey === "string" ? raw.cloakBrowserLicenseKey : "";
  const listed = Array.isArray(raw.cloakBrowserLicenseKeys)
    ? raw.cloakBrowserLicenseKeys.filter((k): k is string => typeof k === "string")
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of [primary, ...listed]) {
    const trimmed = key.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export class SettingsStore {
  private updateQueue: Promise<unknown> = Promise.resolve();
  private readonly jsonPath: string;
  private cache: AppSettings | null = null;

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    mkdirSync(dirname(jsonPath), { recursive: true });
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;

    let raw: Partial<AppSettings> = {};
    if (existsSync(this.jsonPath)) {
      try {
        const txt = readFileSync(this.jsonPath, "utf8");
        raw = JSON.parse(txt) as Partial<AppSettings>;
      } catch {
        raw = {};
      }
    }

    const merged: AppSettings = {
      theme: "dark",
      mcpHttpEnabled:
        typeof raw.mcpHttpEnabled === "boolean" ? raw.mcpHttpEnabled : DEFAULTS.mcpHttpEnabled,
      browserEngine:
        raw.browserEngine === "cft" || raw.browserEngine === "cloakbrowser"
          ? raw.browserEngine
          : DEFAULTS.browserEngine,
      cloakBrowserLicenseKey:
        typeof raw.cloakBrowserLicenseKey === "string"
          ? raw.cloakBrowserLicenseKey.trim()
          : DEFAULTS.cloakBrowserLicenseKey,
      cloakBrowserLicenseKeys: normalizeLicenseKeys(raw),
      startupOrphanSweep:
        typeof raw.startupOrphanSweep === "boolean"
          ? raw.startupOrphanSweep
          : DEFAULTS.startupOrphanSweep,
    };
    this.cache = merged;
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const run = this.updateQueue.then(async () => {
      const current = await this.load();
      const next = { ...current, ...patch };
      const temporaryPath = `${this.jsonPath}.${randomUUID()}.tmp`;
      try {
        // Replace only after the complete file is flushed; a failed write leaves the old file intact.
        writeFileSync(temporaryPath, JSON.stringify(next, null, 2), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        renameSync(temporaryPath, this.jsonPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      this.cache = next;
      return next;
    });
    this.updateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}
