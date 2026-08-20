import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import {
  ProfileManager,
  exportProfile,
  importProfile,
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  deviceCatalog,
  localeCatalog,
  findLocaleIdByCountry,
  copyLegacyMultiZenData,
  findLegacyMultiZenImport,
} from "@mktbrowser/profile-manager";
import {
  HttpTransport,
  PROFILE_MANAGEMENT_ACCESS_POLICY,
  createMktBrowserMcpServer,
  type ActivityEvent,
  type ActivityLog,
} from "@mktbrowser/mcp-server";
import { SettingsStore, defaultSettingsPath, type AppSettings } from "@mktbrowser/settings-store";
import { activateLicensedEnginePin } from "./activate-licensed-engine-pin.ts";
import {
  MKT_BROWSER_MCP_PORT_ENV,
  mktBrowserMcpBaseUrl,
  resolveMktBrowserMcpPort,
  type ChromiumStatus,
  type ExtensionConfig,
  type ProxyConfig,
} from "@mktbrowser/types";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";
import { describeEngineStatus } from "./engine-runtime-info.ts";
import { applyNavigationHardening, mainWindowOptions } from "./main-window-security.ts";
import { loadOrCreateMcpToken } from "./mcpToken.ts";
import { PRODUCT_APP_ID, PRODUCT_NAME, resolveProductUserDataPath } from "./productIdentity.ts";
import { ExtensionsService } from "./extensions/ExtensionsService.ts";
import {
  sweepOrphans,
  storeEntryDir,
  resolveLoadDir,
  readManifestIcon,
} from "./extensions/extensionStore.ts";
import { probeProxyGeo, type ProxyGeoResult } from "./proxyGeo.ts";
import { deleteBrowserProfile } from "./profile-deletion-lifecycle.ts";
import { WindowsLocalInstallInspector } from "./windows-local-install-inspector.ts";
import {
  type CompatibilityEnginePin,
  isDisposableUnpinnedEngineRun,
  readCompatibilityActivationBlock,
  readCompatibilityEnginePin,
} from "./compatibility-engine-pin.ts";
import { COMPATIBILITY_SMOKE_SWITCH } from "./compatibility-smoke-authorization.ts";
import { runPackagedCompatibilitySmoke } from "./compatibility-smoke-cli.ts";
import { CdpSession } from "@mktbrowser/cdp-driver";
import { appendProfileLifecycleLine } from "./profile-lifecycle-log.ts";
import { LicenseKeyPool } from "./license-key-pool.ts";
import { sweepOrphanedProfileBrowsers } from "./startup-orphan-sweep.ts";
import {
  createIpcRuntimeRegistration,
  type IpcRuntimeHandler,
} from "./ipc-runtime-registration.ts";
import {
  IPC,
  IPC_EVENTS,
  isIpcEventChannel,
  type IpcEventChannel,
  type IpcInvokeChannel,
} from "../shared/ipc-exposure-policy.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const mcpHttpPort = resolveMktBrowserMcpPort(process.env[MKT_BROWSER_MCP_PORT_ENV]);

/**
 * Resolve the master 1024×1024 brand icon. In packaged builds Electron picks
 * the bundled icon based on platform (.icns on Mac, the .ico/.png on Win/Linux).
 * In dev we fall back to the source PNG so the dock / taskbar / window icons
 * are not the default Electron logo.
 */
