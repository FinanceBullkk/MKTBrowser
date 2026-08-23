import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileManager } from "@mktbrowser/profile-manager";
import {
  generateFingerprint,
  reconcileFingerprint,
  deviceCatalog,
  localeCatalog,
} from "@mktbrowser/profile-manager";
import {
  MKT_BROWSER_CONTRACT_VERSION,
  MKT_BROWSER_MCP_SERVER_NAME,
  MKT_BROWSER_MCP_SERVER_VERSION,
  MKT_BROWSER_PROFILE_SCHEMA_VERSION,
  type LaunchedProfile,
  type MktBrowserEngineInfo,
  type MktBrowserRuntimeInfo,
  type MktBrowserOperationDiagnostic,
  type ProfileId,
  type CreateProfileInput,
  type UpdateProfileInput,
  type FingerprintConfig,
  type ProxyConfig,
} from "@mktbrowser/types";
import { ActivityLog } from "./ActivityLog.js";
import {
  CdpPolicyError,
  managedProfileLocked,
  unmanagedProfileLaunch,
  profileNotFound,
  profileNotRunning,
  toErrorCode,
  toErrorMessage,
  unknownTool,
} from "./mkt-browser-tool-errors.js";
import {
  assertMcpToolInventory,
  FULL_LOCAL_ACCESS_POLICY,
  isClassifiedMcpTool,
  isMcpToolAllowed,
  type McpToolAccessPolicy,
} from "./tool-exposure-policy.js";
import {
  resolveRuntimeCapabilities,
  type RuntimeCapabilityProvider,
} from "./runtime-capabilities.js";
import {
  resolveRuntimeLicenseCapacity,
  type RuntimeLicenseCapacityProvider,
} from "./runtime-license-capacity.js";
import { launchManagedProfile, type RunningProfileState } from "./managed-profile-launch.js";

// ── Security gates (engine-independent, enforced in the MCP dispatch layer) ──

/**
 * URL schemes an MCP-driven navigation must never reach: local files and
 * privileged browser surfaces. A prompt-injected agent could otherwise read
 * `file:///…` or drive `chrome://`/`devtools://` internals.
 */
const BLOCKED_URL_SCHEMES = ["file:", "chrome:", "devtools:", "view-source:"];

/**
 * Mirror Chromium's GURL normalization BEFORE the scheme prefix test, or the
 * scan is trivially bypassed: GURL strips ALL tab/CR/LF from anywhere in the
 * URL and strips every leading byte <= 0x20 (not just ASCII whitespace). A
 * plain trimStart()+lowercase prefix test misses `fi\tle:///…` and `file:…`,
 * both of which still navigate.
 */
function normalizeUrlForScan(s: string): string {
  return s
    .replace(/[\t\n\r]/g, "") // GURL strips these globally
    // The control characters are the point: GURL strips every leading byte <= 0x20 before
    // resolving a scheme, so a scanner that skips them is bypassed by "\x00file:///".
    // eslint-disable-next-line no-control-regex
    .replace(/^[\x00-\x20]+/, "") // strip ALL leading control chars, not just whitespace
    .toLowerCase();
}

function hasBlockedScheme(s: string): boolean {
  const n = normalizeUrlForScan(s);
  if (BLOCKED_URL_SCHEMES.some((p) => n.startsWith(p))) return true;
  // Belt-and-suspenders: where the original string parses as a URL, reject on
  // its protocol too (handles percent/host-form oddities the prefix scan misses).
  try {
    if (BLOCKED_URL_SCHEMES.includes(new URL(s).protocol)) return true;
  } catch {
    // unparseable → rely on the prefix scan
  }
  return false;
}

function assertSafeUrl(url: string): void {
  if (hasBlockedScheme(url)) {
    throw new CdpPolicyError(
      `Refusing URL with a blocked scheme: ${url}. ` +
        `file:/chrome:/devtools:/view-source: are not allowed.`,
    );
  }
}

/**
 * Recursively scan every string value in a CDP params object (key-agnostic,
 * so `url`, `urls[]`, nested history-entry urls, … are all covered) and reject
 * any that carries a blocked scheme.
 */
