import type { ClientHints, DeviceFamily, FingerprintConfig } from "@mktbrowser/types";

/**
 * Coherent fingerprint generator.
 *
 * Detection vendors (Cloudflare Bot Management, DataDome, Imperva, Akamai,
 * FingerprintJS, CreepJS) cross-check fingerprint surfaces against each
 * other. A consistent UA + Sec-CH-UA + navigator.platform + WebGL + screen
 * + locale + timezone story is the single most-important rule. One
 * inconsistency is a flag.
 *
 * This module owns the data model. We pick a `DeviceFamily` first, then a
 * `LocaleGroup` (geo-coherent locale + timezones), then derive every other
 * surface from those two choices. We never let the caller mix-and-match
 * incompatible values without going through `applyOverrides()` (which
 * preserves coherence where it can).
 *
 * Limit of this open-source generator: only fields injectable via Chromium
 * launch flags or runtime preload scripts can be applied without a patched
 * binary. Sec-CH-UA / navigator.userAgentData / TLS JA3-JA4 / Canvas-Audio
 * noise require an approved source-patched Chromium build.
 * The fingerprint we generate stores those fields anyway so the patched
 * binary can apply them when it ships.
 */

/** Current Chrome stable. Bumped when a new milestone goes stable on
 * https://chromiumdash.appspot.com/schedule. As of May 2026 → Chrome 148. */
// Must match the Chromium binary we're actually running — detection
// vendors compare claimed UA version vs. JS-engine feature signatures
// and flag mismatches ("UA says 148 but supports only 147 features").
// System Chrome stable as of May 2026 is 147.0.7727.138.
export const CHROME_VERSION_MAJOR = 147;
export const CHROME_VERSION_FULL = "147.0.7727.138";

import {
  ALLOWED_HWC_BASE,
  ALLOWED_MEM_BASE,
  COMMON_DESKTOP_SCREENS,
  DEVICES,
  type DeviceSpec,
  type WebGlPair,
} from "./fingerprint-device-catalog.js";
import { LOCALES, type LocaleGroup } from "./fingerprint-locale-catalog.js";

/** Whitelist of screens reconcile will honor (common desktop + every device screen). */
function buildAllowedDesktopScreens(): Set<string> {
  const keys = new Set<string>();
  for (const s of COMMON_DESKTOP_SCREENS) keys.add(`${s.width}x${s.height}`);
  keys.add("3840x2160");
  for (const d of DEVICES) {
    for (const s of d.screens) keys.add(`${s.width}x${s.height}`);
  }
  return keys;
}

const ALLOWED_DESKTOP_SCREENS = buildAllowedDesktopScreens();

function screenKey(s: { width: number; height: number }): string {
  return `${s.width}x${s.height}`;
}

function isAllowedHwc(n: number, device: DeviceSpec): boolean {
  return ALLOWED_HWC_BASE.has(n) || device.hardwareConcurrency.includes(n);
}

function isAllowedMem(n: number, device: DeviceSpec): boolean {
  return ALLOWED_MEM_BASE.has(n) || device.deviceMemory.includes(n);
}

function webglMatches(a: WebGlPair, b: WebGlPair): boolean {
  return a.vendor === b.vendor && a.renderer === b.renderer;
}

function resolveWebgl(
  device: DeviceSpec,
  preferred: WebGlPair | undefined,
  rand?: () => number,
): WebGlPair {
  if (preferred && device.webgl.some((w) => webglMatches(w, preferred))) {
    return preferred;
  }
  return rand ? pick(device.webgl, rand) : device.webgl[0]!;
}

/**
 * Thrown when a caller-supplied fingerprint field is present but invalid.
 * MCP maps this to INVALID_INPUT — profile must not be created/updated.
 */
