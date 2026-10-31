/**
 * Turning a profile's fingerprint into the native arguments a CloakBrowser launch needs.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. Every
 * function here is pure - a fingerprint in, strings out - which is the whole reason to keep them
 * apart from the driver, whose job is the opposite: process handles, timers and retries.
 */
import { createHash } from "node:crypto";
import type { ClientHints, FingerprintConfig, ProfileId } from "@mktbrowser/types";

export function buildCloakBrowserFingerprintArgs(profileId: ProfileId, fp: FingerprintConfig): string[] {
  const args = [
    `--fingerprint=${fingerprintSeed(profileId, fp)}`,
    `--fingerprint-platform=${cloakBrowserPlatform(fp)}`,
    // Measured on CloakBrowser 151 (19 Aug 2026): `--fingerprint-locale=de-DE`
    // makes the page report navigator.language AND
    // Intl.DateTimeFormat().resolvedOptions().locale as de-DE. An earlier note
    // here claimed the switch did not exist and routed locale through CDP
    // Emulation.setLocaleOverride; the switch is in 151's table (and in 146's),
    // so the native patch drives it and the CDP layer is gone.
    `--fingerprint-locale=${fp.locale}`,
    `--fingerprint-timezone=${fp.timezone}`,
    `--fingerprint-screen-width=${fp.screen.width}`,
    `--fingerprint-screen-height=${fp.screen.height}`,
    // Take the HOST's display scaling out of the persona's screen.
    //
    // The preload that spoofs `screen.*` in JS is skipped on CloakBrowser, so these two switches
    // are the only thing describing the screen, and the host's device scale factor reaches one half
    // of the answer but not the other. Measured 27 August 2026 on a host at 150%
    // (`AppliedDPI 144`): `-screen-width=1536 -screen-height=864 -taskbar-height=48` reported
    // `screen` 2304x1296 — the declared size times 1.5 — while `availWidth/availHeight` stayed
    // 1536x816, the declared size untouched. A second profile at 1680x1050 inflated by the same
    // 1.5. The driver's older note recorded the switch as honoured exactly on CloakBrowser 146,
    // which is consistent: at 100% scaling the multiplier is invisible.
    //
    // The result is a screen no machine can have. `availWidth` ends up SMALLER than `width`, which
    // a horizontal Windows taskbar cannot produce, and `height - availHeight` becomes 480px against
    // a real taskbar of 40 to 72. It also unpins the persona from itself: the same profile reports
    // a different screen on every host with different scaling, so a profile is not portable between
    // operator machines and every profile on one host carries that host's scaling.
    //
    // Pinning the scale to the persona's own `dpr` removes the host from the calculation. A
    // persona claiming a 1536x864 screen at dpr 1 should render exactly as that machine would.
    // The visible cost is that the browser no longer follows the operator's Windows scaling, which
    // is the point rather than a side effect.
    `--force-device-scale-factor=${fp.dpr}`,
    `--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--fingerprint-device-memory=${deviceMemoryApiValue(fp.deviceMemory)}`,
  ];
  // Explicitly set WebGL vendor/renderer instead of relying on seed-derived
  // auto-generation. Browserscan flags "WebGL exception" when CloakBrowser's
  // seed-derived GPU pool produces inconsistent values for the current
  // platform — pinning them to fp.webgl forces coherence with the persona.
  if (fp.webgl?.vendor) args.push(`--fingerprint-gpu-vendor=${fp.webgl.vendor}`);
  if (fp.webgl?.renderer) args.push(`--fingerprint-gpu-renderer=${fp.webgl.renderer}`);
  // Brand + version from Client Hints — keeps Sec-CH-UA + UA-string + UA-CH
  // brand list coherent. CloakBrowser's --fingerprint-brand-version drives
  // both UA and Sec-CH-UA-Full-Version simultaneously.
  const brandVersion = primaryBrandVersion(fp.clientHints);
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`);
  if (fp.clientHints?.secChUaPlatformVersion) {
    args.push(`--fingerprint-platform-version=${fp.clientHints.secChUaPlatformVersion}`);
  }
  // screen.availHeight otherwise reflects the HOST's desktop chrome. Harmless
  // for a Windows persona on Windows, but a macOS persona then reports a
  // Windows taskbar inset, which no Mac can produce. Measured on CloakBrowser
  // 146: height 1080 with `-taskbar-height=22` yields availHeight 1058, and
  // `=0` yields 1080 — the switch is honoured exactly.
  args.push(`--fingerprint-taskbar-height=${cloakBrowserTaskbarHeight(fp)}`);
  args.push(`--fingerprint-storage-quota=${cloakBrowserStorageQuotaMib(profileId, fp)}`);
  return args;
}

/**
 * Desktop chrome inset (px) subtracted from `screen.availHeight`, by device
 * family. Derived from the family prefix the same way `cloakBrowserPlatform()`
 * is, so no persisted profile needs migrating.
 *
 *   Windows 48 — Windows 11 taskbar at 100% scale. Matches what this host
 *                actually reports, so Windows personas keep their current
 *                (already plausible) value rather than changing behaviour.
 *   macOS    25 — the menu bar. A visible Dock would subtract more, but 25 is
 *                the floor every Mac shows and is a real configuration
 *                (auto-hidden Dock); the host's Windows inset is not.
 *   Linux     0 — availHeight == height on many window managers.
 *
 * These are plausible defaults, not measured distributions: worth revisiting if
 * real-world availHeight data ever says otherwise.
 */
function cloakBrowserTaskbarHeight(fp: FingerprintConfig): number {
  const platform = cloakBrowserPlatform(fp);
  if (platform === "macos") return 25;
  if (platform === "linux") return 0;
  return 48;
}

/**
 * `navigator.storage.estimate().quota`, expressed in MiB — the unit
 * `--fingerprint-storage-quota` takes. Measured on CloakBrowser 146: `=8192`
 * makes the page report exactly 8,589,934,592 bytes and `=131072` reports
 * 137,438,953,472, i.e. what JavaScript sees is `value * 1024 ** 2`.
 *
 * Left unset, every profile on a host reports the SAME quota, because the
 * value is derived from the host volume's real free space (559,109,800 bytes
 * on this machine). That is a perfect join column: it survives separate
 * proxies, separate cookies and separate canvas noise, so one flagged account
 * can point at every sibling sharing the machine. Seeding it per profile is
 * what removes the join.
 *
 * Known cost, taken deliberately: MiB granularity means the reported quota is
 * always an exact multiple of 1,048,576, while a real Chrome computes a
 * fraction of free disk and lands on arbitrary byte counts. That trades an
 * exotic "suspiciously round" tell for the removal of a certain cross-profile
 * link — worth it while several profiles share one machine. Revisit if a
 * scanner is ever observed testing the divisibility.
 */
function cloakBrowserStorageQuotaMib(profileId: ProfileId, fp: FingerprintConfig): number {
  // 20-400 GiB of headroom — the band consumer disks actually sit in.
  const minMib = 20 * 1024;
  const spanMib = 380 * 1024;
  // Keyed off the same material as `fingerprintSeed`, under its own label so
  // rotating one surface does not silently rotate the other.
  const hex = createHash("sha256")
    .update(`storage-quota:${fp.seed ?? profileId}`)
    .digest("hex")
    .slice(0, 8);
  return minMib + (Number.parseInt(hex, 16) % spanMib);
}

function primaryBrandVersion(ch: ClientHints | undefined): string | null {
  if (!ch?.secChUaFullVersionList) return null;
  // Format: '"Chromium";v="148.0.7202.93", "Google Chrome";v="148.0.7202.93", "Not.A/Brand";v="99.0.0.0"'
  // Pick the first non-Chromium, non-"Not.A/Brand" entry — that's the
  // user-facing brand version (Chrome, Edge, etc.).
  const matches = ch.secChUaFullVersionList.matchAll(/"([^"]+)";v="([^"]+)"/g);
  for (const m of matches) {
    const brand = m[1];
    const version = m[2];
    if (!brand || !version) continue;
    if (!/Chromium|Not[.\s/]?A[.\s/]?Brand/i.test(brand)) return version;
  }
  return null;
}

/**
 * The value a real browser reports for `navigator.deviceMemory` / the
 * `Sec-CH-Device-Memory` hint: physical RAM rounded to the NEAREST power of two
 * and CAPPED AT 8 — the Device Memory API's spec upper bound. Chrome computes
 * `2 ** round(log2(gb))` clamped to [0.25, 8] (Blink's `floor(log2+0.5)`), so it
 * never exposes a value above 8; emitting a persona's raw physical RAM
 * (16/18/32/64 GB) would be an instant, impossible-value bot tell. The
 * fingerprint keeps the physical value for the UI and persona coherence; only
 * the web-facing surfaces get this quantized value.
 */
function deviceMemoryApiValue(physicalGb: number): number {
  if (!(physicalGb > 0)) return 8;
  return Math.min(8, 2 ** Math.round(Math.log2(physicalGb)));
}

function fingerprintSeed(profileId: ProfileId, fp: FingerprintConfig): string {
  // CloakBrowser accepts a stable seed. Keep it numeric and deterministic
  // so an MKT Browser profile keeps the same native fingerprint across launches.
  // When the persona carries an explicit `seed`, key off it instead of the
  // profile id so the engine-supported rendering noise stays stable for the
  // profile without changing its id. Native engine support is required for
  // every detector surface; this seed is not a promise that fonts/audio/WebGL
  // BrowserScan joins rotate on every CloakBrowser build.
  const material = fp.seed ?? profileId;
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return String(10000 + (Number.parseInt(hex, 16) % 90000));
}

function cloakBrowserPlatform(fp: FingerprintConfig): "macos" | "windows" | "linux" {
  // Derive from the user's chosen device family — CloakBrowser's native
  // C++ patches handle the rest of the cross-platform spoof. Falls back
  // to the host OS if device is somehow unset.
  if (fp.device.startsWith("mac") || fp.device.startsWith("imac")) return "macos";
  if (fp.device.startsWith("windows")) return "windows";
  if (fp.device.startsWith("linux")) return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
