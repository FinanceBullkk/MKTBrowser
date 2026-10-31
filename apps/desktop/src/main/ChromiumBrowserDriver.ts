import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserDriver } from "@mktbrowser/mcp-server";
import {
  engineUnavailable,
  profileAlreadyRunning,
  profileNotFound,
  profileNotRunning,
  proxyRejected,
} from "@mktbrowser/mcp-server";
import type { ProfileManager } from "@mktbrowser/profile-manager";
import { ProfileDeletionPendingError } from "@mktbrowser/profile-manager";
import type { LaunchedProfile, ProfileId } from "@mktbrowser/types";
import type { RunningProfileState } from "@mktbrowser/mcp-server";
import { waitForCdpSessionReady } from "./cdpReadiness";
import type { BrowserEngine } from "@mktbrowser/settings-store";
import { CdpSession } from "@mktbrowser/cdp-driver";
import type { ChromiumBootstrap } from "./ChromiumBootstrap";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { probeProxyGeo } from "./proxyGeo";
import { verifyProxyGeoLaunch } from "./proxyGeoLaunch.ts";
import { companionDir } from "./extensions/companion";
import { resolveLoadDir } from "./extensions/extensionStore.ts";
import { sanitizeStartUrl } from "./startPage";
import {
  enumerateBrowserProcessesUsingDataDir,
  findBrowserProcessesUsingDataDir,
  selectPrimaryBrowserPid,
} from "./browser-process-discovery";
import {
  clearStaleDevToolsActivePort,
  waitForOwnedDevToolsEndpoint,
} from "./devtools-port-discovery.ts";
import { assertWindowsWebRtcFirewallProtection } from "./windows-webrtc-firewall.ts";
import { licenseExitMessage } from "./cloakbrowser-pro-channel.ts";
import { classifyLaunchExit, isSeatRefusal, settleLicenceVerdict } from "./licence-verdict.ts";
import {
  isPidAlive,
  writeProfileLifecycleLog,
  type LaunchingProcess,
  type ProfileLifecycleLogContext,
  type RunningProcess,
} from "./browser-process-tracking.ts";
import { buildCloakBrowserFingerprintArgs } from "./chromium-fingerprint-args.ts";
import {
  isCdpEndpointReachable,
  terminateBrowserProcess,
  withTimeout,
  type ShutdownMethod,
} from "./browser-shutdown-sequence.ts";
import { createWindowWatcher, fetchErrorCode } from "./browser-window-watcher.ts";
import { parseChromiumVersion, reconcileVersionInFingerprint } from "./chromium-version-detection.ts";
import { buildBrowserLaunchEnvironment } from "./browser-launch-environment.ts";
import {
  cloakBrowserSdkLicenseExitCode,
  discoverCloakBrowserSdkProcess,
  launchCloakBrowserSdkLifecycle,
  type CloakBrowserSdkLifecycle,
} from "./cloakbrowser-sdk-lifecycle.ts";
import { disableMacOsPersistentStateRestore } from "./chromium-managed-preferences.ts";
import {
  browserDataDirForEngine,
  cleanStaleSingletonLocks,
  ensureSessionRestore,
  hasRestorableSession,
} from "./chromium-profile-data-dir.ts";

/**
 * The right error for a child that died during launch.
 *
 * Built here rather than in `licence-verdict.ts` because `engineUnavailable` lives in the MCP
 * package: the classification stays testable without a built workspace, and only the wrapping
 * happens where the dependency already is.
 *
 * A licence exit carries `licenseExitCode` so the rotation loop can read the engine's verdict
 * instead of the operator-facing wording, which is meant to be rewritten. `isSeatRefusal` is what
 * narrows that to the single code worth trying another key for.
 */
