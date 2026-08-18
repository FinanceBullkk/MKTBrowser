import type { ProxyConfig } from "../types";

/** Removing a configured proxy changes where the existing profile identity egresses. */
export function shouldConfirmProxyRemoval(
  existingProxy: ProxyConfig | undefined,
  nextProxyEnabled: boolean,
): boolean {
  return existingProxy !== undefined && !nextProxyEnabled;
}
