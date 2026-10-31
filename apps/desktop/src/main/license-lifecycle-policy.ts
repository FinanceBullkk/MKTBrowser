export const FAST_LICENSE_REUSE_ENV = "MKT_BROWSER_FAST_LICENSE_REUSE";

/** Fast reuse is the default; any unrecognized override fails back to the conservative lifecycle. */
export function fastLicenseReuseEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment[FAST_LICENSE_REUSE_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  if (["1", "true", "on"].includes(value)) return true;
  return false;
}

/**
 * The successful Windows lifecycle kept CloakBrowser attached to its launcher process.
 * Other platforms retain their established detached ownership behavior.
 */
export function shouldDetachBrowserProcess(
  fastReuseEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !(fastReuseEnabled && platform === "win32");
}

/** Only the measured Windows fast-reuse path is allowed to load the vendor SDK lifecycle. */
export function shouldUseCloakBrowserSdkLifecycle(
  fastReuseEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return fastReuseEnabled && platform === "win32";
}
