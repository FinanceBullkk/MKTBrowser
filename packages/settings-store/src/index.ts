import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Which Chromium-derived binary the bootstrap downloads on first run.
 *   - "cft": Chrome for Testing — Google's official automation channel,
 *     same binary Puppeteer/Playwright use. Stable, reproducible, but
 *     no anti-detect patches (CFT branding, vanilla TLS fingerprint).
 *   - "cloakbrowser": CloakBrowser — Chromium with 50+ source-level
 *     stealth patches (canvas farbling, WebRTC, CDP traces removed).
 *     Drops detection rate against Cloudflare/DataDome/Akamai. Binary
 *     is "free to use, no redistribution" — we auto-download to user
 *     machine, never bundle. Slightly older Mac builds (145 vs 148 CFT).
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
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  mcpHttpEnabled: true,
  // Prefer CloakBrowser as the primary runtime. Chrome for Testing stays
  // available as a compatibility fallback from Settings.
  browserEngine: "cloakbrowser",
  cloakBrowserLicenseKey: "",
};

export class SettingsStore {
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
    };
    this.cache = merged;
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next = { ...current, ...patch };
    writeFileSync(this.jsonPath, JSON.stringify(next, null, 2), "utf8");
    this.cache = next;
    return next;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}
