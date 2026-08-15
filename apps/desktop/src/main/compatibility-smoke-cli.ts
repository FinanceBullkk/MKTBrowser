import { app } from "electron";
import { join } from "node:path";
import { ProfileManager } from "@mktbrowser/profile-manager";
import { SettingsStore, defaultSettingsPath } from "@mktbrowser/settings-store";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import {
  claimCompatibilitySmokeAuthorization,
  clearClaimedCompatibilitySmokeAuthorization,
} from "./compatibility-smoke-authorization.ts";
import { readCompatibilityEnginePin } from "./compatibility-engine-pin.ts";
import { runCompatibilitySmoke } from "./compatibility-smoke-runner.ts";

export async function runPackagedCompatibilitySmoke(options: {
  authorizationId: string;
  localAppData: string;
  userData: string;
}): Promise<void> {
  if (process.platform !== "win32" || !app.isPackaged) {
    throw new Error("Compatibility smoke mode is available only in the packaged Windows app.");
  }
  const claimed = claimCompatibilitySmokeAuthorization({
    localAppData: options.localAppData,
    authorizationId: options.authorizationId,
  });
  let profileManager: ProfileManager | null = null;
  let browserDriver: ChromiumBrowserDriver | null = null;
  try {
    const pin = readCompatibilityEnginePin(options.localAppData);
    if (!pin || pin.sequence !== claimed.authorization.sequence) {
      throw new Error("The active engine pin does not match the compatibility smoke authorization.");
    }
    const settingsStore = new SettingsStore(defaultSettingsPath(options.userData));
    const settings = await settingsStore.load();
    if (settings.browserEngine !== pin.engineKind) {
      await settingsStore.update({ browserEngine: pin.engineKind });
    }
    const bootstrap = new ChromiumBootstrap({
      engine: pin.engineKind,
      pinnedManifest: {
        version: pin.version,
        url: pin.url,
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes,
      },
      allowUnpinnedManifest: false,
    });
    profileManager = new ProfileManager({
      dbPath: join(options.userData, "data", "profiles.db"),
      profilesRoot: join(options.userData, "data", "profiles"),
    });
    browserDriver = new ChromiumBrowserDriver({
      profileManager,
      chromiumBootstrap: bootstrap,
      extensionStoreRoot: join(options.userData, "data", "extension-store"),
    });
    await runCompatibilitySmoke(claimed.authorization, {
      profileManager,
      browserDriver,
      verifyHealth: async () => {
        await bootstrap.ensure();
        if (bootstrap.getStatus().kind !== "ready") {
          throw new Error("The pinned Browser engine is not ready.");
        }
      },
    });
  } finally {
    await browserDriver?.closeAll().catch(() => {});
    profileManager?.close();
    clearClaimedCompatibilitySmokeAuthorization(claimed.consumedPath);
  }
}
