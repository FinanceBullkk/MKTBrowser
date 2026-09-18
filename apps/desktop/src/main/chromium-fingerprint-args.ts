/**
 * Turning a profile's fingerprint into the arguments and preload script a Chromium launch needs.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour. Every
 * function here is pure - a fingerprint in, strings out - which is the whole reason to keep them
 * apart from the driver, whose job is the opposite: process handles, timers and retries.
 */
import { createHash } from "node:crypto";
import type { ClientHints, FingerprintConfig, ProfileId } from "@mktbrowser/types";

/**
 * Convert our string-formatted ClientHints into the structured
 * `userAgentMetadata` shape that CDP `Emulation.setUserAgentOverride`
 * expects. The CDP call then sets every Sec-CH-UA-* header AND populates
 * `navigator.userAgentData` — no Chromium patch needed.
 */
export function safeBuildUserAgentMetadata(
  fp: FingerprintConfig,
): ReturnType<typeof buildUserAgentMetadata> | null {
  if (!fp.clientHints || !fp.clientHints.secChUa) {
    // Legacy profile created before clientHints existed. The basic
    // userAgent + platform string are still applied via the parent call;
    // Sec-CH-UA-* headers will fall back to Chromium defaults until the
    // user regenerates the fingerprint.
    return null;
  }
  try {
    return buildUserAgentMetadata(fp);
  } catch (e) {
    console.error("[mkt-browser] buildUserAgentMetadata threw:", e);
    return null;
  }
}

function buildUserAgentMetadata(fp: FingerprintConfig): {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
  wow64: boolean;
} {
  const ch: ClientHints = fp.clientHints;
  return {
    brands: parseBrandList(ch.secChUa),
    fullVersionList: parseBrandList(ch.secChUaFullVersionList),
    platform: ch.secChUaPlatform,
    platformVersion: ch.secChUaPlatformVersion,
    architecture: ch.secChUaArch,
    bitness: ch.secChUaBitness,
    model: ch.secChUaModel,
    mobile: ch.secChUaMobile === "?1",
    wow64: false,
  };
}

/**
 * Parse an Sec-CH-UA header value of the form:
 *   "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
 * into the [{brand, version}] array CDP wants.
 */
function parseBrandList(header: string): Array<{ brand: string; version: string }> {
  const out: Array<{ brand: string; version: string }> = [];
  // Each item is `"<brand>";v="<version>"` — split on top-level commas
  // (brand strings cannot contain commas in practice).
  for (const part of header.split(",")) {
    const m = part.trim().match(/^"([^"]*)"\s*;\s*v="([^"]*)"\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ brand: m[1], version: m[2] });
  }
  return out;
}

/**
 * Patches non-CDP-controllable fingerprint surfaces:
 *   - `navigator.platform` (CDP `setUserAgentOverride` sets it once but
 *     iframes / web-workers can drift — reapplied on every document)
 *   - `navigator.hardwareConcurrency`
 *   - `navigator.deviceMemory`
 *   - `WebGLRenderingContext.getParameter` UNMASKED_VENDOR_WEBGL (0x9245)
 *     and UNMASKED_RENDERER_WEBGL (0x9246) for both WebGL1 and WebGL2.
 *
 * All wrappers carry a spoofed `.toString()` that returns
 * `function <name>() { [native code] }` so naive detection via
 * `Function.prototype.toString.call(fn)` passes.
 */
