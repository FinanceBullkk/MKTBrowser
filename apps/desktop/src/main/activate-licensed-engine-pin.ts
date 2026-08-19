/**
 * Writes the compatibility engine pin the browser refuses to run without.
 *
 * `readCompatibilityEnginePin` and the `fetchManifest` gate landed together in
 * "pin the engine and gate activation on the browser side": the browser will
 * not resolve an upstream latest version, because changing Chromium moves the
 * measured fingerprint even when the profile id and seed are unchanged, and an
 * engine that drifted on its own would alter every identity at once. Only the
 * reader shipped, so no machine had a pin, and every install froze on whatever
 * engine it had cached — 146.0.7680.177.5 for the keyless channel.
 *
 * This is the missing writer, and deliberately nothing more. It does not
 * download, install or activate: it records which build the machine is allowed
 * to converge on. The existing bootstrap does the rest on the next launch —
 * `findCached` sees the cached version disagree with the pin, clears the stale
 * runtime, and `fetchManifest` returns this pin instead of asking upstream.
 *
 * Run it as a deliberate act, never on a timer. Activating rotates the
 * fingerprint of every profile on the machine at once, so it belongs before
 * accounts exist or during a planned migration — never underneath a running
 * one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";

import {
  ACTIVE_ENGINE_PIN_FILE,
  compatibilityUpdaterRoot,
  readCompatibilityEnginePin,
} from "./compatibility-engine-pin.ts";
import { resolveLicensedEngineDescriptor } from "./resolve-licensed-engine-descriptor.ts";

export interface LicensedEnginePinActivation {
  version: string;
  sequence: number;
  sizeBytes: number;
  pinPath: string;
}

export async function activateLicensedEnginePin(options: {
  licenseKey: string;
  localAppData: string;
}): Promise<LicensedEnginePinActivation> {
  // Keeps the URL: the pin is fetched once, immediately, by the convergence
  // that this activation triggers. Its expiry never outlives that fetch.
  const engine = await resolveLicensedEngineDescriptor(options.licenseKey);

  const root = compatibilityUpdaterRoot(options.localAppData);
  const previous = existsSync(root) ? readCompatibilityEnginePin(options.localAppData) : null;
  const sequence = (previous?.sequence ?? 0) + 1;

  const pin = {
    schemaVersion: 1 as const,
    sequence,
    engineKind: "cloakbrowser" as const,
    version: engine.version,
    url: engine.url,
    sha256: engine.sha256,
    sizeBytes: engine.sizeBytes,
  };

  mkdirSync(root, { recursive: true });
  const pinPath = win32.join(root, ACTIVE_ENGINE_PIN_FILE);
  // Write-then-rename: a reader that catches this mid-write sees "activation
  // state is damaged" and keeps the browser closed, which is a worse outcome
  // than a slightly slower write.
  const staging = `${pinPath}.staging`;
  writeFileSync(staging, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
  renameSync(staging, pinPath);

  return { version: engine.version, sequence, sizeBytes: engine.sizeBytes, pinPath };
}

/**
 * Reads the pin back through the same validator the browser uses, so a shape
 * this writer got wrong surfaces here instead of at the next launch.
 */
export function verifyWrittenPin(localAppData: string): string {
  const pin = readCompatibilityEnginePin(localAppData);
  if (!pin) throw new Error("The pin was written but reads back as absent.");
  return pin.version;
}

if (process.argv[1] && import.meta.url.endsWith(win32.basename(process.argv[1]))) {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY ?? readKeyFromSettings(localAppData);
  activateLicensedEnginePin({ licenseKey, localAppData })
    .then((result) => {
      const readBack = verifyWrittenPin(localAppData);
      console.log(
        `Pinned ${result.version} (sequence ${result.sequence}, ${result.sizeBytes} bytes)\n` +
          `  ${result.pinPath}\n` +
          `  reads back as ${readBack}\n` +
          `Next launch clears the stale runtime and downloads this build.`,
      );
    })
    .catch((error: unknown) => {
      console.error(`Activation refused: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}

/** Falls back to the key the Settings screen saved, so the CLI needs no argument. */
function readKeyFromSettings(localAppData: string): string {
  try {
    const settingsPath = win32.join(localAppData, "MKTTool", "MKTBrowser", "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      cloakBrowserLicenseKey?: unknown;
    };
    return typeof raw.cloakBrowserLicenseKey === "string" ? raw.cloakBrowserLicenseKey : "";
  } catch {
    return "";
  }
}