export class FingerprintReconcileError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Invalid fingerprint.${field}: ${reason}`);
    this.name = "FingerprintReconcileError";
    this.field = field;
    this.reason = reason;
  }
}


/**
 * Map an ISO 3166-1 alpha-2 country code to a locale group id, with
 * sensible fallbacks for multilingual countries that have several locale
 * entries (preference is the most common browser locale we'd expect to
 * see). Returns null if no locale fits.
 */
export function findLocaleIdByCountry(cc: string): string | null {
  const found = findLocaleByCountry(cc);
  return found?.id ?? null;
}

function findLocaleByCountry(cc: string): LocaleGroup | null {
  const lower = cc.toLowerCase();
  // Exact preferred locale per multilingual country. The country has more
  // than one locale entry above; this picks the dominant one.
  const PREFERRED_BY_CC: Record<string, string> = {
    lu: "fr-LU", // Luxembourg: French is primary administrative language
    be: "nl-BE", // Belgium: Dutch slightly more populous than French
    ch: "de-CH", // Switzerland: German-speaking majority
    ca: "en-CA", // Canada: anglo majority
    // Country with no exact locale entry but a dominant linguistic neighbour:
    li: "de-DE", // Liechtenstein → German
    sm: "it-IT", // San Marino → Italian
    mc: "fr-FR", // Monaco → French
    ad: "es-ES", // Andorra → Spanish (Catalan unrepresented in our list)
    cy: "el-GR", // Cyprus → Greek
    al: "en-US", // Albania has no entry; default English
    by: "ru-RU", // Belarus → Russian
    kz: "ru-RU", // Kazakhstan → Russian (most common online)
    md: "ro-RO", // Moldova → Romanian
    me: "sr-RS", // Montenegro → Serbian (close to Montenegrin)
    mk: "sr-RS", // North Macedonia → Serbian (closest Slavic)
    ba: "hr-HR", // Bosnia & Herzegovina → Croatian
    xk: "sr-RS", // Kosovo → Serbian
  };
  const preferredId = PREFERRED_BY_CC[lower];
  if (preferredId) {
    const match = LOCALES.find((l) => l.id === preferredId);
    if (match) return match;
  }
  // Default: first locale whose country code matches.
  return LOCALES.find((l) => l.country === lower) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Public catalogs (for UI)
// ─────────────────────────────────────────────────────────────────────────

export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}

export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}

export function deviceCatalog(): ReadonlyArray<DeviceCatalogEntry> {
  return DEVICES.map((d) => ({
    family: d.family,
    label: d.label,
    screens: d.screens,
  }));
}

export function localeCatalog(): ReadonlyArray<LocaleCatalogEntry> {
  return LOCALES.map((l) => ({
    id: l.id,
    label: l.label,
    locale: l.locale,
    country: l.country,
    timezones: l.timezones,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Generator
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate a coherent fingerprint preset.
 *
 * If `seed` is provided, the result is deterministic — useful so existing
 * profiles get a stable fingerprint on every read.
 */
export function generateFingerprint(seed?: string): FingerprintConfig {
  const rand = seed ? seededRand(seed) : Math.random;
  // Device family must match the host OS — claiming Windows on a Mac
  // binary is detectable via V8/Blink/CSS-feature signatures (browserscan,
  // FingerprintJS, DataDome all compare actual platform behaviour vs the
  // claimed UA platform). Cross-platform spoof would require shipping a
  // separate Chromium binary per target OS, which we don't yet do.
  const hostFamily = hostPlatformFamily();
  const candidates = DEVICES.filter((d) => deviceMatchesHost(d, hostFamily));
  const device = pick(candidates.length > 0 ? candidates : DEVICES, rand);
  const locale = pick(LOCALES, rand);
  const screen = pick(device.screens, rand);
  const tz = pick(locale.timezones, rand);
  const hwc = pick(device.hardwareConcurrency, rand);
  const mem = pick(device.deviceMemory, rand);
  const webgl = pick(device.webgl, rand);

  return assemble(device, locale, screen, tz, hwc, mem, webgl);
}

/** Returns "mac" | "windows" | "linux" for the running Node/Electron host. */
export function hostPlatformFamily(): "mac" | "windows" | "linux" {
  if (typeof process !== "undefined" && process.platform) {
    if (process.platform === "darwin") return "mac";
    if (process.platform === "win32") return "windows";
  }
  return "linux";
}

function deviceMatchesHost(d: DeviceSpec, host: ReturnType<typeof hostPlatformFamily>): boolean {
  // Device family naming convention in DEVICES is "<os>-<form>-<gpu>",
  // e.g. "macbook-pro-14-m3", "windows-laptop-intel", "linux-desktop-intel".
  if (host === "mac") return d.family.startsWith("mac") || d.family.startsWith("imac");
  if (host === "windows") return d.family.startsWith("windows");
  return d.family.startsWith("linux");
}

/**
 * Reconcile a fingerprint's device family to match the host OS we're
 * running on, preserving locale + timezone where possible. Used at
 * launch to auto-fix profiles created on a different host or with the
 * old "any device" generator.
 *
 * Why: claiming Windows 11 while running a macOS Chromium binary is
 * detectable via V8/Blink/CSS feature signatures. The only safe match
 * for stock binaries is "device family == host family".
 */
export function reconcileDeviceFamilyToHost(fp: FingerprintConfig): FingerprintConfig {
  const host = hostPlatformFamily();
  const currentDevice = DEVICES.find((d) => d.family === fp.device);
  if (currentDevice && deviceMatchesHost(currentDevice, host)) return fp;

  // Pick a deterministic device for this profile so the choice is stable
  // across launches (locale/timezone get preserved).
  const candidates = DEVICES.filter((d) => deviceMatchesHost(d, host));
  if (candidates.length === 0) return fp;
  // Use UA hash as seed so the same profile always lands on the same
  // replacement device.
  const seed = stringHash(fp.userAgent + fp.locale);
  const device = candidates[seed % candidates.length]!;

  const screen =
    device.screens.find((s) => s.width === fp.screen.width && s.height === fp.screen.height) ??
    device.screens[0]!;
  const locale = LOCALES.find((l) => l.locale === fp.locale) ?? LOCALES[0]!;
  const tz = locale.timezones.includes(fp.timezone) ? fp.timezone : locale.timezones[0]!;
  const hwc = device.hardwareConcurrency.includes(fp.hardwareConcurrency)
    ? fp.hardwareConcurrency
    : device.hardwareConcurrency[0]!;
  const mem = device.deviceMemory.includes(fp.deviceMemory)
    ? fp.deviceMemory
    : device.deviceMemory[0]!;
  const webgl = resolveWebgl(device, fp.webgl);

  const next = assemble(device, locale, screen, tz, hwc, mem, webgl);
  return fp.seed ? { ...next, seed: fp.seed } : next;
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

/** Backwards-compat: deterministic fingerprint for an existing profile id. */
export function defaultFingerprint(seed: string): FingerprintConfig {
  return generateFingerprint(seed);
}

/**
 * Apply user overrides while preserving as much coherence as possible.
 * If the user changes `device`, screens are constrained to that device.
 * If the user changes `locale`, timezone is constrained to that locale.
 */
export function reconcileFingerprint(
  current: FingerprintConfig,
  patch: Partial<{
    device: DeviceFamily;
    localeId: string;
    screen: { width: number; height: number };
    timezone: string;
    hardwareConcurrency: number;
    deviceMemory: number;
  }>,
): FingerprintConfig {
  const hostFamily = hostPlatformFamily();

  // ── Locale ──────────────────────────────────────────────────────────
  let locale: LocaleGroup;
  if (patch.localeId !== undefined) {
    const found = LOCALES.find((l) => l.id === patch.localeId);
    if (!found) {
      throw new FingerprintReconcileError(
        "localeId",
        `unknown localeId '${patch.localeId}' (see list_fingerprint_options)`,
      );
    }
    locale = found;
  } else {
    locale = LOCALES.find((l) => l.locale === current.locale) ?? LOCALES[0]!;
  }

  // ── Device ──────────────────────────────────────────────────────────
  let device: DeviceSpec;
  if (patch.device !== undefined) {
    const found = DEVICES.find((d) => d.family === patch.device);
    if (!found) {
      throw new FingerprintReconcileError("device", `unknown device family '${patch.device}'`);
    }
    device = found;
  } else {
    device =
      DEVICES.find((d) => d.family === current.device) ??
      DEVICES.find((d) => deviceMatchesHost(d, hostFamily)) ??
      DEVICES[0]!;
  }

  // ── Screen ──────────────────────────────────────────────────────────
  let screen: { width: number; height: number };
  if (patch.screen !== undefined) {
    const key = screenKey(patch.screen);
    if (!ALLOWED_DESKTOP_SCREENS.has(key)) {
      throw new FingerprintReconcileError(
        "screen",
        `${patch.screen.width}x${patch.screen.height} is not an allowed desktop size`,
      );
    }
    screen = { width: patch.screen.width, height: patch.screen.height };
    // Ensure a host-compatible desktop device that owns this screen.
    const ownsScreen = (d: DeviceSpec) =>
      d.screens.some((s) => s.width === screen.width && s.height === screen.height);
    if (!ownsScreen(device)) {
      const hostCandidates = DEVICES.filter(
        (d) => deviceMatchesHost(d, hostFamily) && ownsScreen(d),
      );
      const anyCandidates = DEVICES.filter(ownsScreen);
      const next = hostCandidates[0] ?? anyCandidates[0] ?? null;
      if (!next) {
        throw new FingerprintReconcileError(
          "screen",
          `${key} accepted but no device can own that screen`,
        );
      }
      // Only auto-switch device when caller did not pin device.
      if (patch.device === undefined) {
        device = next;
      } else {
        throw new FingerprintReconcileError(
          "screen",
          `${key} is not valid for device '${device.family}'`,
        );
      }
    }
  } else {
    const requested = current.screen;
    screen =
      device.screens.find((s) => s.width === requested.width && s.height === requested.height) ??
      device.screens[0]!;
  }

  // Desktop screen ⇒ desktop UA (all our devices are desktop; assert width).
  if (screen.width >= 1280) {
    const mobileUa =
      /iPhone|Android|Mobile/i.test(device.uaPlatformToken) ||
      device.navigatorPlatform === ("iPhone" as never);
    if (mobileUa) {
      throw new FingerprintReconcileError(
        "screen",
        `desktop screen ${screenKey(screen)} is incoherent with mobile device`,
      );
    }
  }

  // ── Timezone ────────────────────────────────────────────────────────
  let timezone: string;
  if (patch.timezone !== undefined) {
    if (!locale.timezones.includes(patch.timezone)) {
      throw new FingerprintReconcileError(
        "timezone",
        `'${patch.timezone}' is not valid for locale '${locale.id}' (allowed: ${locale.timezones.join(", ")})`,
      );
    }
    timezone = patch.timezone;
  } else {
    timezone = locale.timezones.includes(current.timezone)
      ? current.timezone
      : locale.timezones[0]!;
  }

  // ── CPU / RAM ───────────────────────────────────────────────────────
  let hardwareConcurrency: number;
  if (patch.hardwareConcurrency !== undefined) {
    if (!isAllowedHwc(patch.hardwareConcurrency, device)) {
      throw new FingerprintReconcileError(
        "hardwareConcurrency",
        `${patch.hardwareConcurrency} is not an allowed value`,
      );
    }
    hardwareConcurrency = patch.hardwareConcurrency;
  } else {
    hardwareConcurrency = device.hardwareConcurrency.includes(current.hardwareConcurrency)
      ? current.hardwareConcurrency
      : device.hardwareConcurrency[0]!;
  }

  let deviceMemory: number;
  if (patch.deviceMemory !== undefined) {
    if (!isAllowedMem(patch.deviceMemory, device)) {
      throw new FingerprintReconcileError(
        "deviceMemory",
        `${patch.deviceMemory} is not an allowed value`,
      );
    }
    deviceMemory = patch.deviceMemory;
  } else {
    deviceMemory = device.deviceMemory.includes(current.deviceMemory)
      ? current.deviceMemory
      : device.deviceMemory[0]!;
  }

  const webgl = resolveWebgl(device, current.webgl);
  const next = assemble(device, locale, screen, timezone, hardwareConcurrency, deviceMemory, webgl);
  return current.seed ? { ...next, seed: current.seed } : next;
}

function assemble(
  device: DeviceSpec,
  locale: LocaleGroup,
  screen: { width: number; height: number },
  timezone: string,
  hardwareConcurrency: number,
  deviceMemory: number,
  webgl: WebGlPair,
): FingerprintConfig {
  const userAgent = buildUserAgent(device);
  const clientHints = buildClientHints(device);
  const acceptLanguage = buildAcceptLanguage(locale.languages);

  return {
    device: device.family,
    userAgent,
    platform: device.navigatorPlatform,
    clientHints,
    locale: locale.locale,
    languages: [...locale.languages],
    acceptLanguage,
    timezone,
    country: locale.country,
    screen: { width: screen.width, height: screen.height },
    availScreen: defaultAvail(screen, device.navigatorPlatform),
    dpr: device.dpr,
    webgl: { vendor: webgl.vendor, renderer: webgl.renderer },
    hardwareConcurrency,
    deviceMemory,
  };
}

function buildUserAgent(device: DeviceSpec): string {
  return `Mozilla/5.0 (${device.uaPlatformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION_FULL} Safari/537.36`;
}

function buildClientHints(device: DeviceSpec): ClientHints {
  // Chromium's GREASE pattern — randomised "Not?A_Brand" entry to discourage
  // brand allowlisting. The actual GREASE token rotates per Chromium build;
  // we use a stable one. If a detector compares to live Chrome, this is a
  // potential mismatch — the patched-Chromium build will randomise it.
  const grease = '"Not?A_Brand";v="99"';
  const secChUa = `"Chromium";v="${CHROME_VERSION_MAJOR}", "Google Chrome";v="${CHROME_VERSION_MAJOR}", ${grease}`;
  const secChUaFullVersionList = `"Chromium";v="${CHROME_VERSION_FULL}", "Google Chrome";v="${CHROME_VERSION_FULL}", ${grease}`;

  return {
    secChUa,
    secChUaPlatform: device.secChUaPlatform,
    secChUaPlatformVersion: device.secChUaPlatformVersion,
    secChUaArch: device.secChUaArch,
    secChUaBitness: device.secChUaBitness,
    secChUaMobile: "?0",
    secChUaModel: "",
    secChUaFullVersionList,
  };
}

function buildAcceptLanguage(languages: string[]): string {
  // Chrome formats Accept-Language as `lang-region;q=0.9,lang;q=0.8`...
  if (languages.length === 0) return "en-US";
  const parts: string[] = [languages[0]!];
  let q = 0.9;
  for (let i = 1; i < languages.length; i++) {
    parts.push(`${languages[i]};q=${q.toFixed(1)}`);
    q -= 0.1;
    if (q < 0.1) q = 0.1;
  }
  return parts.join(",");
}

function defaultAvail(
  screen: { width: number; height: number },
  platform: "MacIntel" | "Win32" | "Linux x86_64",
): { width: number; height: number } {
  // macOS dock: ~80px bottom; Win taskbar: ~40px bottom; Linux varies.
  const bottom = platform === "MacIntel" ? 80 : platform === "Win32" ? 40 : 30;
  return { width: screen.width, height: Math.max(0, screen.height - bottom) };
}

// ─────────────────────────────────────────────────────────────────────────
// Random utilities
// ─────────────────────────────────────────────────────────────────────────

function pick<T>(items: ReadonlyArray<T>, rand: () => number): T {
  if (items.length === 0) throw new Error("pick() got empty array");
  const idx = Math.floor(rand() * items.length);
  return items[idx]!;
}

function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 0xffffffff;
  };
}