function launchExitError(exitCode: number | null, stage: string): Error {
  const { licenceReason, fallbackMessage } = classifyLaunchExit(exitCode, stage);
  if (licenceReason) {
    const refusal = engineUnavailable(licenceReason);
    (refusal as { licenseExitCode?: number }).licenseExitCode = exitCode ?? undefined;
    return refusal;
  }
  return new Error(fallbackMessage);
}
import { appendProfileLifecycleLine } from "./profile-lifecycle-log.ts";
import { LicenseKeyPool, keyTail } from "./license-key-pool.ts";
import { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import {
  LicenseSeatAdmissionError,
  LicenseSeatCoordinator,
} from "./license-seat-coordinator.ts";
import { didBrowserExitReleaseSeat } from "./license-seat-exit-verdict.ts";
import { licenseSeatWaitMessage } from "./license-seat-wait-message.ts";
import {
  fastLicenseReuseEnabled,
  shouldDetachBrowserProcess,
  shouldUseCloakBrowserSdkLifecycle,
} from "./license-lifecycle-policy.ts";
import { stableWindowsRuntime, win32PathEquals } from "./chromium-runtime-path.ts";
import { disableFeaturesArg, networkPrivacySwitches } from "./chromium-network-privacy-flags.ts";

export interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
  chromiumBootstrap: ChromiumBootstrap;
  startupBarrier?: Promise<void>;
  /**
   * Which licence key each profile launches with. The engine binds one session per key, so this is
   * what decides how many profiles can be open at once. Absent, every launch uses the bootstrap's
   * single key and concurrency is whatever that one key allows.
   */
  licenseKeyPool?: LicenseKeyPool;
  /**
   * Persists which seats this machine may still be holding, so a browser that died without
   * flushing its shutdown is still known about after a restart. Optional: an install with no
   * licensed engine has no leases to record.
   */
  licenseLeaseRecorder?: LicenseLeaseRecorder;
  /** Serializes vendor observation, local reservation and one-attempt admission. */
  licenseSeatCoordinator?: LicenseSeatCoordinator;
  /** Shared with the coordinator so process ownership and admission use one rollback switch. */
  fastLicenseReuseEnabled?: boolean;
  /**
   * Called when the companion extension's "Add to MKT Browser" button is clicked
   * inside a running profile. `profileId` is the profile that made the call
   * (the CDP session is profile-scoped). The host installs the extension.
   */
  onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`.
   *  Used to resolve shared extension references to their on-disk load dir. */
  extensionStoreRoot: string;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  // Shutdown has begun (window closed / Stop pressed) but the process hasn't
  // fully exited yet — the GUI shows a "Closing profile" transitional state.
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

interface DriverEvents {
  "running-changed": (change: RunningStateChange) => void;
}

/**
 * Real driver: spawns Chromium per profile with --user-data-dir + --remote-debugging-port,
 * connects to its CDP endpoint, and routes navigate / click / type / extract / screenshot
 * through the CdpSession.
 *
 * `click` and `type` accept CSS selectors only. Natural-language target resolution is
 * intentionally not built in — the MCP client (Claude in Cursor / Claude Desktop / etc.)
 * is responsible for parsing the page snapshot and producing selectors. MKT Browser never
 * calls any external API.
 */

export class ChromiumBrowserDriver extends EventEmitter implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningProcess>();
  private readonly launching = new Set<ProfileId>();
  private readonly launchPromises = new Map<ProfileId, Promise<LaunchedProfile>>();
  private readonly closeRequestedDuringLaunch = new Set<ProfileId>();
  private closeAllPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly launchingProcesses = new Map<ProfileId, LaunchingProcess>();
  private readonly closing = new Set<ProfileId>();
  private readonly shutdowns = new Map<ProfileId, Promise<void>>();
  private readonly profileManager: ProfileManager;
  private bootstrap: ChromiumBootstrap;
  private readonly onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  private readonly extensionStoreRoot: string;
  private readonly licenseKeyPool?: LicenseKeyPool;
  private readonly licenseLeaseRecorder?: LicenseLeaseRecorder;
  private readonly licenseSeatCoordinator?: LicenseSeatCoordinator;
  private readonly fastLicenseReuse: boolean;
  private readonly startupBarrier: Promise<void>;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.bootstrap = opts.chromiumBootstrap;
    this.onCompanionInstall = opts.onCompanionInstall;
    this.extensionStoreRoot = opts.extensionStoreRoot;
    this.licenseKeyPool = opts.licenseKeyPool;
    this.licenseLeaseRecorder = opts.licenseLeaseRecorder;
    this.licenseSeatCoordinator = opts.licenseSeatCoordinator;
    this.fastLicenseReuse = opts.fastLicenseReuseEnabled ?? fastLicenseReuseEnabled();
    this.startupBarrier = opts.startupBarrier ?? Promise.resolve();
  }

  override on<K extends keyof DriverEvents>(event: K, listener: DriverEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof DriverEvents>(
    event: K,
    ...args: Parameters<DriverEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    if (this.shuttingDown || this.closeAllPromise) {
      throw new Error("Browser is closing profiles. Wait before launching another profile.");
    }
    if (
      this.launching.has(profileId) ||
      this.launchingProcesses.has(profileId) ||
      this.closing.has(profileId)
    ) {
      throw profileAlreadyRunning(profileId);
    }
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: existing.cdpEndpoint,
        pid: existing.pid,
        startedAt: existing.startedAt,
      };
    }
    this.launching.add(profileId);
    // Track even launches waiting for the orphan sweep, before shutdown can take its snapshot.
    const launch = (async () => {
      await this.startupBarrier;
      if (this.shuttingDown || this.closeAllPromise) {
        throw new Error("Profile launch cancelled because Browser is closing profiles.");
      }
      const launched = await this.launchWithLicenseSeat(profileId);
      if (this.closeRequestedDuringLaunch.delete(profileId)) {
        await this.close(profileId);
        throw new Error("Profile launch cancelled because it was closed while starting.");
      }
      return launched;
    })();
    this.launchPromises.set(profileId, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(profileId);
      this.closeRequestedDuringLaunch.delete(profileId);
      if (this.launchPromises.get(profileId) === launch) this.launchPromises.delete(profileId);
    }
  }

  /**
   * One operator request makes at most one engine attempt. A refusal starts a longer local wait;
   * retrying automatically can prolong the vendor hold and must never happen here.
   */
  private async launchWithLicenseSeat(profileId: ProfileId): Promise<LaunchedProfile> {
    // Every launch runs the licensed engine, so the pool decides admission. An install without a
    // configured key constructs no pool; launches then proceed keyless on the keyless build.
    const pool = this.licenseKeyPool;
    const waitMessage = () => licenseSeatWaitMessage({
      snapshot: pool!.snapshot(),
      nextFreeAtMs: pool!.nextFreeAtMs(),
      nowMs: Date.now(),
      describeProfile: (id) => this.profileManager.get(id as ProfileId)?.name ?? null,
    });
    const attempt = async (key: string | null): Promise<LaunchedProfile> => {
      let leaseReserved = false;
      try {
        if (key) {
          await this.licenseLeaseRecorder?.reserved(profileId, key);
          leaseReserved = true;
        }
        return await this.launchTracked(profileId, key !== null);
      } catch (error) {
        const seatRefused = pool !== undefined && isSeatRefusal(error);
        let refusalWriteError: unknown = null;
        if (seatRefused && leaseReserved) {
          try {
            // Persist refusal before cleanup observes the exited child.
            await this.licenseLeaseRecorder?.refused(profileId);
          } catch (journalError) {
            refusalWriteError = journalError;
          }
        }
        try {
          await this.cleanupFailedLaunch(
            profileId,
            error,
            seatRefused ? false : undefined,
            leaseReserved,
          );
        } finally {
          if (seatRefused && key) pool!.markRefused(key);
        }
        if (!seatRefused) throw error;
        appendProfileLifecycleLine({
          profileId,
          reason: "LICENCE-KEY-REFUSED",
          keyTail: key ? keyTail(key) : "",
          keysLeft: pool!.availableCount(),
        });
        if (refusalWriteError) throw refusalWriteError;
        throw engineUnavailable(pool!.availableCount() === 0
          ? waitMessage()
          : "The licence server refused this session. No automatic retry was made. Check licence capacity before another manual launch.");
      }
    };

    if (pool && this.licenseSeatCoordinator) {
      try {
        return await this.licenseSeatCoordinator.runAdmission(profileId, attempt);
      } catch (error) {
        if (error instanceof LicenseSeatAdmissionError) {
          throw engineUnavailable(error.message, { cause: error });
        }
        throw error;
      }
    }

    if (pool && pool.acquire(profileId) === null) throw engineUnavailable(waitMessage());
    return await attempt(pool?.keyFor(profileId) ?? null);
  }

  private async launchTracked(
    profileId: ProfileId,
    hasLicensedLease: boolean,
  ): Promise<LaunchedProfile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw profileNotFound(profileId);
    if (profile.deletionPending) throw new ProfileDeletionPendingError(profileId);

    // Update `last_opened_at` for every launch, regardless of trigger
    // (UI button, MCP tool, command palette). Done early so even a
    // failed-to-spawn launch counts — the user pressed Launch.
    this.profileManager.markOpened(profileId);

    // A missing or half-prepared engine is its own failure class. Without this the caller sees
    // INTERNAL_ERROR and cannot tell "still downloading" from "this build is broken".
    let chromiumPath: string;
    try {
      chromiumPath = this.bootstrap.resolveBinaryPath();
    } catch (cause) {
      throw engineUnavailable(
        `The browser engine is not ready (${this.bootstrap.getStatus().kind}).`,
        { cause },
      );
    }
    const engine: BrowserEngine = this.bootstrap.getEngine();
    const bootstrapStatus = this.bootstrap.getStatus();
    const packagedContractFixture =
      process.env.MKT_BROWSER_PACKAGED_CONTRACT_VERIFY === "1" &&
      app.commandLine.hasSwitch("user-data-dir") &&
      basename(app.getPath("userData")).startsWith("mkt-browser-packaged-contract-");
    if (profile.proxy) {
      try {
        if (
          process.platform === "win32" &&
          !win32PathEquals(
            chromiumPath,
            stableWindowsRuntime(join(app.getPath("userData"), "chromium", engine)),
          )
        ) {
          throw new Error("The browser engine is not installed at its protected stable path.");
        }
        await assertWindowsWebRtcFirewallProtection({ engine, binaryPath: chromiumPath });
      } catch (cause) {
        throw proxyRejected(
          "Required WebRTC containment could not be verified; the proxied profile was not launched.",
          { cause },
        );
      }
    }
    const browserDataDir = browserDataDirForEngine(profile.dataDir);
    // Reconcile the profile's spoofed UA against the verified engine
    // version. Detection vendors fingerprint the JS engine and compare
    // against the claimed UA — claiming Chrome 148 while running 147 is an
    // instant flag. CloakBrowser's `--version` path enters its licensed
    // runtime and can consume the only seat without an SDK context to
    // close, so the bootstrap's verified version is authoritative and the
    // binary is never probed here.
    const actualVersion =
      bootstrapStatus.kind === "ready"
        ? parseChromiumVersion(bootstrapStatus.version)
        : null;
    // Reconcile (1) the Chrome version of the fingerprint to the actual
    // binary version. Runs on every launch so legacy profiles auto-fix.
    // Device family is NOT snapped back to the host: CloakBrowser is built
    // for cross-platform spoofing — claiming Windows on a Mac binary is
    // exactly its job (--fingerprint-platform=windows patches V8/CSS/Blink
    // at C++ level) — so the user's platform choice is respected.
    let fp = profile.fingerprint;
    if (actualVersion) fp = reconcileVersionInFingerprint(fp, actualVersion);

    // Timezone handling BEFORE we build CLI args (CloakBrowser's
    // --fingerprint-timezone= is set at spawn time and reads fp.timezone
    // at that moment).
    //
    // With a proxy: align fp.timezone to the egress IP's timezone. Detection
    // vendors run an "IP timezone vs JS timezone" check, and attaching a proxy
    // is an explicit "appear from here" signal, so aligning to the egress is
    // the intended behavior.
    //
    // Without a proxy: honor the profile's persona timezone as configured. We
    // deliberately do NOT snap it to the host timezone — doing so silently
    // discarded the user's timezone selection (issue #13), leaving a persona
    // whose locale/country said one thing and whose clock said another. Running
    // over a naked host IP is not a genuine evasion mode anyway (the real IP is
    // already exposed), and the one no-proxy workflow people do run — testing a
    // persona on webbrowsertools/browserscan — is exactly the case where they
    // want to see the persona timezone, not the host's.
    //
    // Known debt: the with-proxy branch below also overrides an explicitly
    // chosen fp.timezone with the proxy geo TZ, so a deliberate persona TZ is
    // silently replaced there too. Fixing that consistently (honor an explicit
    // user choice on both paths) needs a "user-set" flag on FingerprintConfig
    // and is out of scope for #13.
    let webrtcSpoofIp: string | null = null;
    let geoCoords: { latitude: number; longitude: number } | null = null;
    if (profile.proxy) {
      try {
        const verified = await verifyProxyGeoLaunch({
          profileId,
          fingerprint: fp,
          probe: () => probeProxyGeo(profile.proxy!, { timeoutMs: 4000 }),
          reject: proxyRejected,
        });
        const { geo, decision } = verified;
        const previousTimezone = fp.timezone;
        fp = decision.fingerprint;
        webrtcSpoofIp = decision.webrtcSpoofIp;
        geoCoords = decision.geoCoords;
        // Cache the resolved country on the profile so the GUI flag chip
        // matches the proxy's egress (Luxembourg proxy → LU flag, not the
        // fingerprint's timezone-derived country).
        if (geo.country) {
          this.profileManager.setProxyCountry(profileId, geo.country.toLowerCase());
        }
        if (decision.fingerprint.timezone !== previousTimezone) {
          console.log(
            `[mkt-browser] aligning fingerprint timezone ${previousTimezone} → ${decision.fingerprint.timezone} (proxy geo)`,
          );
        }
      } catch (cause) {
        // Do not leave a country cached from an older proxy or a prior route.
        this.profileManager.setProxyCountry(profileId, null);
        throw cause;
      }
    }
    // No-proxy: fp.timezone is left as the profile configured it (issue #13).

    // Clean up stale SingletonLock left behind by a Chromium that
    // crashed without unlinking its own lock. Without this, the next
    // launch sees `SingletonLock -> hostname-PID` pointing to a dead
    // PID and silently exits (the "socket hang up" the user sees: CDP
    // briefly opens, profile-in-use check fires, process bails).
    await cleanStaleSingletonLocks(browserDataDir).catch((e: unknown) => {
      console.warn("[mkt-browser] failed to clean Singleton locks:", (e as Error).message);
    });

    // macOS records app crashes and on next launch shows
    // "Reopen windows from previous crash?" modal via NSPersistentUIRestorer.
    // CloakBrowser's stealth patches DCHECK on unexpected modal dialogs
    // and the binary crashes mid-dialog (EXC_BREAKPOINT). Both layers
    // need to be defused: delete the saved-state bundle for the binary's
    // bundle id, and turn off persistence in user defaults.
    if (process.platform === "darwin") {
      await disableMacOsPersistentStateRestore().catch((e: unknown) => {
        console.warn("[mkt-browser] persistent-state cleanup skipped:", (e as Error).message);
      });
    }

    // Make Chromium reopen last-session tabs on every launch — what
    // Multilogin / AdsPower / GoLogin do by default. The setting is
    // `session.restore_on_startup = 1` in the Default profile's
    // Preferences JSON. We mutate it before spawn (Chrome must be off
    // to avoid corruption).
    await ensureSessionRestore(browserDataDir).catch((e: unknown) => {
      console.warn(
        "[mkt-browser] failed to write session restore preference:",
        (e as Error).message,
      );
    });

    // Chromium's --accept-lang flag expects a PLAIN comma-separated list
    // of language tags ("en-US,en"). It then computes q-values itself for
    // the HTTP Accept-Language header AND for `navigator.languages`. If
    // we pass a pre-formatted string with q-values ("en-US,en;q=0.9"),
    // Chromium parses it as ["en-US", "en;q=0.9"] and then re-adds q's,
    // producing the malformed "en-US,en;q=0.9;q=0.9" we saw on browserscan.
    const acceptLangPlain = fp.languages.join(",");
    const useSdkLifecycle = shouldUseCloakBrowserSdkLifecycle(this.fastLicenseReuse);
    const args = [
      ...(useSdkLifecycle ? [] : [`--user-data-dir=${browserDataDir}`]),
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // Force-restore the previous session's tabs at startup. Combined
      // with the Preferences flip in ensureSessionRestore() and our
      // CDP-based graceful shutdown on close, this makes tab persistence
      // reliable across stop/launch even after a crash.
      "--restore-last-session",
      // One list, deliberately. Chromium honours only the LAST --disable-features
      // it receives, so a second flag anywhere in argv discards this one.
      // chromium-network-privacy-flags.ts owns the contents.
      disableFeaturesArg(),
      // Don't back Chromium's "Safe Storage" key with the OS keychain/keyring.
      // Two reasons: (1) our engine bundle is ad-hoc signed, so on macOS the
      // keychain ACL never matches and every launch pops a "Chromium wants to
      // use your keychain" password prompt (TouchID doesn't apply). (2) A
      // keychain-derived key is MACHINE-BOUND, which breaks profile portability
      // — the whole point of .mzar export/import — because cookies/passwords
      // encrypted on one Mac can't be decrypted after moving. Instead Chromium
      // uses a profile-local key (the Puppeteer/Playwright default: a fixed
      // "mock_password"). Trade-off, stated honestly: at-rest cookie/password
      // encryption becomes obfuscation (a public constant key), not keychain-
      // protected. This DOES lower the bar for a passive file-read attacker
      // (an infostealer that can read the profile dir now decrypts without the
      // keychain-ACL prompt or a memory dump). Accepted here because portability
      // is the product (.mzar export is useless with a machine-bound key), the
      // whole anti-detect category does this, and the real threats are covered
      // elsewhere: FileVault for offline disk theft, .mzar's AES-256-GCM +
      // passphrase for exports. Rely on disk encryption for at-rest safety.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      // UI language for the Chromium chrome itself
      `--lang=${fp.locale}`,
      // Accept-Language: plain list, Chromium adds q-values.
      `--accept-lang=${acceptLangPlain}`,
      // Initial window size
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];
    // CloakBrowser implements fingerprint patches in C++. Feed it native
    // flags and never layer CDP/JS overrides later; those are exactly the
    // automation surfaces it hardens against. UA + Client Hints stay
    // coherent via the native --fingerprint-brand-version flag.
    args.push(...buildCloakBrowserFingerprintArgs(profileId, fp));
    if (profile.proxy) {
      args.push("--fingerprint-webrtc-ip=auto");
    }
    if (geoCoords) {
      // Make navigator.geolocation report coordinates that match the
      // proxy IP — without this, fingerprint-scan.com fires the "Check
      // Geo API" warning when the location grant is exercised.
      args.push(`--fingerprint-location=${geoCoords.latitude},${geoCoords.longitude}`);
    }
    // ── DNS coherence and leak prevention ───────────────────────────
    // Applies to EVERY profile, not only proxied ones. These flags lived
    // inside the proxy branch until browserscan measured a profile without
    // one: the IP read as VNPT in Ho Chi Minh City while the resolvers
    // answering for it sat abroad, because Chrome's automatic DoH upgrade had
    // never been switched off on that path. A persona claiming to be a
    // Vietnamese home connection whose DNS resolves through Cloudflare is
    // incoherent in the same way a Windows UA with an Apple GPU is, and it
    // costs one line to not be.
    //
    // For a proxied profile the SOCKS5 bridge already carries the hostname
    // upstream, so URL-load DNS resolves at the egress. For a profile with no
    // proxy, disabling DoH is what sends resolution back to the connection's
    // own resolver — the one the IP implies.
    //
    // What still leaks bypassing --proxy-server (per Chromium net/docs):
    //   • DoH (DNS-over-HTTPS) — talks straight to Cloudflare/Google
    //   • DNS prefetcher / predictor
    //   • Background networking (component updater, GCM, safe-browsing). The measured Windows
    //     CloakBrowser SDK lifecycle keeps this one available because the vendor's shutdown request
    //     otherwise never releases the seat promptly; the remaining containment switches stay on.
    //   • Domain Reliability beacons
    //
    // We deliberately do NOT use --host-resolver-rules: it triggers the
    // "unsupported flag" infobar (visible to the user, even though JS can't
    // probe it), and a SOCKS5 upstream makes it redundant anyway. Real
    // anti-detect products (Multilogin Mimic) solve the residual leak with a
    // custom DNS-resolver source patch — a Phase-1 item for an approved
    // source-patched Chromium build, not the vanilla fallback.
    //
    // The DoH / AsyncDns / NetworkPrediction feature toggles ride in the one
    // --disable-features list above; this is the command-switch half. It is
    // pushed here, outside every proxy branch, because that is where it was NOT
    // in the build browserscan caught leaking DNS on unproxied profiles.
    args.push(
      ...networkPrivacySwitches(Boolean(profile.proxy), {
        allowBackgroundNetworking: useSdkLifecycle,
      }),
    );

    if (packagedContractFixture) {
      // Restricted verification hosts cannot start Chrome's GPU sandbox. Normal launches never
      // enter this branch; the verifier separately proves a real CDP-ready browser lifecycle.
      args.push("--disable-gpu", "--disable-software-rasterizer", "--no-sandbox");
    }
    if (profile.proxy) {
      // Chromium's --proxy-server= does NOT accept embedded credentials,
      // and an HTTP-CONNECT relay leaks DNS (Chromium prefetch / DoH /
      // background networking all hit the OS resolver before any proxy
      // negotiation). The fix: spin up a localhost SOCKS5 bridge that
      // forwards to the user's upstream proxy (HTTP CONNECT or SOCKS5
      // chained). Chromium with --proxy-server=socks5://… does *remote*
      // DNS by spec, so the egress IP becomes the only resolver test
      // sites observe.
      // Fail closed: a profile whose proxy could not be applied must never reach a launched
      // window, or the account would egress from the operator's own IP. The message names no
      // endpoint or credential — the caller already knows which profile it asked for.
      let localProxyUrl: string;
      try {
        localProxyUrl = await startBridgeForProfile(profileId, profile.proxy);
      } catch (cause) {
        throw proxyRejected(
          `The local proxy bridge for profile ${profileId} could not be started; the profile was not launched.`,
          { cause },
        );
      }
      args.push(`--proxy-server=${localProxyUrl}`);
      // WebRTC leaks the *real* public IP via STUN even when HTTP traffic
      // is proxied — STUN uses UDP and bypasses HTTP proxies by default.
      // `disable_non_proxied_udp` forces WebRTC to either go through a
      // SOCKS proxy that supports UDP, or fall back to TCP through the
      // configured proxy. Without this flag, browserscan / browserleaks /
      // ipleak.net all show the user's real IP next to the proxy IP.
      // Only set when a proxy is configured — direct profiles intentionally
      // expose their real IP.
      args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
      args.push("--enforce-webrtc-ip-permission-check");
    }

    // Browser extensions: load this profile's enabled extensions plus the
    // bundled companion (the "Add to MKT Browser" injector). Same flag pair
    // CloakBrowser's own `extension_paths` emits; requires the persistent
    // user-data-dir we already use. Extensions live under the profile dir
    // (shared across engines), so we pass absolute paths.
    const extensionDirs: string[] = [];
    const companion = companionDir();
    if (companion) extensionDirs.push(companion);
    for (const ext of profile.extensions ?? []) {
      if (!ext.enabled) continue;
      // Resolve both shared store entries and legacy per-profile copies.
      const dir = resolveLoadDir(ext, profile.dataDir, this.extensionStoreRoot);
      // Skip a missing dir: a single bad path makes Chromium drop the ENTIRE
      // --load-extension list (the companion too), silently disabling all
      // extensions for the launch.
      if (existsSync(dir)) extensionDirs.push(dir);
    }
    if (extensionDirs.length > 0) {
      const joined = extensionDirs.join(",");
      args.push(`--load-extension=${joined}`);
      args.push(`--disable-extensions-except=${joined}`);
    }

    // NOTE on Sec-CH-UA: The Client Hints headers (`Sec-CH-UA`,
    // `Sec-CH-UA-Platform`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`,
    // `Sec-CH-UA-Bitness`, etc.) and `navigator.userAgentData` are NOT
    // overridable via CLI flags. They are baked into the compiled Chromium
    // binary at build time. To make them coherent with our chosen `userAgent`
    // we need an approved patched Chromium build which applies native
    // overrides. Until that ships, system Chrome will emit its real Client
    // Hints and detection vendors will see a UA-vs-CH mismatch.
    //
    // The full ClientHints object is stored in `profile.fingerprint.clientHints`
    // and will be picked up by the patched binary's launch wrapper when present.

    // Keep Electron/Node markers out, but retain native Windows temp/home variables. The licensed
    // runtime uses the same environment for session startup and graceful release; POSIX defaults
    // such as TMPDIR=/tmp are invalid on Windows even though Chromium itself can still start.
    const cleanEnv = buildBrowserLaunchEnvironment();

    // CloakBrowser's licensed build re-verifies its licence on every launch and
    // reads the key from its OWN environment — the wrapper never passes it as a
    // switch. Omitted here, a licensed binary exits 77 ("key missing") and the
    // profile never opens. Empty on the keyless build, which ignores it.
    // The pool has already reserved a key for this profile in launch(); read it rather than
    // reserving here, so a retry after a refusal cannot quietly take a second seat.
    const cloakBrowserLicenseKey =
      this.licenseKeyPool?.keyFor(profileId) ?? this.bootstrap.getCloakBrowserLicenseKey();
    if (cloakBrowserLicenseKey) {
      cleanEnv.CLOAKBROWSER_LICENSE_KEY = cloakBrowserLicenseKey;
    }

    // Start page (positional URL) — only on first run, i.e. when there is no
    // restorable session. With `--restore-last-session` a returning profile
    // reopens its real tabs, so we must NOT stack an extra tab; on first launch
    // there's nothing to restore, so the command-line URL becomes the initial
    // tab (verified on CloakBrowser 145 — pref `startup_urls` is ignored there,
    // a positional URL works). Defaults to DuckDuckGo when the profile has no
    // explicit start page. Must be the LAST argv entry (positional).
    const initialUrl = !(await hasRestorableSession(browserDataDir))
      ? sanitizeStartUrl(profile.startUrl)
      : undefined;
    if (initialUrl && !useSdkLifecycle) {
      // sanitizeStartUrl rejects non-http(s)/about (incl. `-`-prefixed tokens
      // Chromium would treat as switches) → falls back to the default.
      args.push(initialUrl);
    }

    const readinessStartedAtMs = Date.now();
    const prelaunchProcesses = await enumerateBrowserProcessesUsingDataDir(browserDataDir);
    if (!prelaunchProcesses.enumerated) {
      throw new Error("Could not establish the browser process baseline before launch");
    }
    if (prelaunchProcesses.processes.length > 0) {
      throw new Error("A browser process already uses this profile data directory");
    }

    // Port zero makes Chromium choose an available endpoint and publish it atomically in this
    // owned profile directory. Remove a crash-era record immediately before spawn so freshness is
    // based on the current launch, never a reachable port left by an unrelated process.
    await clearStaleDevToolsActivePort(browserDataDir);
    const sdkBrowserVersion =
      useSdkLifecycle && bootstrapStatus.kind === "ready" ? bootstrapStatus.version : null;
    if (useSdkLifecycle && !sdkBrowserVersion) {
      throw engineUnavailable("The pinned CloakBrowser version is unavailable for SDK launch.");
    }
    if (useSdkLifecycle && !cloakBrowserLicenseKey) {
      throw engineUnavailable("A CloakBrowser licence key is required for SDK launch.");
    }
    // Starting is durable before spawn. If Electron dies in the next instruction, recovery blocks
    // the key instead of reconstructing it as idle while the vendor may have accepted a session.
    if (hasLicensedLease) await this.licenseLeaseRecorder?.started(profileId, null);
    const spawnedAtMs = Date.now();
    const startedAt = new Date(spawnedAtMs).toISOString();
    let spawnError: unknown = null;
    let child: ChildProcess | undefined;
    let sdkLifecycle: CloakBrowserSdkLifecycle | undefined;
    let launchProcess: LaunchingProcess;

    if (useSdkLifecycle) {
      try {
        sdkLifecycle = await launchCloakBrowserSdkLifecycle({
          executablePath: chromiumPath,
          browserDataDir,
          licenseKey: cloakBrowserLicenseKey!,
          browserVersion: sdkBrowserVersion!,
          args,
          initialUrl,
          environment: cleanEnv,
        });
        const sdkPid = await discoverCloakBrowserSdkProcess(browserDataDir);
        const gracefulClose = sdkLifecycle.close;
        launchProcess = {
          gracefulClose,
          cdpEndpoint: null,
          port: null,
          pid: sdkPid,
          startedAt,
          session: null,
          browserDataDir,
        };
        this.launchingProcesses.set(profileId, launchProcess);
        sdkLifecycle.context.once("close", () => {
          const record = this.running.get(profileId);
          if (
            !record ||
            record.gracefulClose !== gracefulClose ||
            this.closing.has(profileId)
          ) {
            return;
          }
          void this.shutdownRunningProfile(profileId, record, "external-exit", false).catch(
            (error: unknown) => {
              console.error("[mkt-browser] SDK-context cleanup failed:", error);
            },
          );
        });
      } catch (error) {
        await sdkLifecycle?.close().catch(() => undefined);
        const exitCode = cloakBrowserSdkLicenseExitCode(error);
        if (exitCode !== null) throw launchExitError(exitCode, "SDK launch");
        throw error;
      }
    } else {
      child = spawn(chromiumPath, args, {
        // The fallback launcher stays detached so an app crash leaves a recoverable browser. The
        // SDK path owns its process through Playwright and does not enter this branch.
        detached: shouldDetachBrowserProcess(this.fastLicenseReuse),
        stdio: ["ignore", "ignore", "pipe"],
        env: cleanEnv,
      });
      child.on("error", (error) => {
        spawnError = error;
        const pending = this.launchingProcesses.get(profileId);
        if (pending && pending.child === child) pending.spawnError = error;
        process.stderr.write(`[mkt-browser] Chromium spawn failed: ${error.message}\n`);
      });
      if (!child.pid) throw new Error("Failed to spawn Chromium");

      launchProcess = {
        child,
        cdpEndpoint: null,
        port: null,
        pid: child.pid,
        startedAt,
        session: null,
        browserDataDir,
      };
      this.launchingProcesses.set(profileId, launchProcess);
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) process.stderr.write(`[chromium ${child!.pid}] ${line}\n`);
      });
      child.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          // A licence refusal exits with a bare code and no diagnostic output, so
          // without this translation an operator sees only "the browser closed".
          const licenseReason = licenseExitMessage(code);
          if (licenseReason) process.stderr.write(`[mkt-browser] ${licenseReason}\n`);
          process.stderr.write(
            `[mkt-browser] Chromium pid ${child!.pid} exited code=${code} signal=${signal ?? "—"}\n`,
          );
        }

        const pending = this.launchingProcesses.get(profileId);
        if (pending === launchProcess) {
          pending.childExit = { exitCode: code, signal };
          return;
        }

        const record = this.running.get(profileId);
        if (!record || record.child !== child) return;
        void this.handleRunningChildExit(profileId, record, code, signal);
      });
    }

    // Staged readiness: /json/version → a page target exists → connect+attach,
    // all within one budget. Guarantees the profile is actually drivable before
    // launch() resolves, so an MCP navigate/extract right after launch can't
    // race a not-yet-ready CDP endpoint.
    //
    // The budget is wider under the packaged-contract verifier, and only there. 15s is measured
    // against a developer machine where the engine is warm and the CPU is not shared. A GitHub
    // Windows runner is neither, and on 19 August 2026 it lost the race at the first stage —
    // Chromium had not opened the DevTools port at all. The identical commit passed on rerun, which
    // is the worst outcome available: a check that is red often enough to be re-run is a check that
    // teaches people to re-run rather than read, and that habit is what this repository keeps paying
    // to remove.
    //
    // Widening it for everyone would be the wrong trade — the tight budget is what stops a real
    // launch regression on an operator's machine from being absorbed as a slow start. So the wider
    // number is scoped to the one process that already identifies itself, using the flag this file
    // reads a few hundred lines above for the same purpose.
    const readinessBudgetMs =
      process.env.MKT_BROWSER_PACKAGED_CONTRACT_VERIFY === "1" ? 60_000 : 15_000;
    const discoveryBudgetMs = readinessBudgetMs - (Date.now() - readinessStartedAtMs);
    if (discoveryBudgetMs <= 0) {
      throw new Error("CDP readiness budget exhausted before DevTools endpoint discovery");
    }
    let endpoint;
    try {
      endpoint = await waitForOwnedDevToolsEndpoint({
        dataDir: browserDataDir,
        childPid: child?.pid ?? launchProcess.pid,
        budgetMs: discoveryBudgetMs,
      });
    } catch (error) {
      if (spawnError) throw spawnError;
      const exitCode = launchProcess.childExit?.exitCode;
      const licenseReason = licenseExitMessage(exitCode ?? null);
      if (licenseReason) {
        const refusal = engineUnavailable(licenseReason);
        (refusal as { licenseExitCode?: number }).licenseExitCode = exitCode ?? undefined;
        throw refusal;
      }
      throw error;
    }
    const { port, primaryPid: trackedPid } = endpoint;
    const cdpEndpoint = `http://127.0.0.1:${port}`;
    const session = new CdpSession({ port, engine });
    launchProcess.port = port;
    launchProcess.cdpEndpoint = cdpEndpoint;
    launchProcess.session = session;
    launchProcess.pid = trackedPid;
    console.log(
      `[mkt-browser] DevTools endpoint ready launchPid=${child?.pid ?? launchProcess.pid} primaryPid=${trackedPid} ` +
        `port=${port} activePortMs=${endpoint.timings.activePortMs} ` +
        `ownershipMs=${endpoint.timings.ownershipMs}`,
    );

    const remainingReadinessMs = readinessBudgetMs - (Date.now() - readinessStartedAtMs);
    if (remainingReadinessMs <= 0) {
      throw new Error(
        `CDP readiness budget exhausted after DevTools endpoint discovery on port ${port}`,
      );
    }
    const cdpTimings = await waitForCdpSessionReady(port, session, remainingReadinessMs);
    console.log(
      `[mkt-browser] CDP ready port=${port} versionMs=${cdpTimings.versionMs} ` +
        `pageTargetMs=${cdpTimings.pageTargetMs} attachMs=${cdpTimings.attachMs} ` +
        `totalMs=${cdpTimings.totalMs}`,
    );
    if (spawnError) throw spawnError;
    if (
      child?.pid &&
      launchProcess.childExit &&
      trackedPid === child.pid &&
      !isPidAlive(trackedPid)
    ) {
      // A licence refusal is the most common way to land here and it is not a defect: the free key
      // allows one session at a time, and the engine opens its DevTools port BEFORE the licence
      // verdict arrives, so readiness passes and the process is gone a second later. Reported as a
      // raw exit code it reads as a crash — that misreading cost an evening. LICENSE_EXIT_MESSAGES
      // already says what happened and what to do about it; say that instead, and classify it as
      // ENGINE_UNAVAILABLE so a caller sees an expected refusal rather than INTERNAL_ERROR.
      throw launchExitError(launchProcess.childExit.exitCode, "launch");
    }
    const launchLogContext: ProfileLifecycleLogContext = { pid: trackedPid, port, startedAt };

    // Apply per-target bootstrap. No CDP Emulation.* layer at all:
    // CloakBrowser sets UA, timezone, locale, screen and WebGL natively at
    // C++ level through its --fingerprint-* switches, and layering CDP
    // overrides on top produces subtle disagreements between layers (e.g.
    // our CDP UA string ≠ the native UA-CH brand list) that composite
    // scorers like fingerprint-scan.com flag as "Masking detected". Trust
    // the native binary. WebRTC egress is likewise handled natively via
    // --fingerprint-webrtc-ip=auto on proxied profiles.
    //
    // Launch can hang before the window watcher exists, so durable stage pairs reveal the exact
    // CDP await.
    writeProfileLifecycleLog(profileId, launchLogContext, "BOOTSTRAP-START");
    let tracingInitialBootstrap = true;
    await session
      .bootstrapTargets(async (send, ctx) => {
        const traceTarget = tracingInitialBootstrap;
        const targetDetails = { isRoot: ctx.isRoot, targetType: ctx.type };
        if (traceTarget) {
          writeProfileLifecycleLog(
            profileId,
            launchLogContext,
            "BOOTSTRAP-TARGET-START",
            targetDetails,
          );
        }
        // Diagnostic: capture what the page actually sees AFTER the native
        // fingerprint patches. Logs once per session — if browserscan
        // reports "Different browser name", these values tell us whether
        // the native patches landed.
        if (traceTarget) {
          writeProfileLifecycleLog(
            profileId,
            launchLogContext,
            "BOOTSTRAP-PROBE-START",
            targetDetails,
          );
        }
        try {
          const probe = await send<{
            result?: { value?: string };
          }>("Runtime.evaluate", {
            expression: `JSON.stringify({
              ua: navigator.userAgent,
              brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
              platform: navigator.platform,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              icuLocale: Intl.DateTimeFormat().resolvedOptions().locale,
              calendar: Intl.DateTimeFormat().resolvedOptions().calendar,
              lang: navigator.language,
              langs: navigator.languages,
              deviceMemory: navigator.deviceMemory,
              hardwareConcurrency: navigator.hardwareConcurrency,
              hasRTCPC: typeof window.RTCPeerConnection !== "undefined",
            })`,
            returnByValue: true,
          });
          if (traceTarget) {
            writeProfileLifecycleLog(
              profileId,
              launchLogContext,
              "BOOTSTRAP-PROBE-DONE",
              targetDetails,
            );
          }
          const value = probe?.result?.value;
          if (value) console.log("[mkt-browser] post-bootstrap probe:", value);
        } catch (e) {
          if (traceTarget) {
            writeProfileLifecycleLog(profileId, launchLogContext, "BOOTSTRAP-PROBE-FAILED", {
              ...targetDetails,
              errorCode: fetchErrorCode(e),
            });
          }
          // Non-fatal — diagnostic only.
          void e;
        }
        if (traceTarget) {
          writeProfileLifecycleLog(
            profileId,
            launchLogContext,
            "BOOTSTRAP-TARGET-DONE",
            targetDetails,
          );
        }
      })
      .then(
        () => {
          tracingInitialBootstrap = false;
          writeProfileLifecycleLog(profileId, launchLogContext, "BOOTSTRAP-DONE");
        },
        (e: unknown) => {
          tracingInitialBootstrap = false;
          writeProfileLifecycleLog(profileId, launchLogContext, "BOOTSTRAP-FAILED", {
            errorCode: fetchErrorCode(e),
          });
          console.error("[mkt-browser] CDP bootstrap failed:", e);
        },
      );

    if (
      child?.pid &&
      launchProcess.childExit &&
      trackedPid === child.pid &&
      !isPidAlive(trackedPid)
    ) {
      // Tagged, not bare: a refusal that reaches this point is still a refusal, and throwing an
      // untagged Error here is what stopped the rotation loop from reaching the next free key.
      throw launchExitError(launchProcess.childExit.exitCode, "bootstrap");
    }

    // Wire the companion's "Add to MKT Browser" channel for this profile — scoped
    // to Web Store pages only (the host polls a DOM attribute there, never on
    // the user's normal browsing). The CDP session is profile-scoped, so any
    // signal belongs to this profileId — no cross-profile ambiguity.
    if (this.onCompanionInstall) {
      void session.watchUrlForBinding({
        urlIncludes: "chromewebstore.google.com",
        onPayload: (payload) => {
          try {
            const parsed = JSON.parse(payload) as { id?: string };
            if (parsed.id) this.onCompanionInstall?.(profileId, parsed.id);
          } catch {
            // ignore malformed payloads
          }
        },
      });
    }

    // Watch for "no more page targets" via CDP. On macOS Chrome stays alive
    // after the last window closes (standard Mac app lifecycle) — the spawned
    // process keeps running with zero windows. We poll /json/list and force-
    // kill the child when that happens, which then fires child.on('exit') and
    // emits the running-changed event.
    // Last gate before this launch is called a success: give the licence verdict time to arrive.
    //
    // Every earlier check for a refusal sampled `childExit` at a moment the child was still alive,
    // because the engine serves CDP before the licence server has answered. Waiting for the window
    // to close is what turns "resolved with a pid for a browser that is about to die" into a thrown
    // refusal the rotation loop can act on. It returns immediately once the child exits, so a
    // refusal is detected as fast as it happens.
    if (sdkLifecycle) {
      try {
        await sdkLifecycle.settleLicenceVerdict(spawnedAtMs);
      } catch (error) {
        const exitCode = cloakBrowserSdkLicenseExitCode(error);
        if (exitCode !== null) throw launchExitError(exitCode, "SDK licence verification");
        throw error;
      }
    } else if (child) {
      await settleLicenceVerdict(launchProcess, child, spawnedAtMs);
    }
    if (
      child?.pid &&
      launchProcess.childExit &&
      trackedPid === child.pid &&
      !isPidAlive(trackedPid)
    ) {
      throw launchExitError(launchProcess.childExit.exitCode, "licence verification");
    }

    if (hasLicensedLease) await this.licenseLeaseRecorder?.active(profileId);

    // Latch so the 1s watcher signals termination + shuts down exactly once,
    // not on every tick while pages stay at zero during the ~1.5–4s wind-down.
    let signalledClose = false;
    const record: RunningProcess = {
      ...(child ? { child } : {}),
      ...(sdkLifecycle ? { gracefulClose: sdkLifecycle.close } : {}),
      cdpEndpoint,
      port,
      pid: trackedPid,
      startedAt,
      session,
      browserDataDir,
      // Replaced before publication; the watcher callback must read the mutable tracked PID.
      windowWatcher: { stop: () => {} },
      proxy: profile.proxy ? { ...profile.proxy } : undefined,
      observedProxyIp: webrtcSpoofIp ?? undefined,
    };
    record.windowWatcher = createWindowWatcher(
      port,
      startedAt,
      () => isPidAlive(record.pid),
      (shutdownReason) => {
        if (signalledClose) return;
        signalledClose = true;
        writeProfileLifecycleLog(profileId, record, shutdownReason.reason, shutdownReason);
        void this.shutdownRunningProfile(
          profileId,
          record,
          "external-exit",
          shutdownReason.reason === "CDP-UNREACHABLE" ? false : undefined,
        ).catch((error: unknown) => {
          console.error("[mkt-browser] watcher shutdown failed:", error);
        });
      },
    );
    this.running.set(profileId, record);
    this.launchingProcesses.delete(profileId);

    this.emit("running-changed", { kind: "launched", profileId });
    return { id: profileId, cdpEndpoint, pid: trackedPid, startedAt };
  }

  private async handleRunningChildExit(
    profileId: ProfileId,
    record: RunningProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const childPid = record.child?.pid;
    if (!childPid) return;
    // Windows may emit exit for a launcher while the real browser has already inherited CDP.
    if (record.pid !== childPid && isPidAlive(record.pid)) return;
    if (this.closing.has(profileId)) {
      writeProfileLifecycleLog(profileId, record, "CHILD-EXIT", { exitCode, signal });
      return;
    }
    const processes = await findBrowserProcessesUsingDataDir(record.browserDataDir);
    const discoveredPid = selectPrimaryBrowserPid(processes, childPid);
    if (discoveredPid !== childPid && isPidAlive(discoveredPid)) {
      record.pid = discoveredPid;
      return;
    }
    if (await isCdpEndpointReachable(record.port, 500)) return;

    writeProfileLifecycleLog(profileId, record, "CHILD-EXIT", { exitCode, signal });
    if (this.running.get(profileId) === record && !this.closing.has(profileId)) {
      await this.shutdownRunningProfile(
        profileId,
        record,
        "external-exit",
        didBrowserExitReleaseSeat(exitCode, signal, record.pid === childPid),
      ).catch((error: unknown) =>
        console.error("[mkt-browser] child-exit cleanup failed:", error),
      );
    }
  }

  private async cleanupFailedLaunch(
    profileId: ProfileId,
    error: unknown,
    seatReleasedOverride?: boolean,
    leaseReserved = false,
  ): Promise<void> {
    const activeShutdown = this.shutdowns.get(profileId);
    if (activeShutdown) {
      await activeShutdown.catch(() => {});
      return;
    }
    const pending = this.launchingProcesses.get(profileId);
    if (!pending) {
      // A journal reservation can fail because an older unreconciled lease already owns this
      // profile. Release only the new in-memory allocation in that case; mutating the journal would
      // falsely mark the older vendor session as released.
      if (leaseReserved) {
        await this.releaseLicenseKey(profileId, "already-exited", seatReleasedOverride);
      } else {
        this.licenseKeyPool?.release(profileId, true);
      }
      await withTimeout(stopBridgeForProfile(profileId), 2000);
      return;
    }

    const processes = await findBrowserProcessesUsingDataDir(pending.browserDataDir);
    pending.pid = selectPrimaryBrowserPid(processes, pending.pid);
    const childExit = pending.childExit;
    const childPid = pending.child?.pid;
    const childWasBrowser =
      childPid !== undefined && (pending.pid === childPid || !isPidAlive(pending.pid));
    if (childExit && childWasBrowser) {
      writeProfileLifecycleLog(profileId, pending, "CHILD-EXIT", childExit);
    } else {
      writeProfileLifecycleLog(profileId, pending, "LAUNCH-FAILED", {
        errorCode: fetchErrorCode(pending.spawnError ?? error),
      });
    }

    const outcome = await terminateBrowserProcess(profileId, pending);
    if (!outcome.terminated) {
      throw new Error(`Chromium pid ${pending.pid} survived failed-launch cleanup`);
    }
    const observedExitReleased = pending.childExit
      ? didBrowserExitReleaseSeat(
          pending.childExit.exitCode,
          pending.childExit.signal,
          childPid !== undefined && pending.pid === childPid,
        )
      : undefined;
    await this.releaseLicenseKey(
      profileId,
      outcome.shutdownMethod,
      seatReleasedOverride ?? observedExitReleased,
    );
    if (this.launchingProcesses.get(profileId) === pending) {
      this.launchingProcesses.delete(profileId);
    }
    await withTimeout(stopBridgeForProfile(profileId), 2000);
  }

  /**
   * Give the profile's licence key back to the pool.
   *
   * Browser.close and a clean process exit are not vendor release acknowledgements.
   * Only independent proof (including an unstarted reservation) permits immediate reuse.
   */
  private async releaseLicenseKey(
    profileId: ProfileId,
    _method: ShutdownMethod,
    seatReleasedOverride?: boolean,
  ): Promise<void> {
    // A launch without a configured key holds no vendor seat. The recorder is process-global, so
    // key ownership is the guard that prevents a keyless failure from mutating an older licensed
    // lease for this profile.
    if (this.licenseKeyPool?.keyFor(profileId) === null || !this.licenseKeyPool) return;
    const seatReleased = seatReleasedOverride ?? false;
    // The pool forgets this the moment the app exits. The journal is what carries a resting seat
    // into the next run, so durable state changes before in-memory capacity becomes available.
    try {
      const durableSeatReleased =
        (await this.licenseLeaseRecorder?.released(profileId, seatReleased)) ?? seatReleased;
      this.licenseKeyPool?.release(profileId, durableSeatReleased);
    } catch (error) {
      // The process is gone, but durable truth is uncertain. Cooling is conservative and avoids
      // both a false-running UI entry and a false-idle seat.
      console.error("[mkt-browser] durable license release failed; cooling seat:", error);
      this.licenseKeyPool?.release(profileId, false);
    }
  }

  private shutdownRunningProfile(
    profileId: ProfileId,
    record: RunningProcess,
    reason: "user-close" | "external-exit",
    seatReleasedOverride?: boolean,
  ): Promise<void> {
    const existing = this.shutdowns.get(profileId);
    if (existing) return existing;

    this.licenseSeatCoordinator?.invalidate("close");
    this.closing.add(profileId);
    record.windowWatcher.stop();
    const shutdown = (async () => {
      const outcome = await terminateBrowserProcess(profileId, record);
      if (!outcome.terminated) {
        throw new Error(`Chromium pid ${record.pid} survived shutdown escalation`);
      }
      await this.releaseLicenseKey(profileId, outcome.shutdownMethod, seatReleasedOverride);

      if (this.running.get(profileId) === record) this.running.delete(profileId);
      await withTimeout(stopBridgeForProfile(profileId), 2000);
      console.log(
        `[mkt-browser] close() done profile=${profileId} pid=${record.pid} alive=${isPidAlive(record.pid)}`,
      );
      this.emit("running-changed", { kind: "closed", profileId, reason });
    })()
      .catch((error: unknown) => {
        if (this.running.get(profileId) === record) {
          this.closing.delete(profileId);
          if (this.shutdowns.get(profileId) === shutdown) this.shutdowns.delete(profileId);
          this.emit("running-changed", { kind: "launched", profileId });
        }
        throw error;
      })
      .finally(() => {
        this.closing.delete(profileId);
        if (this.shutdowns.get(profileId) === shutdown) this.shutdowns.delete(profileId);
      });
    this.shutdowns.set(profileId, shutdown);
    this.emit("running-changed", { kind: "closing", profileId });
    return shutdown;
  }

  private shutdownLaunchingProfile(profileId: ProfileId, pending: LaunchingProcess): Promise<void> {
    const existing = this.shutdowns.get(profileId);
    if (existing) return existing;

    this.licenseSeatCoordinator?.invalidate("close");
    this.closing.add(profileId);
    const shutdown = (async () => {
      const outcome = await terminateBrowserProcess(profileId, pending);
      if (!outcome.terminated) {
        throw new Error(`Chromium pid ${pending.pid} survived shutdown escalation`);
      }
      await this.releaseLicenseKey(profileId, outcome.shutdownMethod);
      if (this.launchingProcesses.get(profileId) === pending) {
        this.launchingProcesses.delete(profileId);
      }
      await withTimeout(stopBridgeForProfile(profileId), 2000);
      this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
    })().finally(() => {
      this.closing.delete(profileId);
      if (this.shutdowns.get(profileId) === shutdown) this.shutdowns.delete(profileId);
    });
    this.shutdowns.set(profileId, shutdown);
    this.emit("running-changed", { kind: "closing", profileId });
    return shutdown;
  }

  async close(profileId: ProfileId): Promise<void> {
    // A close may arrive while admission is still awaiting vendor capacity and no child exists yet.
    this.licenseSeatCoordinator?.invalidate("close");
    const record = this.running.get(profileId);
    const pending = this.launchingProcesses.get(profileId);
    if (!record && !pending) {
      if (this.launchPromises.has(profileId)) this.closeRequestedDuringLaunch.add(profileId);
      return;
    }
    const processContext = record ?? pending;
    if (!processContext) return;

    writeProfileLifecycleLog(profileId, processContext, "CLOSE-REQUESTED");
    console.log(`[mkt-browser] close() profile=${profileId} pid=${processContext.pid}`);
    if (record) await this.shutdownRunningProfile(profileId, record, "user-close");
    else if (pending) await this.shutdownLaunchingProfile(profileId, pending);
  }

  isRunning(profileId: ProfileId): boolean {
    return (
      this.running.has(profileId) ||
      this.launching.has(profileId) ||
      this.launchingProcesses.has(profileId) ||
      this.closing.has(profileId)
    );
  }

  getRunningProfileState(profileId: ProfileId): RunningProfileState | null {
    const running = this.running.get(profileId);
    return running
      ? {
          proxy: running.proxy ? { ...running.proxy } : undefined,
          observedProxyIp: running.observedProxyIp,
        }
      : null;
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const session = this.requireSession(profileId);
    const result = await session.navigate(url);
    return { url: result.url };
  }

  async click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.click(selector);
    return { ok: true };
  }

  async type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.type(selector, text);
    return { ok: true };
  }

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const session = this.requireSession(profileId);
    return session.extract();
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const session = this.requireSession(profileId);
    return session.screenshot();
  }

  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    const session = this.requireSession(profileId);
    return session.cdpSend(method, params, sessionId, opts);
  }

  closeAll(options: { shutdown?: boolean } = {}): Promise<void> {
    if (options.shutdown) this.shuttingDown = true;
    if (this.closeAllPromise) return this.closeAllPromise;
    this.licenseSeatCoordinator?.invalidate(options.shutdown ? "shutdown" : "close-all");
    const closing = (async () => {
      await Promise.allSettled([...this.launchPromises.values()]);
      const ids = new Set([...this.running.keys(), ...this.launchingProcesses.keys()]);
      // Wait for every close even if one fails; callers must not dispose shared state early.
      const results = await Promise.allSettled([...ids].map((id) => this.close(id)));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map((failure) => failure.reason), "Some browser profiles could not be closed.");
      }
    })();
    this.closeAllPromise = closing.finally(() => { this.closeAllPromise = null; });
    return this.closeAllPromise;
  }

  private requireSession(profileId: ProfileId): CdpSession {
    if (this.closing.has(profileId)) throw profileNotRunning(profileId);
    const r = this.running.get(profileId);
    if (!r) throw profileNotRunning(profileId);
    return r.session;
  }
}