function resolveAppIcon(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png"), join(process.resourcesPath, "..", "icon.png")]
    : [
        join(__dirname, "../../../../build/icon.png"),
        join(__dirname, "../../../build/icon.png"),
        join(__dirname, "../../build/icon.png"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

let mainWindow: BrowserWindow | null = null;
let profileManager: ProfileManager;
let browserDriver: ChromiumBrowserDriver;
let chromiumBootstrap: ChromiumBootstrap;
let extensionsService: ExtensionsService;
/** Recent companion installs, to de-dupe the marker's retry logs. */
const recentCompanionInstalls = new Set<string>();
let activityLog: ActivityLog;
let settingsStore: SettingsStore;
let httpTransport: HttpTransport | null = null;
let mcpAuthToken: string | null = null;
let cachedSettings: AppSettings | null = null;
let licenseKeyPool: LicenseKeyPool | null = null;
let browserDriverReady = false;
let switchToCftInFlight: Promise<ChromiumStatus> | null = null;
let activeCompatibilityEnginePin: CompatibilityEnginePin | null = null;

const ipcRegistration = createIpcRuntimeRegistration<IpcMainInvokeEvent>({
  register: (channel, handler) => ipcMain.handle(channel, handler),
  isTrustedSender: (event) => Boolean(mainWindow && event.sender === mainWindow.webContents),
});

function handleIpc(
  channel: IpcInvokeChannel,
  handler: IpcRuntimeHandler<IpcMainInvokeEvent>,
): void {
  ipcRegistration.handle(channel, handler);
}

function sendToRenderer(channel: IpcEventChannel, payload: unknown): void {
  if (!isIpcEventChannel(channel)) throw new Error(`Unclassified IPC event: ${channel}`);
  mainWindow?.webContents.send(channel, payload);
}

function createChromiumBootstrap(engine: AppSettings["browserEngine"]): ChromiumBootstrap {
  const pin = activeCompatibilityEnginePin;
  if (pin && pin.engineKind !== engine) {
    throw new Error(
      `The active compatibility set pins ${pin.engineKind}, but Settings selects ${engine}. Run installer repair instead of changing the engine independently.`,
    );
  }
  const bootstrap = new ChromiumBootstrap({
    engine,
    pinnedManifest: pin
      ? { version: pin.version, url: pin.url, sha256: pin.sha256, sizeBytes: pin.sizeBytes }
      : undefined,
    allowUnpinnedManifest: isDisposableUnpinnedEngineRun({
      isPackaged: app.isPackaged,
      environmentEnabled: process.env.MKT_BROWSER_ALLOW_UNPINNED_ENGINE === "1",
      hasExplicitUserDataDir: app.commandLine.hasSwitch("user-data-dir"),
    }),
    // Read at construction: switching the key requires a restart, same as
    // switching the engine. Ignored by CFT, which has no licensed channel.
    cloakBrowserLicenseKey: cachedSettings?.cloakBrowserLicenseKey ?? "",
  });
  bootstrap.on("status", (status: ChromiumStatus) => {
    if (chromiumBootstrap === bootstrap) {
      sendToRenderer(IPC_EVENTS.CHROMIUM_STATUS, status);
    }
  });
  return bootstrap;
}

function startChromiumBootstrap(bootstrap: ChromiumBootstrap): void {
  void bootstrap.ensure().catch((error) => {
    process.stderr.write(`Chromium bootstrap failed: ${String(error)}\n`);
  });
}

function createWindow(): void {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow(mainWindowOptions({ mainDir: __dirname, iconPath }));

  applyNavigationHardening(mainWindow.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
    process.stderr.write(`Renderer failed to load (${code} ${description}): ${url}\n`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`Renderer process gone: ${JSON.stringify(details)}\n`);
  });
}

// Product identity and the data root must be configured before app.whenReady().
// An explicit Electron --user-data-dir remains available solely for disposable
// development and verification runs and skips legacy discovery. Normal launches
// use the fixed product root and may offer a first-run copy from MultiZen.
app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId(PRODUCT_APP_ID);
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const productUserData = resolveProductUserDataPath({
    platform: process.platform,
    appData: app.getPath("appData"),
    localAppData: process.env.LOCALAPPDATA,
  });
  mkdirSync(productUserData, { recursive: true });
  app.setPath("userData", productUserData);
}
const compatibilityActivationBlock =
  process.platform === "win32"
    ? readCompatibilityActivationBlock(process.env.LOCALAPPDATA ?? "")
    : null;
const compatibilitySmokeAuthorizationId = app.commandLine.getSwitchValue(
  COMPATIBILITY_SMOKE_SWITCH,
);
app.setAboutPanelOptions({
  applicationName: PRODUCT_NAME,
  applicationVersion: app.getVersion(),
});

app
  .whenReady()
  .then(async () => {
    if (compatibilitySmokeAuthorizationId) {
      try {
        await runPackagedCompatibilitySmoke({
          authorizationId: compatibilitySmokeAuthorizationId,
          localAppData: process.env.LOCALAPPDATA ?? "",
          userData: app.getPath("userData"),
        });
        app.exit(0);
      } catch (error) {
        process.stderr.write(`Compatibility smoke failed: ${(error as Error).message}\n`);
        app.exit(1);
      }
      return;
    }
    if (compatibilityActivationBlock) {
      dialog.showErrorBox("MKT Browser update incomplete", compatibilityActivationBlock);
      app.quit();
      return;
    }
    // macOS: explicitly set the dock icon. In packaged .app bundles macOS
    // picks the .icns automatically, but in dev (running ./node_modules/.bin/electron)
    // the dock shows the generic Electron icon unless we override it here.
    if (process.platform === "darwin" && !app.isPackaged) {
      const iconPath = resolveAppIcon();
      if (iconPath) {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) app.dock?.setIcon(img);
      }
    }

    const userData = app.getPath("userData");
    const localInstallInspector = new WindowsLocalInstallInspector({
      scriptPath: join(
        process.resourcesPath,
        "installer",
        "windows-install-conflict-detection.ps1",
      ),
      browserPath: process.execPath,
      relayPath: process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "MKTTool-Relay", "MKTTool-Relay.exe")
        : "",
      startupDirectory: join(
        app.getPath("appData"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      ),
    });
    const runtimeCapabilities = async () =>
      (await localInstallInspector.isReady()) ? (["local-install-ready-v1"] as const) : [];
    const dataRoot = join(userData, "data");
    if (process.platform === "win32" && !app.commandLine.hasSwitch("user-data-dir")) {
      const legacyImport = findLegacyMultiZenImport(app.getPath("appData"), dataRoot);
      if (legacyImport?.status === "unreadable") {
        const choice = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Start fresh", "Quit"],
          defaultId: 1,
          cancelId: 1,
          message: "MKT Browser could not read the existing MultiZen profiles.",
          detail:
            "The MultiZen data was not changed. Close MultiZen and try again, or start with an independent empty MKT Browser store.",
        });
        if (choice.response === 1) {
          app.quit();
          return;
        }
      } else if (legacyImport?.status === "ready") {
        const choice = await dialog.showMessageBox({
          type: "question",
          buttons: ["Copy profiles", "Start fresh", "Quit"],
          defaultId: 0,
          cancelId: 2,
          message: `MKT Browser found ${legacyImport.profileCount} MultiZen profile${legacyImport.profileCount === 1 ? "" : "s"} on this PC.`,
          detail:
            "Close MultiZen before copying. MKT Browser will create its own copy and will not change or delete the MultiZen data.",
        });
        if (choice.response === 2) {
          app.quit();
          return;
        }
        if (choice.response === 0) {
          try {
            await copyLegacyMultiZenData(legacyImport.legacyDataRoot, dataRoot);
          } catch {
            await dialog.showMessageBox({
              type: "error",
              buttons: ["Close MKT Browser"],
              message: "MKT Browser could not copy the MultiZen profiles.",
              detail:
                "The original MultiZen data was not changed. Close MultiZen, then open MKT Browser and try again.",
            });
            app.quit();
            return;
          }
        }
      }
    }
    // Shared extension store (deduped extension files loaded into many profiles).
    const extensionStoreRoot = join(dataRoot, "extension-store");

    settingsStore = new SettingsStore(defaultSettingsPath(userData));
    cachedSettings = await settingsStore.load();
    activeCompatibilityEnginePin =
      process.platform === "win32"
        ? readCompatibilityEnginePin(process.env.LOCALAPPDATA ?? "")
        : null;
    if (
      activeCompatibilityEnginePin &&
      cachedSettings.browserEngine !== activeCompatibilityEnginePin.engineKind
    ) {
      cachedSettings = await settingsStore.update({
        browserEngine: activeCompatibilityEnginePin.engineKind,
      });
    }

    profileManager = new ProfileManager({
      dbPath: join(dataRoot, "profiles.db"),
      profilesRoot: join(dataRoot, "profiles"),
    });

    // Reclaim shared store entries no profile references any more (e.g. left by a
    // crash mid-delete) plus stale staging dirs. Best-effort; never blocks startup.
    void sweepOrphans(
      extensionStoreRoot,
      profileManager.allExtensionRefs().map((r) => r.ext),
    )
      .then((res) => {
        if (res.removed > 0) {
          process.stdout.write(
            `[mkt-browser] extension-store sweep reclaimed ${res.removed} orphan(s)\n`,
          );
        }
      })
      .catch(() => {});

    // Close browsers a previous run left behind. Only reachable after an unclean exit — the
    // normal path goes through before-quit -> closeAll(). An orphan keeps the engine's licence
    // seat until its lease expires, 7 to 17 minutes, during which the app truthfully reports zero
    // profiles running and every launch truthfully fails, and nothing joins those two facts up for
    // the operator. Best-effort and never awaited: a slow process listing must not delay the window.
    if (cachedSettings.startupOrphanSweep) {
      const profilesRoot = join(dataRoot, "profiles");
      void sweepOrphanedProfileBrowsers(profilesRoot, {
        isAlive: (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        kill: (pid) => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone, or not ours to kill.
          }
        },
        closeViaCdp: async (port) => {
          // The same call the Stop button makes, and the only shutdown that hands the seat back.
          const session = new CdpSession({ port, engine: "cloakbrowser", host: "127.0.0.1" });
          try {
            await session.connect();
            await session.closeBrowser();
          } finally {
            await session.close().catch(() => {});
          }
        },
        log: (event) => appendProfileLifecycleLine({ ...event, profilesRoot }),
      }).catch(() => {
        // Reclaiming a seat is best-effort; failing to must never stop the app from starting.
      });
    }

    // Chromium bootstrap — picks the engine from user settings (CFT default,
    // CloakBrowser opt-in for stronger anti-detect), downloads it on first
    // run, and reports progress to the renderer.
    chromiumBootstrap = createChromiumBootstrap(cachedSettings.browserEngine);
    // Kick off the ensure() in the background so the UI can render immediately
    // and show download progress. Profile launches will wait until ready.
    startChromiumBootstrap(chromiumBootstrap);

    // Per-profile extension management. Engine version feeds the Web Store CRX
    // endpoint's prodversion (falls back to a sane default before the runtime is
    // ready).
    extensionsService = new ExtensionsService({
      profileManager,
      extensionStoreRoot,
      engineVersion: () => {
        const s = chromiumBootstrap.getStatus();
        return s.kind === "ready" ? s.version : "145.0.0.0";
      },
    });

    // One session per licence key, so the pool is what decides how many profiles can be open at
    // once. Built from settings on startup; changing keys needs a restart, same as the engine.
    licenseKeyPool = new LicenseKeyPool({
      keys: cachedSettings.cloakBrowserLicenseKeys,
      cooldownMs: 17 * 60_000,
    });

    browserDriver = new ChromiumBrowserDriver({
      profileManager,
      chromiumBootstrap,
      extensionStoreRoot,
      licenseKeyPool,
      // The companion's "Add to MKT Browser" button routes here (profile-scoped).
      // Confirm natively first: any script on the store page could trigger the
      // channel, so an explicit OS dialog makes a drive-by install impossible.
      onCompanionInstall: (profileId, extensionId) => {
        // De-dupe: the companion logs the marker a few times to beat a race, so
        // ignore repeats of the same {profile,extension} within a short window.
        const dedupeKey = `${profileId}:${extensionId}`;
        if (recentCompanionInstalls.has(dedupeKey)) return;
        recentCompanionInstalls.add(dedupeKey);
        setTimeout(() => recentCompanionInstalls.delete(dedupeKey), 15000);
        void (async () => {
          const profile = profileManager.get(profileId);
          const choice = await dialog.showMessageBox(mainWindow!, {
            type: "question",
            buttons: ["Add to MKT Browser", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: "Add this extension to the profile?",
            detail: `Extension ${extensionId} will be installed into "${profile?.name ?? profileId}" and load on the next launch.`,
          });
          if (choice.response !== 0) return;
          try {
            const extension = await extensionsService.installFromWebStore(profileId, extensionId);
            sendToRenderer(IPC_EVENTS.EXTENSIONS_INSTALLED, {
              ok: true,
              profileId,
              extension,
            });
            // Apply immediately: Chromium only reads --load-extension at startup,
            // so relaunch the profile (session restore brings tabs back) instead
            // of making the user close + reopen it by hand.
            if (browserDriver.isRunning(profileId)) {
              await browserDriver.close(profileId).catch(() => {});
              await browserDriver.launch(profileId).catch((e: unknown) => {
                // The profile is now closed and didn't reopen — tell the user so
                // they're not left wondering where their browser went.
                sendToRenderer(IPC_EVENTS.EXTENSIONS_INSTALLED, {
                  ok: false,
                  profileId,
                  error: `Added it, but the profile didn't reopen — launch it again. (${(e as Error).message})`,
                });
              });
            }
          } catch (e) {
            sendToRenderer(IPC_EVENTS.EXTENSIONS_INSTALLED, {
              ok: false,
              profileId,
              error: (e as Error).message,
            });
          }
        })();
      },
    });
    browserDriverReady = true;

    const mcp = createMktBrowserMcpServer({
      profileManager,
      browserDriver,
      // Read live on every call. A cached value would let `get_runtime_info` claim an engine that
      // has since been removed, which is exactly the answer the caller is trying to verify.
      engineInfo: () =>
        describeEngineStatus(chromiumBootstrap.getEngine(), chromiumBootstrap.getStatus()),
      runtimeCapabilities,
      // The release the operator installed — not the MCP contract constant. These drifted apart
      // and `get_runtime_info` spent an evening answering 0.3.1 on a 0.3.6 install, which is the
      // one question the call exists to answer.
      appVersion: app.getVersion(),
    });
    activityLog = mcp.activityLog;

    // Forward activity events to renderer
    activityLog.on("event", (e: ActivityEvent) => {
      sendToRenderer(IPC_EVENTS.ACTIVITY_EVENT, e);
    });

    // Forward profile running-state changes (manual launch, manual close,
    // and — most importantly — external Chromium close where the user quits
    // the browser window directly).
    browserDriver.on("running-changed", (change) => {
      sendToRenderer(IPC_EVENTS.PROFILES_RUNNING_CHANGED, change);
    });

    // Background-probe proxies for profiles missing a cached country code
    // (existing rows from before the proxy_country migration, or rows where
    // the user changed proxy and we cleared the stale value). Runs once at
    // startup so the GUI flag chip reflects the proxy egress without forcing
    // the user to click "Test proxy" or relaunch.
    void backfillProxyCountries();

    // Optional embedded HTTP+SSE transport so external Cursor/Claude can connect
    if (cachedSettings.mcpHttpEnabled) {
      try {
        // Require a bearer token so only clients that hold the locally-stored
        // secret (not a random local process, not a DNS-rebinding web page) can
        // drive the browser-control tools. Generated + persisted 0600 on first run.
        mcpAuthToken = loadOrCreateMcpToken(userData);
        httpTransport = new HttpTransport({
          port: mcpHttpPort,
          authToken: mcpAuthToken,
          accessPolicy: PROFILE_MANAGEMENT_ACCESS_POLICY,
        });
        // Streamable HTTP builds a fresh MCP server per request; give it a factory
        // that reuses the same profileManager/browserDriver AND the shared
        // activityLog, so every transport's tool calls land in the one live feed.
        await httpTransport.start(
          (accessPolicy) =>
            createMktBrowserMcpServer({
              profileManager,
              browserDriver,
              activityLog,
              accessPolicy,
              engineInfo: () =>
                describeEngineStatus(chromiumBootstrap.getEngine(), chromiumBootstrap.getStatus()),
              runtimeCapabilities,
              appVersion: app.getVersion(),
            }).server,
        );
      } catch (e) {
        // Port collision is non-fatal — log and continue
        process.stderr.write(`MCP HTTP transport failed to start: ${String(e)}\n`);
        httpTransport = null;
      }
    }

    // Profile IPC
    handleIpc(IPC.PROFILES_LIST, () =>
      profileManager.list().map((p) => ({ ...p, isRunning: browserDriver.isRunning(p.id) })),
    );
    handleIpc(IPC.PROFILES_GET, (_e, id: string) => profileManager.get(id));
    handleIpc(IPC.PROFILES_CREATE, (_e, input: Parameters<ProfileManager["create"]>[0]) =>
      profileManager.create(input),
    );
    handleIpc(
      IPC.PROFILES_UPDATE,
      (_e, id: string, patch: Parameters<ProfileManager["update"]>[1]) =>
        profileManager.update(id, patch),
    );
    handleIpc(
      IPC.PROFILES_DELETE_PERMANENTLY,
      (_e, input: { profileId: string; confirmation: string }) =>
        deleteBrowserProfile(input, { profileManager, browserDriver }),
    );
    handleIpc(IPC.PROFILES_LAUNCH, (_e, id: string) => {
      const profile = profileManager.get(id);
      if (profile?.managed) {
        throw new Error(`Managed profile ${id} can be launched only through MKTTool.`);
      }
      return browserDriver.launch(id);
    });
    handleIpc(IPC.PROFILES_CLOSE, (_e, id: string) => browserDriver.close(id));

    // Settings IPC
    handleIpc(IPC.SETTINGS_GET, () => settingsStore.load());
    handleIpc(IPC.SETTINGS_UPDATE, async (_e, patch: Partial<AppSettings>) => {
      if (
        patch.browserEngine &&
        activeCompatibilityEnginePin &&
        patch.browserEngine !== activeCompatibilityEnginePin.engineKind
      ) {
        throw new Error(
          `Compatibility set ${activeCompatibilityEnginePin.sequence} pins ${activeCompatibilityEnginePin.engineKind}. Install another signed compatibility set instead of switching engines independently.`,
        );
      }
      cachedSettings = await settingsStore.update(patch);
      return cachedSettings;
    });

    // Activity IPC
    handleIpc(IPC.ACTIVITY_RECENT, () => activityLog.recent());

    // Chromium bootstrap IPC
    handleIpc(IPC.CHROMIUM_STATUS, () => chromiumBootstrap.getStatus());
    handleIpc(IPC.CHROMIUM_RETRY, () => chromiumBootstrap.retry());
    // Deliberate engine upgrade. The pin is what the bootstrap obeys, so
    // activating means writing a new pin and letting the existing convergence
    // path clear the stale runtime and install the pinned build. Never on a
    // timer: a new Chromium moves the measured fingerprint of every profile at
    // once, which is the whole reason the pin exists.
    handleIpc(IPC.CHROMIUM_ACTIVATE_LATEST, async () => {
      if (process.platform !== "win32") {
        throw new Error("Engine activation is Windows-only for now.");
      }
      await activateLicensedEnginePin({
        licenseKey: cachedSettings?.cloakBrowserLicenseKey ?? "",
        localAppData: process.env.LOCALAPPDATA ?? "",
      });
      activeCompatibilityEnginePin = readCompatibilityEnginePin(process.env.LOCALAPPDATA ?? "");
      return chromiumBootstrap.retry();
    });
    handleIpc(IPC.CHROMIUM_SWITCH_TO_CFT, async () => {
      if (switchToCftInFlight) return switchToCftInFlight;
      if (activeCompatibilityEnginePin && activeCompatibilityEnginePin.engineKind !== "cft") {
        throw new Error(
          `Compatibility set ${activeCompatibilityEnginePin.sequence} pins ${activeCompatibilityEnginePin.engineKind}; the fallback engine is locked until another signed set is installed.`,
        );
      }
      if (chromiumBootstrap.getEngine() !== "cloakbrowser") {
        return chromiumBootstrap.getStatus();
      }

      const operation = (async (): Promise<ChromiumStatus> => {
        const previous = chromiumBootstrap;
        const fallback = createChromiumBootstrap("cft");
        if (browserDriverReady) browserDriver.setChromiumBootstrap(fallback);
        try {
          cachedSettings = await settingsStore.update({ browserEngine: "cft" });
          chromiumBootstrap = fallback;
        } catch (cause) {
          if (browserDriverReady) browserDriver.setChromiumBootstrap(previous);
          throw cause;
        }
        sendToRenderer(IPC_EVENTS.CHROMIUM_STATUS, fallback.getStatus());
        startChromiumBootstrap(fallback);
        return fallback.getStatus();
      })();
      switchToCftInFlight = operation;
      try {
        return await operation;
      } finally {
        if (switchToCftInFlight === operation) switchToCftInFlight = null;
      }
    });

    // Extensions IPC (per-profile)
    handleIpc(IPC.EXTENSIONS_LIST, (_e, profileId: string) => extensionsService.list(profileId));
    handleIpc(IPC.EXTENSIONS_ADD_FROM_FILE, async (_e, profileId: string) => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: "Add extension (.crx or .zip)",
        properties: ["openFile"],
        filters: [{ name: "Chrome extension", extensions: ["crx", "zip"] }],
      });
      if (r.canceled || !r.filePaths[0]) return extensionsService.list(profileId);
      await extensionsService.installFromFile(profileId, r.filePaths[0]);
      return extensionsService.list(profileId);
    });
    handleIpc(IPC.EXTENSIONS_ADD_FROM_FOLDER, async (_e, profileId: string) => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: "Add unpacked extension folder",
        properties: ["openDirectory"],
      });
      if (r.canceled || !r.filePaths[0]) return extensionsService.list(profileId);
      await extensionsService.installFromFile(profileId, r.filePaths[0]);
      return extensionsService.list(profileId);
    });
    handleIpc(IPC.EXTENSIONS_ADD_FROM_WEB_STORE, async (_e, profileId: string, urlOrId: string) => {
      try {
        await extensionsService.installFromWebStore(profileId, urlOrId);
      } catch (e) {
        process.stderr.write(
          `[extensions] addFromWebStore FAILED: ${(e as Error).stack ?? (e as Error).message}\n`,
        );
        throw e;
      }
      return extensionsService.list(profileId);
    });
    handleIpc(IPC.EXTENSIONS_REMOVE, async (_e, profileId: string, extId: string) => {
      await extensionsService.remove(profileId, extId);
      return extensionsService.list(profileId);
    });
    handleIpc(IPC.EXTENSIONS_TOGGLE, (_e, profileId: string, extId: string, enabled: boolean) => {
      extensionsService.setEnabled(profileId, extId, enabled);
      return extensionsService.list(profileId);
    });

    // Staging IPC (no profile id yet) — used by the create sheet to attach or
    // install extensions before the profile exists. `prepare*` unpack into the
    // shared store and return the single ref; the renderer holds the staged list
    // and passes it to profiles:create as `extensions`.
    // Shared staging helper: unpack a local source into the store, logging
    // failures like prepareFromWebStore does (the dialogs above call this).
    const prepareStaged = async (sourcePath: string): Promise<ExtensionConfig | null> => {
      try {
        return await extensionsService.prepareFromFile(sourcePath);
      } catch (e) {
        process.stderr.write(
          `[extensions] prepareFromFile FAILED: ${(e as Error).stack ?? (e as Error).message}\n`,
        );
        throw e;
      }
    };

    handleIpc(IPC.EXTENSIONS_STORE_ENTRIES, () => extensionsService.storeEntries());
    // Real icon from an extension's own manifest, as a data URI (or null → the
    // renderer shows the generic glyph). Lets non-catalog extensions show their
    // actual icon. Shared entries resolve from the store; profile-scoped ones
    // need the owning profile's dataDir.
    handleIpc(
      IPC.EXTENSIONS_ICON,
      async (_e, ext: ExtensionConfig, profileId: string | null): Promise<string | null> => {
        const dataDir = profileId ? profileManager.get(profileId)?.dataDir : undefined;
        if (ext.scope !== "shared" && !dataDir) return null;
        const dir = resolveLoadDir(ext, dataDir ?? "", extensionStoreRoot);
        // Defense-in-depth: a crafted archive could carry a profile-scope ext.dir
        // that escapes the profile. Keep the resolved dir inside its expected root
        // before reading any file from it.
        const root = resolve(ext.scope === "shared" ? extensionStoreRoot : (dataDir ?? ""));
        const abs = resolve(dir);
        if (abs !== root && !abs.startsWith(root + sep)) return null;
        return readManifestIcon(abs);
      },
    );
    handleIpc(IPC.EXTENSIONS_PREPARE_FROM_WEB_STORE, async (_e, urlOrId: string) => {
      try {
        return await extensionsService.prepareFromWebStore(urlOrId);
      } catch (e) {
        process.stderr.write(
          `[extensions] prepareFromWebStore FAILED: ${(e as Error).stack ?? (e as Error).message}\n`,
        );
        throw e;
      }
    });
    handleIpc(IPC.EXTENSIONS_PREPARE_FROM_FILE, async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: "Add extension (.crx or .zip)",
        properties: ["openFile"],
        filters: [{ name: "Chrome extension", extensions: ["crx", "zip"] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      return prepareStaged(r.filePaths[0]);
    });
    handleIpc(IPC.EXTENSIONS_PREPARE_FROM_FOLDER, async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: "Add unpacked extension folder",
        properties: ["openDirectory"],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      return prepareStaged(r.filePaths[0]);
    });

    // Fingerprint generator IPC — called from create + edit forms when the
    // user hits Regen. Returns a fresh, internally-consistent preset.
    handleIpc(IPC.FINGERPRINT_GENERATE, () => generateFingerprint());
    handleIpc(IPC.FINGERPRINT_DEVICES, () => deviceCatalog());
    handleIpc(IPC.FINGERPRINT_LOCALES, () => localeCatalog());
    handleIpc(IPC.FINGERPRINT_LOCALE_FOR_COUNTRY, (_e, cc: string) => findLocaleIdByCountry(cc));
    handleIpc(
      IPC.FINGERPRINT_RECONCILE,
      (
        _e,
        current: Parameters<typeof reconcileFingerprint>[0],
        patch: Parameters<typeof reconcileFingerprint>[1],
      ) => {
        // reconcileFingerprint now throws on invalid input (the honest contract
        // for MCP). GUI patches are all catalog-sourced so this "can't happen"
        // in normal use, but the renderer calls this as `void reconcile(...)`,
        // so a throw would surface as an unhandled rejection and silently no-op
        // the edit. Degrade gracefully: on a reconcile rejection (e.g. a corrupt
        // or legacy persisted fingerprint) return `current` unchanged; rethrow
        // anything else.
        try {
          return reconcileFingerprint(current, patch);
        } catch (e) {
          if (e instanceof FingerprintReconcileError) {
            console.warn("[mkt-browser] fingerprint reconcile rejected:", e.message);
            return current;
          }
          throw e;
        }
      },
    );

    // Proxy geo-IP probe — verifies that the profile's locale + timezone are
    // coherent with the proxy IP's country. Detection vendors flag mismatches
    // like "Accept-Language: ru-RU + IP in US" as suspicious.
    handleIpc(
      IPC.PROXY_DETECT_GEO,
      async (
        _e,
        proxy: ProxyConfig,
        profileId?: string,
      ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> => {
        try {
          const geo = await probeProxyGeo(proxy);
          // Persist the resolved country onto the profile (if one was given)
          // so the GUI flag chip can render it without waiting for next
          // launch. Lower-cased for the flag-icons CSS class.
          if (profileId && geo.country) {
            profileManager.setProxyCountry(profileId, geo.country.toLowerCase());
          }
          return { ok: true, geo };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    );

    // Profile import / export
    handleIpc(
      IPC.PROFILES_EXPORT,
      async (
        _e,
        id: string,
        passphrase: string,
      ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
        const profile = profileManager.get(id);
        if (!profile) return { ok: false, reason: "not_found" };
        if (profile.deletionPending) {
          return {
            ok: false,
            reason: "Finish or retry this profile's pending deletion before exporting it.",
          };
        }
        if (profile.managed) {
          return {
            ok: false,
            reason: "Managed profiles can be transferred only through the MKTTool recovery flow.",
          };
        }
        const result = await dialog.showSaveDialog(mainWindow ?? undefined!, {
          title: "Export profile",
          defaultPath: `${profile.name.replace(/[^a-z0-9-_]+/gi, "_")}.mzar`,
          filters: [{ name: "MKT Browser archive", extensions: ["mzar"] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, reason: "cancelled" };
        // Bundle the profile's shared-store extensions so importing on another
        // machine restores the extension code too, not just a dangling reference.
        const extensions = (profile.extensions ?? [])
          .filter((e) => e.scope === "shared")
          .map((e) => ({
            id: e.id,
            version: e.version,
            dir: storeEntryDir(extensionStoreRoot, e.id, e.version),
          }));
        await exportProfile(profile, passphrase, result.filePath, { extensions });
        return { ok: true, path: result.filePath };
      },
    );

    handleIpc(
      IPC.PROFILES_IMPORT,
      async (
        _e,
        passphrase: string,
      ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          title: "Import profile",
          filters: [{ name: "MKT Browser archive", extensions: ["mzar"] }],
          properties: ["openFile"],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, reason: "cancelled" };
        }
        const archivePath = result.filePaths[0];
        if (!archivePath) return { ok: false, reason: "cancelled" };
        try {
          // Restore the full user-data-dir to disk. If the archive's id already
          // exists here, importProfile mints a fresh id + dataDir so it never
          // overwrites the existing profile. The returned Profile carries every
          // field (extensions, icon, startUrl, searchProvider, fingerprint,
          // proxy) and its dataDir points at the restored files.
          const restored = await importProfile(
            archivePath,
            passphrase,
            join(dataRoot, "profiles"),
            {
              idTaken: (id) => Boolean(profileManager.get(id)),
              // Restore bundled (v2) extensions into the shared store so they work
              // on this machine without the user re-adding them.
              extensionStoreRoot,
            },
          );
          // Insert the row verbatim so the DB entry points at the restored files
          // (the old create()-based path minted a new id/dataDir and orphaned the
          // cookies/logins that were just restored).
          const inserted = profileManager.insertImported(restored);
          return { ok: true, id: inserted.id };
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
      },
    );

    // System info
    handleIpc(IPC.SYSTEM_INFO, () => ({
      mcpHttpUrl: httpTransport ? mktBrowserMcpBaseUrl(mcpHttpPort) : null,
      // Bearer token an MCP client must send as `Authorization: Bearer <token>`.
      // Surfaced so the in-app panel can show a ready-to-paste client config.
      mcpAuthToken: httpTransport ? mcpAuthToken : null,
      appVersion: app.getVersion(),
      platform: process.platform,
      compatibilityEnginePin: activeCompatibilityEnginePin
        ? {
            sequence: activeCompatibilityEnginePin.sequence,
            engineKind: activeCompatibilityEnginePin.engineKind,
            version: activeCompatibilityEnginePin.version,
          }
        : null,
    }));
    ipcRegistration.assertComplete();

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((e: unknown) => {
    // A failure anywhere in the async startup would otherwise reject SILENTLY:
    // createWindow() is the last step, so the dock icon appears but no window and
    // no error ever shows. The known trigger is the native better-sqlite3 binding
    // failing to load when a wrong-arch .node ships (an arm64 binary in the x64
    // build → crashes on Intel Macs). Surface it as a visible dialog and quit
    // cleanly instead of a mystery no-window.
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`[mkt-browser] fatal startup error:\n${detail}\n`);
    dialog.showErrorBox(
      "MKT Browser failed to start",
      `A startup step failed:\n\n${e instanceof Error ? e.message : String(e)}\n\n` +
        "Please report this message to the MKTTool administrator.",
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Probe geo for every profile that has a proxy but no cached country code
 * yet. Each probe takes ~1-3s; we run them sequentially so we don't hammer
 * the same upstream proxy with parallel requests, and emit a renderer
 * event after each one so the flag chip updates as soon as the result
 * lands. Failures are non-fatal — the next launch will re-probe.
 */
async function backfillProxyCountries(): Promise<void> {
  if (!profileManager) return;
  const profiles = profileManager.list();
  for (const summary of profiles) {
    if (!summary.proxy || summary.proxyCountry) continue;
    try {
      const geo = await probeProxyGeo(summary.proxy, { timeoutMs: 6000 });
      if (geo.country) {
        profileManager.setProxyCountry(summary.id, geo.country.toLowerCase());
        // Nudge the renderer so it refetches the list and re-renders flags.
        sendToRenderer(IPC_EVENTS.PROFILES_PROXY_COUNTRY_UPDATED, {
          id: summary.id,
          country: geo.country.toLowerCase(),
        });
      }
    } catch {
      // Proxy down / probe service rate-limited — skip silently.
    }
  }
}

app.on("before-quit", async (e) => {
  e.preventDefault();
  try {
    await browserDriver?.closeAll();
    await httpTransport?.stop();
    profileManager?.close();
  } finally {
    app.exit(0);
  }
});
