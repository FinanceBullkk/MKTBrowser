import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import type { BrowserEngine } from "@mktbrowser/settings-store";

export const ACTIVE_ENGINE_PIN_FILE = "active-engine.json";
export const ACTIVATION_MARKER_FILE = "activation-marker.json";

export interface CompatibilityEnginePin {
  schemaVersion: 1;
  sequence: number;
  engineKind: BrowserEngine;
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export function isDisposableUnpinnedEngineRun(options: {
  isPackaged: boolean;
  environmentEnabled: boolean;
  hasExplicitUserDataDir: boolean;
}): boolean {
  return !options.isPackaged && options.environmentEnabled && options.hasExplicitUserDataDir;
}

export function isCachedEngineVersionAllowed(
  cachedVersion: string,
  pin: Pick<CompatibilityEnginePin, "version"> | null,
): boolean {
  return pin === null || cachedVersion === pin.version;
}

export function compatibilityUpdaterRoot(localAppData: string): string {
  if (!localAppData.trim() || !win32.isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA is required to resolve compatibility update state.");
  }
  return win32.join(localAppData, "MKTTool", "compatibility-updater");
}

export function readCompatibilityEnginePin(localAppData: string): CompatibilityEnginePin | null {
  const filePath = win32.join(compatibilityUpdaterRoot(localAppData), ACTIVE_ENGINE_PIN_FILE);
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CompatibilityEnginePin>;
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) <= 0 ||
      // CloakBrowser is the only engine a pin may name; a pin carrying the
      // retired "cft" kind is invalid and fails closed at startup.
      value.engineKind !== "cloakbrowser" ||
      typeof value.version !== "string" ||
      !value.version ||
      typeof value.url !== "string" ||
      new URL(value.url).protocol !== "https:" ||
      typeof value.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.sizeBytes) ||
      Number(value.sizeBytes) <= 0
    ) {
      throw new Error("invalid engine pin shape");
    }
    return value as CompatibilityEnginePin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`The active compatibility engine pin is invalid: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function readCompatibilityActivationBlock(localAppData: string): string | null {
  const filePath = win32.join(compatibilityUpdaterRoot(localAppData), ACTIVATION_MARKER_FILE);
  try {
    const marker = JSON.parse(readFileSync(filePath, "utf8")) as {
      sequence?: unknown;
      phase?: unknown;
    };
    if (!Number.isSafeInteger(marker.sequence) || typeof marker.phase !== "string") {
      throw new Error("invalid activation marker shape");
    }
    return `Compatibility set ${marker.sequence} is still converging (${marker.phase}). Run installer repair; MKT Browser will stay closed to prevent a mixed-version profile launch.`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "Compatibility activation state is damaged. Run installer repair; MKT Browser will stay closed to prevent a mixed-version profile launch.";
  }
}