function assertNoBlockedSchemeInParams(params?: Record<string, unknown>): void {
  if (!params) return;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (hasBlockedScheme(v)) {
        throw new CdpPolicyError(`Refusing CDP params containing a blocked URL scheme: ${v}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item);
    }
  };
  walk(params);
}

/**
 * Methods raw `cdp_send` must never invoke. Denylist (not allowlist) because
 * the escape-hatch's value is breadth. Two classes:
 *  - host filesystem / response interception (no stealth-safe agent use);
 *  - cross-origin browser-secret readers an agent CANNOT already reach via
 *    evaluate_js (same-origin policy), plus destructive-without-a-tool methods.
 * LIVING list — extend when CDP adds storage/host-reaching methods.
 */
const CDP_DENY_METHODS = new Set([
  // host filesystem / response-content read (host FS reach beyond the page):
  "IO.read",
  "IO.resolveBlob",
  "DOM.getFileInfo",
  "DOM.setFileInputFiles", // reads arbitrary host files (paths) into a page input → exfil
  "Network.loadNetworkResource",
  "Page.getResourceContent",
  "Page.searchInResource", // line-by-line read of loaded (incl. cross-origin/file://) resource content
  "Page.setDownloadBehavior",
  "Browser.setDownloadBehavior",
  // cross-origin BROWSER-SECRET exfil (reachable only via raw CDP, not from
  // evaluate_js due to same-origin policy). NOTE the same capability exists in
  // BOTH the Storage and Network domains — deny every spelling, exact-match:
  "Storage.getCookies", // ALL cookies incl httpOnly, every origin
  "Network.getAllCookies", // the classic bulk cookie dumper (Storage.getCookies' predecessor)
  "DOMStorage.getDOMStorageItems", // any origin's localStorage without navigating
  "IndexedDB.requestData", // any origin's IndexedDB
  "CacheStorage.requestEntries",
  "CacheStorage.requestCachedResponse",
  // destructive-without-a-tool (a prompt-injected agent could wipe/tamper/quit).
  // Cross-origin storage WRITE/WIPE siblings of the denied readers above — all
  // reach another origin's storage without navigating, beyond evaluate_js:
  "Storage.clearDataForOrigin",
  "Storage.clearCookies",
  "Network.clearBrowserCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCache",
  "DOMStorage.clear",
  "DOMStorage.setDOMStorageItem",
  "DOMStorage.removeDOMStorageItem",
  "IndexedDB.deleteDatabase",
  "IndexedDB.clearObjectStore",
  "IndexedDB.deleteObjectStoreEntries",
  "CacheStorage.deleteCache",
  "CacheStorage.deleteEntry",
  // browser lifecycle / DoS:
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
]);

function assertCdpMethodAllowed(method: string, params?: Record<string, unknown>): void {
  if (CDP_DENY_METHODS.has(method) || method.startsWith("Fetch.")) {
    throw new CdpPolicyError(
      `CDP method ${method} is denied: it can reach the host filesystem, ` +
        `intercept traffic, or read cross-origin browser secrets.`,
    );
  }
  assertNoBlockedSchemeInParams(params);
}

/**
 * Raw `cdp_send` is OPT-IN. By default an agent gets only the curated wrappers
 * (navigate/click/type/extract/evaluate_js/get_cookies-scoped/tabs/waits), which
 * use fixed CDP methods and can't be redirected to a dangerous one. Raw protocol
 * access is the field norm to keep OUT of an autonomous agent's reach (Playwright
 * MCP / Claude / OpenAI computer-use all curate the surface; OWASP/MCP prescribe
 * least-privilege + allowlists over denylists). A power user in a trusted context
 * enables it explicitly. Read the env dynamically so it's togglable per process.
 */
function rawCdpEnabled(): boolean {
  // Fail-closed + unsurprising: only an explicit truthy value enables it, so
  // `=0` / `=false` / `=` (empty) / unset all stay OFF. (Avoids the `!!env`
  // footgun where any non-empty string — including "0" — reads as true.)
  const v = (process.env.MKT_BROWSER_MCP_ALLOW_RAW_CDP ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * BrowserDriver is the surface that the MCP server delegates real
 * browser work to. The desktop app implements it on top of patched
 * Chromium + CDP. The standalone dev mode implements a mock so the
 * MCP server can be exercised without a browser.
 */
export interface BrowserDriver {
  launch(profileId: ProfileId): Promise<LaunchedProfile>;
  close(profileId: ProfileId): Promise<void>;
  isRunning(profileId: ProfileId): boolean;
  getRunningProfileState(profileId: ProfileId): RunningProfileState | null;
  navigate(profileId: ProfileId, url: string): Promise<{ url: string }>;
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }>;
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }>;
  extract(profileId: ProfileId): Promise<{ result: unknown }>;
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }>;
  /**
   * Send a raw CDP command. `opts.safe` (default true) auto-disables any
   * domain the call had to enable so the stealth baseline is preserved; the
   * convenience CDP tools compose on top of this single primitive.
   */
  cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown>;
}

export interface MktBrowserMcpServerOptions {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
  /** Optional activity log; if not provided, a fresh one is created */
  activityLog?: ActivityLog;
  /**
   * Live engine facts for `get_runtime_info`. The desktop app supplies this from its Chromium
   * bootstrap. When it is absent — standalone/mock runs — the engine reports `unknown` rather than
   * a version this process cannot actually observe.
   */
  engineInfo?: () => MktBrowserEngineInfo;
  /** Runtime-dependent capabilities that have passed their local checks on this device. */
  runtimeCapabilities?: RuntimeCapabilityProvider;
  /** Aggregate local key/lease state. Never includes key identifiers or profile details. */
  licenseCapacity?: RuntimeLicenseCapacityProvider;
  /** Capability filter resolved from the authenticated transport token. */
  accessPolicy?: McpToolAccessPolicy;
  /**
   * The running application's version, for `get_runtime_info`. The desktop app supplies
   * `app.getVersion()`. Without it this falls back to the MCP protocol constant, which tracks the
   * contract and NOT the release — a caller asking "which build am I on?" would get the wrong
   * answer, which is how an installed 0.3.6 spent an evening reporting itself as 0.3.1.
   */
  appVersion?: string;
}

export interface MktBrowserMcpServer {
  server: Server;
  activityLog: ActivityLog;
}

const ProfileIdSchema = z.object({ profile_id: z.string().min(1) });
const NavigateSchema = ProfileIdSchema.extend({ url: z.string().url() });
const ClickSchema = ProfileIdSchema.extend({ selector: z.string().min(1) });
const TypeSchema = ProfileIdSchema.extend({
  selector: z.string().min(1),
  text: z.string(),
});
const ExtractSchema = ProfileIdSchema;

// ── CDP convenience tool schemas ────────────────────────────────────────────
const EvaluateJsSchema = ProfileIdSchema.extend({
  expression: z.string().min(1),
  sessionId: z.string().optional(),
});
const WaitForSelectorSchema = ProfileIdSchema.extend({
  selector: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});
const ListTabsSchema = ProfileIdSchema.extend({ sessionId: z.string().optional() });
const TabIdSchema = ProfileIdSchema.extend({
  target_id: z.string().min(1),
  sessionId: z.string().optional(),
});
const WaitForLoadSchema = ProfileIdSchema.extend({
  timeout_ms: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});

// ── Security-gated CDP tool schemas ─────────────────────────────────────────
const CdpSendSchema = ProfileIdSchema.extend({
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  sessionId: z.string().optional(),
});
const GetCookiesSchema = ProfileIdSchema.extend({
  // Required & non-empty: no dump-all default. Bulk cookie reads must go
  // through an explicit, scheme-scanned URL scope.
  urls: z.array(z.string().url()).min(1),
  sessionId: z.string().optional(),
});
const SetCookiesSchema = ProfileIdSchema.extend({
  cookies: z.array(z.object({ name: z.string(), value: z.string() }).passthrough()).min(1),
  sessionId: z.string().optional(),
});
const NewTabSchema = ProfileIdSchema.extend({
  url: z.string().optional(),
  sessionId: z.string().optional(),
});

/** Real device families a fingerprint can impersonate. MUST stay in lockstep
 *  with the `DeviceFamily` union in @mktbrowser/types (and the DEVICES catalog);
 *  call `list_fingerprint_options` for the human-readable catalog. */
const DEVICE_FAMILIES = [
  "macbook-pro-14-m3",
  "macbook-pro-14-m3-pro",
  "macbook-pro-16-m3-pro",
  "macbook-air-13-m3",
  "macbook-air-15-m3",
  "imac-24-m3",
  "mac-mini-m2",
  "windows-laptop-intel",
  "windows-laptop-intel-uhd",
  "windows-laptop-amd",
  "windows-laptop-nvidia",
  "windows-laptop-nvidia-4050",
  "windows-desktop-nvidia",
  "windows-desktop-nvidia-4080",
  "windows-desktop-amd",
  "windows-desktop-intel",
  "linux-desktop-intel",
  "linux-desktop-amd",
  "linux-desktop-nvidia",
] as const;

const ProxySchema = z.object({
  type: z.enum(["http", "socks5"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * User-facing fingerprint knobs. We deliberately do NOT accept the raw
 * `FingerprintConfig` (userAgent, clientHints, webgl, …): those surfaces must
 * stay mutually coherent or detection vendors flag the mismatch. Instead the
 * caller picks high-level dimensions and `reconcileFingerprint` derives a
 * coherent config — throwing FingerprintReconcileError (→ INVALID_INPUT) on an
 * incoherent combination rather than silently substituting a default.
 */
const FingerprintInputSchema = z
  .object({
    device: z.enum(DEVICE_FAMILIES).optional(),
    localeId: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    screen: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    hardwareConcurrency: z.number().int().positive().optional(),
    deviceMemory: z.number().positive().optional(),
  })
  .strict();

const CreateProfileSchema = z
  .object({
    name: z.string().min(1),
    notes: z.string().optional(),
    tags: z.array(z.string()).optional(),
    proxy: ProxySchema.optional(),
    fingerprint: FingerprintInputSchema.optional(),
    // Optional entropy seed; rotates CloakBrowser canvas/audio/WebGL noise.
    seed: z.string().min(1).optional(),
    external_ref: z.string().trim().min(1).max(200).optional(),
    request_id: z.string().trim().min(1).max(128).optional(),
    operation_id: z.string().trim().min(1).max(128).optional(),
  })
  .superRefine((input, context) => {
    const hasExternalRef = input.external_ref !== undefined;
    const hasRequestId = input.request_id !== undefined;
    if (hasExternalRef !== hasRequestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external_ref and request_id must be provided together.",
      });
    }
    if (hasExternalRef && input.seed === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Managed profile creation requires a deterministic seed.",
      });
    }
  });

const UpdateProfileSchema = ProfileIdSchema.extend({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // `null` clears the proxy; omitted leaves it untouched.
  proxy: ProxySchema.nullable().optional(),
  fingerprint: FingerprintInputSchema.optional(),
});
const ManagedLaunchSchema = ProfileIdSchema.extend({
  proxy: ProxySchema,
  operation_id: z.string().trim().min(1).max(128).optional(),
});

/**
 * Server-level guidance surfaced to any connecting agent via the MCP
 * `initialize` result. Complements the per-tool descriptions with the workflow
 * and the non-obvious constraints (profiles are real windows, headful only,
 * a human may step in) that an agent can't infer from tool signatures alone.
 */
const BASE_MCP_INSTRUCTIONS = [
  "MKT Browser drives real, persistent Chromium profiles — each has its own cookies, login state, fingerprint, and proxy, kept on disk between sessions.",
  "Only tools granted to this authenticated connection are available. Treat tools/list as authoritative and never attempt to bypass an absent capability.",
  "Profiles always open as visible desktop windows. There is no headless mode; do not expect one.",
  "Do not create or launch profiles in bulk to farm accounts; this is a human-in-the-loop tool for authorized workflows.",
];

const PROFILE_MANAGEMENT_MCP_INSTRUCTIONS = [
  ...BASE_MCP_INSTRUCTIONS,
  "",
  "This connection is profile-management only. It cannot navigate, click, type, read pages, access cookies, or send raw CDP.",
  "Use the advertised runtime, profile, fingerprint, and lifecycle tools only. MKTTool-managed profiles must remain under the managed workflow and cannot be launched directly.",
];

const FULL_LOCAL_MCP_INSTRUCTIONS = [
  ...BASE_MCP_INSTRUCTIONS,
  "",
  "Workflow:",
  "1. Call list_profiles to see available profiles and which are already running.",
  "2. Call launch_profile before any page action — navigate/click/type/extract/screenshot fail on a profile that is not running. launch_profile is idempotent.",
  "3. Use extract to read the page (URL, title, trimmed accessibility tree) and derive precise CSS selectors from it BEFORE calling click or type.",
  "4. Leave the profile running for follow-up actions; close_profile only when done. State persists either way.",
  "",
  "- A human operator shares the same window. If you hit a CAPTCHA, 2FA, or login wall, pause and let the user solve it, then continue — the session carries over.",
];

export function buildMcpInstructions(accessPolicy: McpToolAccessPolicy): string {
  const hasPageAccess = accessPolicy.capabilities.some((capability) =>
    ["page-control", "page-read", "cookie-read", "cookie-write", "raw-cdp"].includes(capability),
  );
  return (hasPageAccess ? FULL_LOCAL_MCP_INSTRUCTIONS : PROFILE_MANAGEMENT_MCP_INSTRUCTIONS).join(
    "\n",
  );
}

export function createMktBrowserMcpServer(opts: MktBrowserMcpServerOptions): MktBrowserMcpServer {
  const {
    profileManager,
    browserDriver,
    engineInfo,
    runtimeCapabilities,
    licenseCapacity,
    appVersion,
  } = opts;
  const activityLog = opts.activityLog ?? new ActivityLog();
  const accessPolicy = opts.accessPolicy ?? FULL_LOCAL_ACCESS_POLICY;
  assertMcpToolInventory(TOOL_DEFINITIONS.map((tool) => tool.name));

  const server = new Server(
    { name: MKT_BROWSER_MCP_SERVER_NAME, version: MKT_BROWSER_MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
      // Returned in the `initialize` result so a connecting agent learns the
      // overall workflow up front, not just per-tool descriptions.
      instructions: buildMcpInstructions(accessPolicy),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Hide raw cdp_send from the advertised surface unless it's explicitly
    // enabled — the default agent surface is the curated wrappers only.
    tools: TOOL_DEFINITIONS.filter(
      (tool) =>
        isMcpToolAllowed(tool.name, accessPolicy) && (tool.name !== "cdp_send" || rawCdpEnabled()),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const event = activityLog.startCall(name, args);
    const startedAt = Date.now();

    try {
      if (!isClassifiedMcpTool(name) || !isMcpToolAllowed(name, accessPolicy)) {
        throw unknownTool(name);
      }
      const result = await dispatch(name, args, {
        profileManager,
        browserDriver,
        engineInfo,
        runtimeCapabilities,
        licenseCapacity,
        appVersion,
      });
      activityLog.finish(event, "ok", summarize(result), startedAt);
      return ok(withOperationDiagnostic(result, args, "complete", startedAt, engineInfo, appVersion));
    } catch (e) {
      // The code is the contract; the message is for the local activity log only.
      const message = toErrorMessage(e);
      const code = toErrorCode(e);
      activityLog.finish(event, "error", message, startedAt);
      return err(
        code,
        message,
        operationDiagnostic(args, failureStage(name, code), startedAt, engineInfo, code, appVersion),
      );
    }
  });

  return { server, activityLog };
}

interface DispatchDeps {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
  engineInfo?: () => MktBrowserEngineInfo;
  runtimeCapabilities?: MktBrowserMcpServerOptions["runtimeCapabilities"];
  licenseCapacity?: MktBrowserMcpServerOptions["licenseCapacity"];
  appVersion?: string;
}

const UNKNOWN_ENGINE: MktBrowserEngineInfo = { kind: "unknown", version: null, status: "unknown" };

/**
 * Describe this build to MKTTool. Every value is observed here and now: a caller must be able to
 * tell a healthy device from one whose engine is still downloading, and must never infer a
 * capability from the version number alone.
 */
function buildRuntimeIdentity(engineInfo?: () => MktBrowserEngineInfo, appVersion?: string) {
  let engine = UNKNOWN_ENGINE;
  try {
    engine = engineInfo?.() ?? UNKNOWN_ENGINE;
  } catch {
    // A bootstrap that cannot answer is itself the report: keep `unknown` instead of failing the
    // one call a caller makes to find out why the device is unhealthy.
  }

  return {
    provider: MKT_BROWSER_MCP_SERVER_NAME,
    appVersion: appVersion ?? MKT_BROWSER_MCP_SERVER_VERSION,
    contractVersion: MKT_BROWSER_CONTRACT_VERSION,
    profileSchemaVersion: MKT_BROWSER_PROFILE_SCHEMA_VERSION,
    engine,
  };
}

export async function buildRuntimeInfo(options: {
  engineInfo?: () => MktBrowserEngineInfo;
  runtimeCapabilities?: MktBrowserMcpServerOptions["runtimeCapabilities"];
  licenseCapacity?: MktBrowserMcpServerOptions["licenseCapacity"];
  appVersion?: string;
} = {}): Promise<MktBrowserRuntimeInfo> {
  const [capabilities, licenseCapacity] = await Promise.all([
    resolveRuntimeCapabilities(options.runtimeCapabilities),
    resolveRuntimeLicenseCapacity(options.licenseCapacity),
  ]);
  return {
    ...buildRuntimeIdentity(options.engineInfo, options.appVersion),
    capabilities,
    licenseCapacity,
  };
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<unknown> {
  const { profileManager, browserDriver } = deps;
  switch (name) {
    case "get_runtime_info": {
      return await buildRuntimeInfo(deps);
    }
    case "list_profiles": {
      const profiles = profileManager.list().map((p) => ({
        ...p,
        // Never echo proxy endpoints or credentials to the agent.
        proxy: sanitizedProxySummary(p.proxy),
        isRunning: browserDriver.isRunning(p.id),
      }));
      return { profiles };
    }
    case "create_profile": {
      const input = CreateProfileSchema.parse(args);
      const createInput: CreateProfileInput = {
        name: input.name,
        notes: input.notes,
        tags: input.tags,
        proxy: input.proxy,
      };
      const seed = input.seed;
      // Build a fingerprint when the caller passes knobs OR a seed. Seed from a
      // fresh coherent fingerprint, apply the high-level knobs (throws on an
      // incoherent combination → INVALID_INPUT), then persist the seed.
      if (input.fingerprint || seed) {
        const reconciled = reconcileFingerprint(generateFingerprint(seed), input.fingerprint ?? {});
        createInput.fingerprint = seed ? { ...reconciled, seed } : reconciled;
      }
      const result = input.request_id
        ? profileManager.createIdempotent(createInput, {
            externalRef: input.external_ref!,
            requestId: input.request_id,
            requestHash: managedCreateRequestHash(input),
          })
        : { profile: profileManager.create(createInput), created: true };
      const created = result.profile;
      return {
        id: created.id,
        name: created.name,
        created: result.created,
        proxy: sanitizedProxySummary(created.proxy),
        fingerprint: fingerprintSummary(created.fingerprint),
        managed: created.managed,
      };
    }
    case "update_profile": {
      const input = UpdateProfileSchema.parse(args);
      const existing = profileManager.get(input.profile_id);
      if (!existing) throw profileNotFound(input.profile_id);

      const patch: UpdateProfileInput = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.tags !== undefined) patch.tags = input.tags;
      // `proxy: null` clears it, `proxy: {…}` sets it, omitted leaves as-is.
      if (input.proxy !== undefined) patch.proxy = input.proxy;
      if (input.fingerprint !== undefined) {
        patch.fingerprint = reconcileFingerprint(existing.fingerprint, input.fingerprint);
      }

      const updated = profileManager.update(input.profile_id, patch);
      return {
        id: updated.id,
        name: updated.name,
        tags: updated.tags,
        proxy: sanitizedProxySummary(updated.proxy),
        fingerprint: fingerprintSummary(updated.fingerprint),
        // Surface the caveat: a live browser keeps the old proxy/fingerprint.
        appliesOnNextLaunch: browserDriver.isRunning(input.profile_id),
      };
    }
    case "list_fingerprint_options": {
      return { devices: deviceCatalog(), locales: localeCatalog() };
    }
    case "launch_managed_profile": {
      const { profile_id, proxy } = ManagedLaunchSchema.parse(args);
      const existing = assertProfileExists(profileManager, profile_id);
      if (!existing.managed) throw unmanagedProfileLaunch(profile_id);
      return await launchManagedProfile(profile_id, proxy, { profileManager, browserDriver });
    }
    case "launch_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      const existing = assertProfileExists(profileManager, profile_id);
      if (existing.managed) throw managedProfileLocked(profile_id);
      // ChromiumBrowserDriver.launch() handles markOpened internally so
      // every entry-point (UI, MCP, palette) gets the same timestamp.
      const launched = await browserDriver.launch(profile_id);
      return launched;
    }
    case "close_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      await browserDriver.close(profile_id);
      return { closed: profile_id };
    }
    case "navigate": {
      const { profile_id, url } = NavigateSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // z.string().url() accepts file://; reject privileged schemes here.
      assertSafeUrl(url);
      return await browserDriver.navigate(profile_id, url);
    }
    case "click": {
      const { profile_id, selector } = ClickSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.click(profile_id, selector);
    }
    case "type": {
      const { profile_id, selector, text } = TypeSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.type(profile_id, selector, text);
    }
    case "extract": {
      const { profile_id } = ExtractSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.extract(profile_id);
    }
    case "screenshot": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.screenshot(profile_id);
    }
    case "evaluate_js": {
      const { profile_id, expression, sessionId } = EvaluateJsSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // Runtime.evaluate works without Runtime.enable — no domain is enabled.
      return await browserDriver.cdpSend(
        profile_id,
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
        { safe: true },
      );
    }
    case "wait_for_selector": {
      const { profile_id, selector, timeout_ms, sessionId } = WaitForSelectorSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
      const found = await pollUntil(async () => {
        const res = (await browserDriver.cdpSend(
          profile_id,
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
          { safe: true },
        )) as { result?: { value?: unknown } };
        return res?.result?.value === true;
      }, timeout_ms ?? 30000);
      return { found, selector };
    }
    case "list_tabs": {
      const { profile_id, sessionId } = ListTabsSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(profile_id, "Target.getTargets", {}, sessionId, {
        safe: true,
      });
    }
    case "activate_tab": {
      const { profile_id, target_id, sessionId } = TabIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(
        profile_id,
        "Target.activateTarget",
        { targetId: target_id },
        sessionId,
        { safe: true },
      );
    }
    case "close_tab": {
      const { profile_id, target_id, sessionId } = TabIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(
        profile_id,
        "Target.closeTarget",
        { targetId: target_id },
        sessionId,
        { safe: true },
      );
    }
    case "wait_for_navigation":
    case "wait_for_load": {
      const { profile_id, timeout_ms, sessionId } = WaitForLoadSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // `Page` is enabled at connect, but waiting on the loadEventFired event
      // requires an event subscription the single cdpSend primitive can't
      // express. Polling document.readyState gives the same readiness signal
      // purely through Runtime.evaluate (no domain enable).
      const loaded = await pollUntil(async () => {
        const res = (await browserDriver.cdpSend(
          profile_id,
          "Runtime.evaluate",
          { expression: "document.readyState", returnByValue: true },
          sessionId,
          { safe: true },
        )) as { result?: { value?: unknown } };
        return res?.result?.value === "complete";
      }, timeout_ms ?? 30000);
      return { loaded };
    }
    case "cdp_send": {
      // Opt-in only: raw CDP is off by default. Reject even a direct call (the
      // tool is also hidden from tools/list) unless explicitly enabled.
      if (!rawCdpEnabled()) {
        throw new CdpPolicyError(
          "raw cdp_send is disabled. Set MKT_BROWSER_MCP_ALLOW_RAW_CDP=1 to enable it " +
            "(power-user / trusted context); the curated tools (evaluate_js, get_cookies, " +
            "list_tabs, wait_for_*, …) cover normal use.",
        );
      }
      const { profile_id, method, params, sessionId } = CdpSendSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // Engine-independent gate: denylisted method or blocked URL scheme in any
      // param → CdpPolicyError (FORBIDDEN), driver never called.
      assertCdpMethodAllowed(method, params);
      return await browserDriver.cdpSend(profile_id, method, params, sessionId, { safe: true });
    }
    case "get_cookies": {
      const { profile_id, urls, sessionId } = GetCookiesSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      for (const u of urls) assertSafeUrl(u);
      // Network.getCookies works without Network.enable; the urls scope is
      // required (no dump-all) — bulk reads must be explicitly scoped.
      return await browserDriver.cdpSend(profile_id, "Network.getCookies", { urls }, sessionId, {
        safe: true,
      });
    }
    case "set_cookies": {
      const { profile_id, cookies, sessionId } = SetCookiesSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // Network.setCookies (plural) sets the whole batch in one call without
      // Network.enable.
      return await browserDriver.cdpSend(profile_id, "Network.setCookies", { cookies }, sessionId, {
        safe: true,
      });
    }
    case "new_tab": {
      const { profile_id, url, sessionId } = NewTabSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      if (url) assertSafeUrl(url);
      return await browserDriver.cdpSend(
        profile_id,
        "Target.createTarget",
        { url: url ?? "about:blank" },
        sessionId,
        { safe: true },
      );
    }
    default:
      throw unknownTool(name);
  }
}

const PROXY_JSON_SCHEMA = {
  type: "object",
  description: "Per-profile proxy. DNS is resolved remotely via a local SOCKS5 bridge.",
  required: ["type", "host", "port"],
  properties: {
    type: { type: "string", enum: ["http", "socks5"] },
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string" },
    password: { type: "string" },
  },
} as const;

const FINGERPRINT_JSON_SCHEMA = {
  type: "object",
  description:
    "High-level fingerprint dimensions. The server derives a coherent UA / Client-Hints / WebGL / locale story from these — raw surfaces cannot be set individually. All fields optional; an incoherent combination is rejected (INVALID_INPUT).",
  properties: {
    device: {
      type: "string",
      enum: [...DEVICE_FAMILIES],
      description: "Device family to impersonate (see list_fingerprint_options).",
    },
    localeId: {
      type: "string",
      description: "Locale group id, e.g. 'en-US', 'de-DE' (see list_fingerprint_options).",
    },
    timezone: {
      type: "string",
      description: "IANA timezone; must belong to the chosen locale.",
    },
    screen: {
      type: "object",
      required: ["width", "height"],
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
    hardwareConcurrency: { type: "integer", minimum: 1 },
    deviceMemory: { type: "number", minimum: 1 },
  },
} as const;

const TOOL_DEFINITIONS = [
  {
    name: "get_runtime_info",
    description:
      "Report this build's provider, app version, contract version, profile schema version, browser-engine state, and implemented capabilities. Call it before deciding which other tools to use; do not infer capabilities from the version number.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_profiles",
    description:
      "List all browser profiles available on this machine. Returns id, name, tags, last opened, and running state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_profile",
    description:
      "Create a new browser profile. Only `name` is required; a coherent default fingerprint is generated. Managed callers pass `external_ref`, `request_id`, and a deterministic `seed`; exact retries return the original profile instead of creating a duplicate. Optionally pass a `proxy` and high-level `fingerprint` knobs. Call list_fingerprint_options for valid device families and locale ids.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Human-readable name" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: PROXY_JSON_SCHEMA,
        fingerprint: FINGERPRINT_JSON_SCHEMA,
        seed: {
          type: "string",
          description: "Optional entropy seed for the native fingerprint noise.",
        },
        external_ref: {
          type: "string",
          description: "Stable MKTTool-owned reference for idempotent managed creation.",
        },
        request_id: {
          type: "string",
          description: "Retry-stable request identifier. Requires external_ref and seed.",
        },
        operation_id: {
          type: "string",
          description: "Ticket jti used only for sanitized operation correlation.",
        },
      },
    },
  },
  {
    name: "launch_managed_profile",
    description:
      "Atomically persist and verify the requested proxy before launch. If the profile is already running, returns it only when the active proxy matches; otherwise rejects without changing the running session.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "proxy"],
      properties: {
        profile_id: { type: "string" },
        proxy: PROXY_JSON_SCHEMA,
        operation_id: {
          type: "string",
          description: "Ticket jti used only for sanitized operation correlation.",
        },
      },
    },
  },
  {
    name: "launch_profile",
    description:
      "Launch a profile in patched Chromium. Returns CDP endpoint. Idempotent: returns existing endpoint if already running.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "close_profile",
    description: "Close a running profile. Cookies and state remain on disk.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "navigate",
    description: "Navigate the profile's browser to a URL. Waits for page load.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "url"],
      properties: {
        profile_id: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    },
  },
  {
    name: "click",
    description:
      "Click an element by CSS selector. The selector must be precise — call extract first to inspect the page accessibility tree, then derive a selector from it.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector"],
      properties: {
        profile_id: { type: "string" },
        selector: {
          type: "string",
          description: "CSS selector, e.g. 'button[type=submit]' or 'input[name=email]'",
        },
      },
    },
  },
  {
    name: "type",
    description: "Type text into an input element by CSS selector.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector", "text"],
      properties: {
        profile_id: { type: "string" },
        selector: { type: "string", description: "CSS selector for the input element" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "extract",
    description:
      "Snapshot the current page: returns the URL, title, and a trimmed accessibility tree. The calling LLM is responsible for parsing this into whatever structured data it needs. MKT Browser does not call an AI API.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the current viewport. Returns base64.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "update_profile",
    description:
      "Update an existing profile's name, notes, tags, proxy, and/or fingerprint. Every field is optional — only the ones you pass change. Set `proxy` to null to remove it. Fingerprint changes are reconciled for coherence. If the profile is running, changes apply on the next launch (response includes appliesOnNextLaunch). Proxy credentials are never echoed back.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        name: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: {
          description: "Proxy object to set, or null to clear. Omit to leave unchanged.",
          anyOf: [PROXY_JSON_SCHEMA, { type: "null" }],
        },
        fingerprint: FINGERPRINT_JSON_SCHEMA,
      },
    },
  },
  {
    name: "list_fingerprint_options",
    description:
      "List the valid fingerprint building blocks: device families (with their real screen sizes) and locale groups (locale, country, plausible timezones). Use these values for the `device`, `localeId`, `timezone`, and `screen` fields of create_profile / update_profile.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evaluate_js",
    description:
      "Evaluate a JavaScript expression in the page and return the result by value. Runs via Runtime.evaluate without enabling the Runtime domain (stealth-safe).",
    inputSchema: {
      type: "object",
      required: ["profile_id", "expression"],
      properties: {
        profile_id: { type: "string" },
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_selector",
    description:
      "Poll the page until an element matching the CSS selector exists, or the timeout elapses. Returns { found, selector }. Uses Runtime.evaluate polling (no domain enable).",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector"],
      properties: {
        profile_id: { type: "string" },
        selector: { type: "string", description: "CSS selector to wait for" },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Wait budget in ms (default 30000)",
        },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "list_tabs",
    description: "List open targets (tabs/pages) via Target.getTargets.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" }, sessionId: { type: "string" } },
    },
  },
  {
    name: "activate_tab",
    description: "Bring a tab to the foreground via Target.activateTarget.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "target_id"],
      properties: {
        profile_id: { type: "string" },
        target_id: { type: "string", description: "Target id from list_tabs" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "close_tab",
    description: "Close a tab via Target.closeTarget.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "target_id"],
      properties: {
        profile_id: { type: "string" },
        target_id: { type: "string", description: "Target id from list_tabs" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_navigation",
    description:
      "Wait until the page finishes loading (document.readyState === 'complete'), or the timeout elapses. Returns { loaded }. Polls via Runtime.evaluate (no domain enable).",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Wait budget in ms (default 30000)",
        },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_load",
    description:
      "Alias of wait_for_navigation: wait until document.readyState === 'complete' or the timeout elapses. Returns { loaded }.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Wait budget in ms (default 30000)",
        },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "cdp_send",
    description:
      "OPT-IN (requires MKT_BROWSER_MCP_ALLOW_RAW_CDP=1; off by default — prefer the curated tools). Send a raw Chrome DevTools Protocol command (stealth-safe). Any domain this call had to enable is auto-disabled afterwards so the anti-detect baseline is preserved; domains enabled at connect (Page) are never touched. On anti-detect engines, enabling a DCHECK-sensitive domain (Runtime/Network) is refused — use the convenience wrappers (evaluate_js, get_cookies, …) which need no enable. For safety, host-reaching and cross-origin-secret methods (IO.read, Fetch.*, Storage.getCookies, …) and privileged/local URL schemes (file:/chrome:/devtools:/view-source:) are rejected.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "method"],
      properties: {
        profile_id: { type: "string" },
        method: { type: "string", description: "CDP method, e.g. 'Runtime.evaluate'" },
        params: { type: "object", description: "CDP command params" },
        sessionId: {
          type: "string",
          description: "Optional flattened CDP sessionId for a sub-target",
        },
      },
    },
  },
  {
    name: "get_cookies",
    description:
      "Get cookies for one or more URLs via Network.getCookies (no Network.enable needed). `urls` is REQUIRED and non-empty — the scope must be explicit; dumping the entire cookie store is not allowed.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "urls"],
      properties: {
        profile_id: { type: "string" },
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Required non-empty list of URLs to scope the cookie read to.",
        },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "set_cookies",
    description:
      "Set one or more cookies via Network.setCookies (no Network.enable needed). Each cookie needs at least name and value; CDP fields like url, domain, path, expires, httpOnly, secure, sameSite are also accepted.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "cookies"],
      properties: {
        profile_id: { type: "string" },
        cookies: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "value"],
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              url: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
            },
          },
        },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "new_tab",
    description:
      "Open a new tab via Target.createTarget. Defaults to about:blank if no url is given. Rejects file:/chrome:/devtools:/view-source: URLs.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        url: { type: "string", description: "URL to open (default about:blank)" },
        sessionId: { type: "string" },
      },
    },
  },
];

function managedCreateRequestHash(input: z.infer<typeof CreateProfileSchema>): string {
  const {
    external_ref: _externalRef,
    request_id: _requestId,
    operation_id: _operationId,
    ...profileRequest
  } = input;
  return createHash("sha256").update(JSON.stringify(profileRequest)).digest("hex");
}

/** Coherent, non-secret view of a fingerprint for tool responses. */
function fingerprintSummary(fp: FingerprintConfig): {
  device: string;
  locale: string;
  timezone: string;
  screen: { width: number; height: number };
  userAgent: string;
} {
  return {
    device: fp.device,
    locale: fp.locale,
    timezone: fp.timezone,
    screen: fp.screen,
    userAgent: fp.userAgent,
  };
}

/**
 * Proxy view safe to return to an MCP caller: never echo endpoint or credentials.
 * Redacting the response also defeats the `update_profile {name}`-only
 * proxy read-back (a caller must never learn stored connection details).
 */
export function sanitizedProxySummary(
  proxy: ProxyConfig | null | undefined,
): { type: string; configured: true; hasAuth: boolean } | null {
  if (!proxy) return null;
  return {
    type: proxy.type,
    configured: true,
    hasAuth: Boolean(proxy.username || proxy.password),
  };
}

function summarize(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const keys = Object.keys(result).slice(0, 5).join(", ");
    return `keys: ${keys}`;
  }
  return String(result);
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(code: string, message: string, diagnostic?: MktBrowserOperationDiagnostic) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message }, ...(diagnostic ? { diagnostic } : {}) }),
      },
    ],
  };
}

function assertProfileExists(pm: ProfileManager, id: string) {
  const p = pm.get(id);
  if (!p) throw profileNotFound(id);
  return p;
}

function withOperationDiagnostic(
  result: unknown,
  args: Record<string, unknown>,
  stage: string,
  startedAt: number,
  engineInfo?: () => MktBrowserEngineInfo,
  appVersion?: string,
): unknown {
  const diagnostic = operationDiagnostic(args, stage, startedAt, engineInfo, undefined, appVersion);
  if (!diagnostic) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), diagnostic };
  }
  return { result, diagnostic };
}

function operationDiagnostic(
  args: Record<string, unknown>,
  stage: string,
  startedAt: number,
  engineInfo?: () => MktBrowserEngineInfo,
  code?: MktBrowserOperationDiagnostic["code"],
  appVersion?: string,
): MktBrowserOperationDiagnostic | undefined {
  const operationId = args.operation_id;
  if (typeof operationId !== "string" || operationId === "") return undefined;

  const runtime = buildRuntimeIdentity(engineInfo, appVersion);
  const requestId = args.request_id;
  return {
    operationId,
    ...(typeof requestId === "string" && requestId !== "" ? { requestId } : {}),
    stage,
    ...(code ? { code } : {}),
    durationMs: Date.now() - startedAt,
    runtime: {
      appVersion: runtime.appVersion,
      contractVersion: runtime.contractVersion,
      profileSchemaVersion: runtime.profileSchemaVersion,
      engine: runtime.engine,
    },
  };
}

function failureStage(name: string, code: MktBrowserOperationDiagnostic["code"]): string {
  if (code === "INVALID_INPUT") return "validate-input";
  if (name === "create_profile") return "create-profile";
  if (name === "launch_managed_profile") {
    if (code === "PROFILE_NOT_FOUND" || code === "PROFILE_ALREADY_RUNNING") {
      return "inspect-profile";
    }
    if (code === "PROXY_REJECTED") return "apply-or-verify-proxy";
    return "launch-profile";
  }
  return "dispatch";
}

function assertProfileRunning(driver: BrowserDriver, id: string): void {
  if (!driver.isRunning(id)) throw profileNotRunning(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient CDP failures raised while a target is mid-navigation: the V8
 * execution context is torn down and recreated, so an in-flight Runtime.evaluate
 * can reject even though the page is perfectly fine a moment later. These are
 * safe to swallow and retry; any other error is a genuine failure (e.g. an
 * invalid selector expression) and must surface immediately.
 */
const TRANSIENT_NAVIGATION_ERROR =
  /execution context was destroyed|Cannot find context|Inspected target (navigated|closed)|No execution context/i;

function isTransientNavigationError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return TRANSIENT_NAVIGATION_ERROR.test(message);
}

/**
 * Poll `check` on a fixed 150ms backoff until it returns true or the budget is
 * exhausted. Returns the final boolean rather than throwing so wait_* tools
 * can report a clean `{ found/loaded: false }` on a normal timeout.
 *
 * Scoped retry: transient navigation errors (execution context destroyed while
 * the page reloads) are swallowed and retried until the budget runs out — never
 * masking real errors, which propagate immediately. If only transient errors
 * are seen right up to the deadline, a clear timeout error is thrown so the
 * caller is not told the page settled when it never did.
 */
async function pollUntil(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let lastTransient: Error | undefined;
  for (;;) {
    try {
      if (await check()) return true;
      lastTransient = undefined; // a clean check ran: not stuck on a transient error
    } catch (e) {
      if (!isTransientNavigationError(e)) throw e;
      lastTransient = e instanceof Error ? e : new Error(String(e));
    }
    if (Date.now() >= deadline) {
      if (lastTransient) {
        throw new Error(
          `Timed out after ${budgetMs}ms waiting for the page to settle; ` +
            `last transient navigation error: ${lastTransient.message}`,
        );
      }
      return false;
    }
    await sleep(150);
  }
}