export function buildFingerprintPreloadScript(
  fp: FingerprintConfig,
  opts: { includeWebGl?: boolean } = {},
): string {
  // includeWebGl=false when the engine (e.g. CloakBrowser) handles WebGL
  // farbling at C++ level — our JS wrapper would create a double-spoof
  // anomaly. Default true for stock CFT.
  const includeWebGl = opts.includeWebGl ?? true;
  return `
(() => {
  const INCLUDE_WEBGL = ${JSON.stringify(includeWebGl)};
  const PLATFORM = ${JSON.stringify(fp.platform)};
  const HW_CONCURRENCY = ${fp.hardwareConcurrency};
  const DEVICE_MEMORY = ${deviceMemoryApiValue(fp.deviceMemory)};
  const GPU_VENDOR = ${JSON.stringify(fp.webgl.vendor)};
  const GPU_RENDERER = ${JSON.stringify(fp.webgl.renderer)};
  const SCREEN_W = ${fp.screen.width};
  const SCREEN_H = ${fp.screen.height};
  const AVAIL_W = ${fp.availScreen?.width ?? fp.screen.width};
  const AVAIL_H = ${fp.availScreen?.height ?? fp.screen.height};
  const DPR = ${fp.dpr};

  function fakeNative(fn, name) {
    try {
      const stringified = "function " + name + "() { [native code] }";
      Object.defineProperty(fn, "toString", {
        value: function () { return stringified; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  function defineProp(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, {
        get: function () { return value; },
        configurable: true,
      });
    } catch (_) {}
  }

  // ---- navigator props ----------------------------------------------------
  defineProp(Navigator.prototype, "platform", PLATFORM);
  defineProp(Navigator.prototype, "hardwareConcurrency", HW_CONCURRENCY);
  defineProp(Navigator.prototype, "deviceMemory", DEVICE_MEMORY);

  // ---- screen props (some sites read screen.* not via Emulation) ----------
  defineProp(Screen.prototype, "width", SCREEN_W);
  defineProp(Screen.prototype, "height", SCREEN_H);
  defineProp(Screen.prototype, "availWidth", AVAIL_W);
  defineProp(Screen.prototype, "availHeight", AVAIL_H);
  defineProp(Screen.prototype, "colorDepth", 24);
  defineProp(Screen.prototype, "pixelDepth", 24);

  // ---- devicePixelRatio (Emulation should set this but cover it) ----------
  defineProp(window, "devicePixelRatio", DPR);

  // ---- WebGL renderer / vendor -------------------------------------------
  // Real Chrome only resolves UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
  // *after* the page has activated WEBGL_debug_renderer_info via
  // gl.getExtension(...). If we return spoofed strings unconditionally, sites
  // that probe getParameter without enabling the extension see a string
  // where real Chrome returns "" — that anomaly = browserscan "WebGL exception".
  const debugInfoEnabled = new WeakMap();
  function patchGetExtension(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const origGet = Ctor.prototype.getExtension;
    if (!origGet) return;
    function wrapped(name) {
      const result = origGet.call(this, name);
      if (result && name === "WEBGL_debug_renderer_info") {
        debugInfoEnabled.set(this, true);
      }
      return result;
    }
    fakeNative(wrapped, "getExtension");
    Object.defineProperty(Ctor.prototype, "getExtension", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  function patchGetParameter(Ctor) {
    if (!Ctor || !Ctor.prototype || !Ctor.prototype.getParameter) return;
    const orig = Ctor.prototype.getParameter;
    function wrapped(p) {
      // 0x9245 = UNMASKED_VENDOR_WEBGL, 0x9246 = UNMASKED_RENDERER_WEBGL
      if (p === 0x9245 || p === 0x9246) {
        if (!debugInfoEnabled.get(this)) {
          // Page didn't enable WEBGL_debug_renderer_info — match real Chrome
          // which returns null/empty. Returning the spoof here is a tell.
          return orig.call(this, p);
        }
        return p === 0x9245 ? GPU_VENDOR : GPU_RENDERER;
      }
      return orig.call(this, p);
    }
    fakeNative(wrapped, "getParameter");
    Object.defineProperty(Ctor.prototype, "getParameter", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  if (INCLUDE_WEBGL) {
    patchGetExtension(window.WebGLRenderingContext);
    patchGetExtension(window.WebGL2RenderingContext);
    patchGetParameter(window.WebGLRenderingContext);
    patchGetParameter(window.WebGL2RenderingContext);
  }

  // ---- navigator.userAgentData getHighEntropyValues fallback --------------
  // CDP Emulation.setUserAgentOverride.userAgentMetadata sets this on stock
  // Chromium, but iframes occasionally see the unpatched version. Cover the
  // gap by mirroring values from navigator.userAgent + platform.
  // (Not invoked here — handled via CDP. Placeholder for future hardening.)
})();
`;
}

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
