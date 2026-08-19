/**
 * CloakBrowser "Pro" download channel — the licensed distribution.
 *
 * WHY THIS EXISTS
 * CloakBrowser went commercial in May 2026. Its GitHub releases stopped
 * carrying platform binaries after `chromium-v146.0.7680.177.5` (21 May 2026);
 * every release since publishes only SHA256SUMS + SHA256SUMS.sig. The keyless
 * tier is pinned to that same 146 build (verified in the upstream wrapper's
 * `config.js`: `CHROMIUM_VERSION = "146.0.7680.177.5"`), so the GitHub path in
 * ChromiumBootstrap silently froze there — five Chrome majors behind stable.
 *
 * Running a stale major is itself a detection signal: real Chrome auto-updates
 * hard, so a 146 user-agent in August 2026 is a rarity, and rarity is entropy.
 * Upstream says as much in its own 151 release notes.
 *
 * THE CHANNEL
 *   version   GET  https://cloakbrowser.dev/api/download/version
 *                  header: X-Platform    (no key needed)
 *   checksums GET  https://cloakbrowser.dev/releases/pro/chromium-v<ver>/SHA256SUMS
 *                  (public — no key needed)
 *   binary    GET  https://cloakbrowser.dev/api/download/<ver>
 *                  headers: Authorization: Bearer <key>, X-Platform
 *
 * Only the archive itself is gated. Archive naming (`cloakbrowser-windows-x64.zip`)
 * matches the GitHub assets exactly, so the caller's extract/verify/cache path
 * needs no changes — this module only resolves *where to fetch from*.
 *
 * REDIRECT / AUTH HAZARD (measured, not theoretical)
 * The archive endpoint answers 302 to a presigned Cloudflare R2 URL. R2 carries
 * its own signature in the query string and rejects a request that also sends an
 * `Authorization` header — it replies HTTP 400.
 *
 * `fetch` never trips on this: per the Fetch spec it strips `Authorization` on a
 * cross-origin redirect. Electron's `net.request` — which the bootstrap uses to
 * stay on Chromium's network stack — forwards the header instead, so following
 * the redirect with credentials attached fails every download.
 *
 * `removeHeader()` cannot rescue it either: Electron forbids header changes
 * after the request has been sent, which is the only moment the redirect is
 * known. So the redirect is resolved HERE, with `fetch`, and the caller receives
 * the final self-authenticating URL and no headers at all.
 *
 * The presigned URL is short-lived. That is safe because the bootstrap resolves
 * a manifest immediately before transferring it, and its retry budget (5
 * attempts, linear backoff, ~20 s total) is far inside any sane expiry. It is
 * never persisted: `current.json` stores version/sha256/path, not the URL.
 *
 * RUNTIME LICENSING
 * The Pro binary verifies its own licence on every launch, reading
 * `CLOAKBROWSER_LICENSE_KEY` from its process environment, and exits with a
 * dedicated code when it refuses. `licenseExitMessage()` turns those codes into
 * something an operator can act on — without it a refusal surfaces as an opaque
 * "browser closed unexpectedly". Note exit 78: a launch needs cloakbrowser.dev
 * to be reachable, so a blocked or down licence server stops the browser
 * starting at all.
 */

/** Base origin for the licensed channel. Overridable for tests / self-hosting. */
export const CLOAKBROWSER_DOWNLOAD_BASE =
  process.env.CLOAKBROWSER_DOWNLOAD_URL || "https://cloakbrowser.dev";

/** Platform tag used by both the archive name and the `X-Platform` header. */
export type CloakBrowserPlatformTag =
  | "windows-x64"
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64"
  | "darwin-x64";

