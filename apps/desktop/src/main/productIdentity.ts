import { isAbsolute, join, win32 } from "node:path";

export const PRODUCT_NAME = "MKT Browser";
export const PRODUCT_APP_ID = "com.mkttool.browser";
export const PRODUCT_EXECUTABLE_NAME = "MKTBrowser";

interface ProductUserDataOptions {
  platform: NodeJS.Platform;
  appData: string;
  localAppData?: string;
}

/**
 * Resolve the product-owned data root without deriving it from Electron's
 * display name. Windows uses LocalAppData because profiles and engines are
 * machine-local and can be large; other platforms use Electron's appData
 * base until their native W01 verification is completed.
 */
export function resolveProductUserDataPath(options: ProductUserDataOptions): string {
  const isWindows = options.platform === "win32";
  const base = isWindows ? options.localAppData?.trim() : options.appData.trim();

  if (!base) {
    throw new Error(
      options.platform === "win32"
        ? "LOCALAPPDATA is required to resolve the MKT Browser data directory."
        : "The operating-system application data directory is unavailable.",
    );
  }
  if (!(isWindows ? win32.isAbsolute(base) : isAbsolute(base))) {
    throw new Error("The operating-system application data directory must be absolute.");
  }

  return isWindows
    ? win32.join(base, "MKTTool", "MKTBrowser")
    : join(base, "MKTTool", "MKTBrowser");
}
