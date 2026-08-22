export const MKT_BROWSER_MCP_SERVER_NAME = "mkt-browser";
export const MKT_BROWSER_MCP_HEALTH_NAME = "mkt-browser-mcp";
export const MKT_BROWSER_MCP_SERVER_VERSION = "0.3.1";
export const MKT_BROWSER_DEFAULT_MCP_PORT = 47_822;
export const MKT_BROWSER_MCP_PORT_ENV = "MKT_BROWSER_MCP_PORT";

export function resolveMktBrowserMcpPort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return MKT_BROWSER_DEFAULT_MCP_PORT;

  if (!/^\d+$/.test(value)) {
    throw new Error(`${MKT_BROWSER_MCP_PORT_ENV} must be an integer between 1 and 65535.`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${MKT_BROWSER_MCP_PORT_ENV} must be an integer between 1 and 65535.`);
  }

  return port;
}

export function mktBrowserMcpBaseUrl(port: number = MKT_BROWSER_DEFAULT_MCP_PORT): string {
  return `http://127.0.0.1:${port}`;
}

// ── The versioned promise MKT Browser makes to its MKTTool consumer ──
//
// MKTTool must decide compatibility from these values and branch on the error codes below. It must
// never match a human-readable message: those are free to change without a version bump. This block
// lives in the barrel rather than its own module because the Windows guard tests load this file
// through Node's type stripper, where a relative re-export would have to resolve under three
// different module-resolution modes at once.

/**
 * Bump when a tool is added or removed, when a response field changes meaning, or when a caller
 * written against the previous number would now behave incorrectly. Adding an optional response
 * field is not a bump.
 */
export const MKT_BROWSER_CONTRACT_VERSION = 4;

/** Bump when the on-disk profile record changes shape and needs a migration. */
export const MKT_BROWSER_PROFILE_SCHEMA_VERSION = 3;

/**
 * What this build can actually do. A capability is listed only once it is implemented and tested,
 * because the Relay picks its call path from this list rather than from a version comparison.
 * Managed mode (`managed-profile-v1`, `idempotent-create-v1`, `atomic-launch-v1`) belongs to MKB-02
 * and must not be advertised before it exists.
 */
export const MKT_BROWSER_BASE_CAPABILITIES = [
  "profile-contract-v1",
  "runtime-info-v1",
  "idempotent-create-v1",
  "atomic-launch-v1",
  "managed-profile-v1",
  "operation-diagnostics-v1",
] as const;

/**
 * Complete capability vocabulary for this contract. Runtime-dependent entries are reported only
 * after their local inspection passes; their presence here means callers may understand them.
 */
export const MKT_BROWSER_CAPABILITIES = [
  ...MKT_BROWSER_BASE_CAPABILITIES,
  "local-install-ready-v1",
  "license-capacity-v1",
] as const;

export type MktBrowserCapability = (typeof MKT_BROWSER_CAPABILITIES)[number];

/**
 * Stable machine-readable failure codes. Each names the layer that refused, so the Relay can tell
 * an operator which thing to fix instead of forwarding an internal sentence.
 */
export const MKT_BROWSER_ERROR_CODES = [
  /** The arguments did not match the tool schema. */
  "INVALID_INPUT",
  /** A security gate refused the call: blocked URL scheme or denylisted CDP method. */
  "FORBIDDEN",
  /** No profile on this device carries the requested id. */
  "PROFILE_NOT_FOUND",
  /** A page action arrived for a profile that is not launched. */
  "PROFILE_NOT_RUNNING",
  /** A running profile uses a different proxy than the managed launch request. */
  "PROFILE_ALREADY_RUNNING",
  /** The profile exists but its proxy could not be stored or applied. */
  "PROXY_REJECTED",
  /** The Chromium engine is missing, still being prepared, or failed verification. */
  "ENGINE_UNAVAILABLE",
  /** This build does not expose the requested tool. */
  "UNKNOWN_TOOL",
  /** A generic desktop or MCP control tried to mutate, delete, or directly launch a managed profile. */
  "MANAGED_PROFILE_LOCKED",
  /** A prior local deletion did not finish; only the in-app deletion retry may continue. */
  "PROFILE_DELETION_PENDING",
  /** Not yet classified. Treat a rise in this code as a contract gap, not as noise. */
  "INTERNAL_ERROR",
] as const;

export type MktBrowserErrorCode = (typeof MKT_BROWSER_ERROR_CODES)[number];

/**
 * Mirrors `BrowserEngine` in `@mktbrowser/settings-store`, restated here because `types` must not
 * depend on a package that depends on it. Adding a family is a deliberate contract change.
 */
export type MktBrowserEngineKind = "cft" | "cloakbrowser" | "unknown";

export interface MktBrowserEngineInfo {
  /** Which engine family this device is configured to run. */
  kind: MktBrowserEngineKind;
  /** Engine version once installed; `null` while it is missing or still being prepared. */
  version: string | null;
  /** The exact preparation stage, so a caller can tell "downloading" apart from "broken". */
  status: ChromiumStatus["kind"] | "unknown";
}

export interface MktBrowserLicenseCapacity {
  total: number;
  free: number;
  active: number;
  pendingRecovery: number;
  cooling: number;
}

export interface MktBrowserRuntimeInfo {
  /** Always the owned provider slug. Another value means the caller reached a different product. */
  provider: string;
  appVersion: string;
  contractVersion: number;
  profileSchemaVersion: number;
  engine: MktBrowserEngineInfo;
  capabilities: MktBrowserCapability[];
  /** Null when this build cannot produce a complete measured capacity view. */
  licenseCapacity: MktBrowserLicenseCapacity | null;
}

export interface MktBrowserOperationDiagnostic {
  operationId: string;
  requestId?: string;
  stage: string;
  code?: MktBrowserErrorCode;
  durationMs: number;
  runtime: {
    appVersion: string;
    contractVersion: number;
    profileSchemaVersion: number;
    engine: MktBrowserEngineInfo;
  };
}

/** Body carried inside an `isError` tool result. */
export interface MktBrowserToolErrorBody {
  error: { code: MktBrowserErrorCode; message: string };
  diagnostic?: MktBrowserOperationDiagnostic;
}

export type ProfileId = string;

export interface ProxyConfig {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Identifier of a real device family — defines the platform / CPU / GPU class. */
export type DeviceFamily =
  | "macbook-pro-14-m3"
  | "macbook-pro-14-m3-pro"
  | "macbook-pro-16-m3-pro"
  | "macbook-air-13-m3"
  | "macbook-air-15-m3"
  | "imac-24-m3"
  | "mac-mini-m2"
  | "windows-laptop-intel"
  | "windows-laptop-intel-uhd"
  | "windows-laptop-amd"
  | "windows-laptop-nvidia"
  | "windows-laptop-nvidia-4050"
  | "windows-desktop-nvidia"
  | "windows-desktop-nvidia-4080"
  | "windows-desktop-amd"
  | "windows-desktop-intel"
  | "linux-desktop-intel"
  | "linux-desktop-amd"
  | "linux-desktop-nvidia";

/**
 * Sec-CH-UA Client Hints — what every modern Chromium send as headers AND
 * exposes via `navigator.userAgentData`. Detection vendors cross-check
 * these against the legacy User-Agent string and `navigator.platform`,
 * so they MUST stay coherent.
 *
 * In our open-source build we can only set `navigator.userAgent` (via
 * Chromium `--user-agent` flag); the Sec-CH-UA family requires native
 * patches in our closed Chromium binary. The fields below are stored
 * with the profile so the patched Chromium can apply them at runtime.
 */
export interface ClientHints {
  /** Sec-CH-UA header value, e.g. `"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"` */
  secChUa: string;
  /** Sec-CH-UA-Platform: `"macOS" | "Windows" | "Linux" | "Android" | "iOS"` */
  secChUaPlatform: string;
  /** Sec-CH-UA-Platform-Version: `"14.6.0"` for macOS 14, `"10.0.0"` for Win 10 */
  secChUaPlatformVersion: string;
  /** Sec-CH-UA-Arch: `"arm" | "x86"` */
  secChUaArch: "arm" | "x86";
  /** Sec-CH-UA-Bitness: `"64" | "32"` */
  secChUaBitness: "64" | "32";
  /** Sec-CH-UA-Mobile: `"?0" | "?1"` */
  secChUaMobile: "?0" | "?1";
  /** Sec-CH-UA-Model: usually empty on desktop, e.g. `"Pixel 8"` on mobile */
  secChUaModel: string;
  /** Sec-CH-UA-Full-Version-List: full version per brand */
  secChUaFullVersionList: string;
}

export interface FingerprintConfig {
  /** Real device family this fingerprint impersonates */
  device: DeviceFamily;

  // ── Headers / navigator ──────────────────────────────────────────
  /** Full legacy User-Agent string */
  userAgent: string;
  /** `navigator.platform` — must match device family */
  platform: "MacIntel" | "Win32" | "Linux x86_64";
  /** Client Hints (Sec-CH-UA-*) */
  clientHints: ClientHints;

  // ── Locale / geo ─────────────────────────────────────────────────
  /** BCP 47 primary locale, e.g. `"en-US"` */
  locale: string;
  /** Ordered list for `navigator.languages`, e.g. `["en-US", "en"]` */
  languages: string[];
  /** HTTP `Accept-Language` header, derived from `languages` */
  acceptLanguage: string;
  /** IANA timezone, e.g. `"America/New_York"` */
  timezone: string;
  /** ISO 3166-1 alpha-2 country code matching the locale, for flag rendering */
  country: string;

  // ── Display ──────────────────────────────────────────────────────
  /** Logical screen size — `screen.width` / `screen.height` */
  screen: { width: number; height: number };
  /** Available area (screen minus dock/taskbar). Defaults to screen. */
  availScreen?: { width: number; height: number };
  /** `devicePixelRatio` — 2 on Retina, 1 on most desktops */
  dpr: number;

  // ── GPU ──────────────────────────────────────────────────────────
  webgl: {
    /** UNMASKED_VENDOR_WEBGL */
    vendor: string;
    /** UNMASKED_RENDERER_WEBGL */
    renderer: string;
  };

  // ── CPU / RAM ────────────────────────────────────────────────────
  hardwareConcurrency: number;
  deviceMemory: number;

  /**
   * Optional entropy seed. When set, drives deterministic generateFingerprint
   * choices and CloakBrowser `--fingerprint=` noise (canvas/audio/WebGL readback).
   * Same seed → same noise; different seed → different noise.
   */
  seed?: string;
}

/**
 * A Chrome extension installed into a single profile. Unpacked on disk under
 * `{profile.dataDir}/extensions/{id}/` and loaded via Chromium's
 * `--load-extension` at launch. `id` is the Chromium-derived extension ID
 * (deterministic from the absolute install path). The companion "Add to
 * MKT Browser" helper extension is NOT represented here — it's app-managed and
 * invisible to the user.
 */
export interface ExtensionConfig {
  /** Chromium extension ID (32 a–p chars). For store/CRX installs with a
   *  recovered developer key this is the genuine Chrome Web Store ID; for
   *  keyless folder/zip installs it's a stable content-hash-derived ID. */
  id: string;
  /** Display name from the extension's manifest. */
  name: string;
  /** Manifest version string (e.g. "1.50.0"). Shared store entries are keyed by
   *  id + version. "" for legacy rows installed before dedup. */
  version: string;
  /** Whether to load this extension on the next profile launch. */
  enabled: boolean;
  /** Where the unpacked files live:
   *  - "shared": one copy in the global store at <storeRoot>/<id>/<version>/,
   *    shared across profiles (`dir` is "").
   *  - "profile": legacy per-profile copy under the profile's dataDir, located
   *    via `dir`. */
  scope: "shared" | "profile";
  /** Install directory relative to the profile's dataDir (e.g. "extensions/<uuid>").
   *  Used only for scope "profile" (legacy / local); "" for shared entries. */
  dir: string;
  /** How it was added. */
  source: "web-store" | "file" | "folder";
}

export interface Profile {
  id: ProfileId;
  name: string;
  notes?: string;
  tags: string[];
  proxy?: ProxyConfig;
  fingerprint: FingerprintConfig;
  /** Extensions installed into this profile (see {@link ExtensionConfig}). */
  extensions?: ExtensionConfig[];
  /** Optional emoji the user picked as this profile's avatar. When unset the
   *  GUI derives a default emoji from the name/tags/id (see profileEmoji). */
  icon?: string;
  /** Start page opened on first launch (no restorable session). Empty/unset →
   *  the app default (DuckDuckGo). Opened as a positional URL arg; not enforced,
   *  so later in-browser navigation / session restore is untouched. */
  startUrl?: string;
  /** Reserved: per-profile default search engine. NOT wired yet — ungoogled
   *  CloakBrowser ignores both pref-seeding and extension `search_provider`
   *  overrides (verified), so this is deferred to the patched-Chromium build.
   *  The column/field are kept so the feature can land without a migration. */
  searchProvider?: string;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /** ISO 3166-1 alpha-2 country code resolved from the proxy's egress IP.
   *  Cached on every successful proxy probe (launch flow + manual ProxyTester).
   *  Used by the GUI to render the country flag — proxy egress trumps the
   *  fingerprint's timezone-derived country, since that's what websites see. */
  proxyCountry?: string;
  /** True when MKTTool owns the profile lifecycle through its stable external reference. */
  managed: boolean;
  /** A previous permanent-deletion attempt must be retried before the profile can be used. */
  deletionPending: boolean;
}

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  tags: string[];
  lastOpenedAt?: string;
  isRunning: boolean;
  /** User-picked emoji avatar (empty → GUI derives a default from name/tags/id). */
  icon?: string;
  /** Proxy config (denormalised so the GUI can render a proxy chip without a second fetch) */
  proxy?: ProxyConfig;
  /** IANA timezone from the profile's fingerprint (for flag inference) */
  timezone?: string;
  /** Country code resolved from the proxy's egress IP — preferred over
   *  `timezone` for flag rendering when the profile has a proxy. */
  proxyCountry?: string;
  /** Device family from the fingerprint — drives the platform icon
   *  (windows-laptop-intel → 🪟, macbook-pro-14-m3 → ). */
  device?: DeviceFamily;
  /** Managed profiles can be opened only through the MKTTool Relay path. */
  managed: boolean;
  /** A previous permanent-deletion attempt must be retried before the profile can be used. */
  deletionPending: boolean;
}

export interface CreateProfileInput {
  name: string;
  notes?: string;
  tags?: string[];
  icon?: string;
  startUrl?: string;
  searchProvider?: string;
  proxy?: ProxyConfig;
  fingerprint?: Partial<FingerprintConfig>;
  extensions?: ExtensionConfig[];
}

export interface UpdateProfileInput {
  name?: string;
  notes?: string;
  tags?: string[];
  icon?: string | null;
  startUrl?: string | null;
  searchProvider?: string | null;
  proxy?: ProxyConfig | null;
  fingerprint?: Partial<FingerprintConfig>;
  extensions?: ExtensionConfig[];
}

export interface LaunchedProfile {
  id: ProfileId;
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
}

export interface McpToolError {
  code:
    | "PROFILE_NOT_FOUND"
    | "PROFILE_ALREADY_RUNNING"
    | "PROFILE_NOT_RUNNING"
    | "LAUNCH_FAILED"
    | "INVALID_INPUT"
    | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Status of the bundled / downloaded patched Chromium runtime.
 *
 *   ready          — binary present + verified, ready for spawn
 *   missing        — never downloaded, first run
 *   downloading    — fetch in progress
 *   verifying      — sha256 check after download
 *   error          — last attempt failed; retry or fall back
 *   dev-system     — dev mode, using system Chrome (no patches)
 */
export type ChromiumStatus =
  | { kind: "ready"; version: string; binaryPath: string }
  | { kind: "missing" }
  | { kind: "fetching-manifest" }
  | {
      kind: "downloading";
      engine: "cft" | "cloakbrowser";
      bytesReceived: number;
      bytesTotal: number;
      version: string;
      attempt: number;
      maxAttempts: number;
      resuming: boolean;
    }
  | { kind: "verifying"; version: string }
  | { kind: "extracting"; version: string }
  | { kind: "error"; engine: "cft" | "cloakbrowser"; message: string }
  | { kind: "dev-system"; binaryPath: string };

export interface ChromiumManifest {
  version: string;
  /** Direct download URL; we recommend our R2 CDN */
  url: string;
  /** SHA-256 of the downloaded blob (lowercase hex) */
  sha256: string;
  /** Uncompressed size in bytes — used for progress UI when content-length is missing */
  size: number;
}