export function cloakBrowserPlatformTag(): CloakBrowserPlatformTag {
  if (process.platform === "win32") return "windows-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** Windows ships a .zip, every other platform a .tar.gz — same as the GitHub assets. */
export function cloakBrowserArchiveName(tag = cloakBrowserPlatformTag()): string {
  return `cloakbrowser-${tag}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
}

export interface CloakBrowserProManifest {
  version: string;
  /**
   * Ready-to-transfer URL. Usually the presigned storage URL the licensed
   * endpoint redirects to, in which case `headers` is empty — see the
   * redirect/auth note above.
   */
  url: string;
  sha256?: string;
  /** Empty once the redirect has been resolved; populated only if the endpoint
   *  served the archive directly, without redirecting. */
  headers: Record<string, string>;
}

/**
 * Resolve the latest licensed build for this platform.
 *
 * Throws on a transport failure rather than falling back to the keyless 146
 * binary: silently downgrading five majors is precisely the outcome this
 * module exists to prevent, and a caller that wants the old path can ask for
 * it explicitly.
 */
export async function resolveCloakBrowserProManifest(
  licenseKey: string,
): Promise<CloakBrowserProManifest> {
  const key = licenseKey.trim();
  if (!key) {
    throw new Error("A CloakBrowser licence key is required for the Pro download channel.");
  }
  const tag = cloakBrowserPlatformTag();
  const version = await fetchLatestProVersion(tag);
  const gatedUrl = `${CLOAKBROWSER_DOWNLOAD_BASE}/api/download/${version}`;
  const authHeaders = { Authorization: `Bearer ${key}`, "X-Platform": tag };
  const resolved = await resolveArchiveRedirect(gatedUrl, authHeaders);
  return {
    version,
    url: resolved.url,
    sha256: await fetchProSha256(version, cloakBrowserArchiveName(tag)),
    headers: resolved.headers,
  };
}

/**
 * Exchange the credentialed endpoint for a directly transferable URL.
 *
 * On 3xx: return the redirect target with NO headers — it is presigned and
 * would reject the Authorization header (HTTP 400).
 * On 2xx: the endpoint serves bytes itself, so keep the credentials.
 *
 * Uses `redirect: "manual"` rather than following, because the whole point is
 * to observe the Location instead of letting the stack re-send credentials to
 * another origin.
 */
async function resolveArchiveRedirect(
  gatedUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ url: string; headers: Record<string, string> }> {
  const res = await fetch(gatedUrl, {
    method: "GET",
    headers: { ...authHeaders, Range: "bytes=0-0" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`CloakBrowser redirected with HTTP ${res.status} but sent no Location.`);
    }
    // Resolve relative Locations against the endpoint; reject anything that
    // isn't https so a downgraded redirect can't move the transfer to plaintext.
    const target = new URL(location, gatedUrl);
    if (target.protocol !== "https:") {
      throw new Error(`CloakBrowser redirected to a non-HTTPS location (${target.protocol}).`);
    }
    return { url: target.toString(), headers: {} };
  }
  if (res.status === 200 || res.status === 206) {
    return { url: gatedUrl, headers: authHeaders };
  }
  // 401/403 => key problem; 429 => rate limit. Surface the code; the body may
  // name the reason and never contains the key.
  const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
  throw new Error(
    `CloakBrowser refused the archive request with HTTP ${res.status}` +
      (detail ? ` — ${detail}` : ""),
  );
}

async function fetchLatestProVersion(tag: CloakBrowserPlatformTag): Promise<string> {
  const res = await fetch(`${CLOAKBROWSER_DOWNLOAD_BASE}/api/download/version`, {
    headers: { "X-Platform": tag },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} resolving the latest CloakBrowser version`);
  }
  const data = (await res.json()) as { version?: unknown };
  const version = data.version == null ? "" : String(data.version);
  // Guard the shape before it reaches a URL: the version is interpolated into
  // both the download path and the checksum path.
  //
  // Five components, not four: CloakBrowser appends its own patch number to the
  // Chromium version (e.g. "151.0.7922.108.2" = Chromium 151.0.7922.108, build
  // 2). A 3-4 component guard rejected every real version and stalled the
  // bootstrap — caught end-to-end, since nothing upstream of here validates.
  if (!/^\d+(\.\d+){2,4}$/.test(version)) {
    throw new Error(`CloakBrowser returned an unusable version string: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Pull the archive's SHA-256 from the release's public manifest.
 *
 * Returns undefined when the manifest can't be fetched or doesn't list our
 * archive — the caller treats a missing checksum the same way it already does
 * for the GitHub path (download proceeds, integrity unverified) rather than
 * blocking a launch on a checksum-server hiccup.
 */
async function fetchProSha256(version: string, archiveName: string): Promise<string | undefined> {
  const url = `${CLOAKBROWSER_DOWNLOAD_BASE}/releases/pro/chromium-v${version}/SHA256SUMS`;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      // Lines look like "<64-hex>  cloakbrowser-windows-x64.zip"; a leading "*"
      // marks binary mode in some sha256sum dialects. The file also opens with
      // a "version=..." line, which simply won't match.
      const [hash, name] = line.trim().split(/\s+/, 2);
      if (hash && name?.replace(/^\*/, "") === archiveName && /^[a-f0-9]{64}$/i.test(hash)) {
        return hash.toLowerCase();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exit codes the Pro binary uses to refuse a launch for licensing reasons.
 * It emits the number only — no diagnostic text — so the wording lives here.
 * Mirrors the upstream wrapper's table so operators see the same guidance.
 */
const LICENSE_EXIT_MESSAGES: Readonly<Record<number, string>> = {
  76:
    "CloakBrowser: your plan's session limit is reached. Close another running profile, " +
    "or raise the limit at https://cloakbrowser.dev (the free key allows one at a time).",
  77:
    "CloakBrowser: the licence key is missing, invalid, or expired. " +
    "Check the key in Settings, or get one at https://cloakbrowser.dev/free.",
  78:
    "CloakBrowser: the licence server could not be reached, so the browser refused to start. " +
    "Check the connection — note the licence check does not go through the profile's proxy.",
  79: "CloakBrowser: local licence state is not writable (~/.cloakbrowser). Check folder permissions.",
};

/** Human-readable reason for a licence refusal, or null for any other exit. */
export function licenseExitMessage(exitCode: number | null): string | null {
  if (exitCode == null) return null;
  return LICENSE_EXIT_MESSAGES[exitCode] ?? null;
}
