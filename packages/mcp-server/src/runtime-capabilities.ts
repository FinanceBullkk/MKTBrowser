import {
  MKT_BROWSER_BASE_CAPABILITIES,
  MKT_BROWSER_CAPABILITIES,
  type MktBrowserCapability,
} from "@mktbrowser/types";

export type RuntimeCapabilityProvider = () =>
  | readonly MktBrowserCapability[]
  | Promise<readonly MktBrowserCapability[]>;

export async function resolveRuntimeCapabilities(
  provider?: RuntimeCapabilityProvider,
): Promise<MktBrowserCapability[]> {
  const capabilities: MktBrowserCapability[] = [...MKT_BROWSER_BASE_CAPABILITIES];
  try {
    const observed = (await provider?.()) ?? [];
    for (const capability of observed) {
      if (
        MKT_BROWSER_CAPABILITIES.includes(capability) &&
        !capabilities.includes(capability)
      ) {
        capabilities.push(capability);
      }
    }
  } catch {
    // Runtime-dependent capabilities fail closed without hiding the base runtime report.
  }
  return capabilities;
}
