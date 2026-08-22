import type { MktBrowserLicenseCapacity } from "@mktbrowser/types";

export type RuntimeLicenseCapacityProvider = () => unknown | Promise<unknown>;

export async function resolveRuntimeLicenseCapacity(
  provider?: RuntimeLicenseCapacityProvider,
): Promise<MktBrowserLicenseCapacity | null> {
  try {
    const value = await provider?.();
    if (!value || typeof value !== "object") return null;
    const capacity = value as Partial<MktBrowserLicenseCapacity>;
    const counts = [
      capacity.total,
      capacity.free,
      capacity.active,
      capacity.pendingRecovery,
      capacity.cooling,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0)) return null;
    if (
      capacity.total !==
      Number(capacity.free) +
        Number(capacity.active) +
        Number(capacity.pendingRecovery) +
        Number(capacity.cooling)
    ) {
      return null;
    }
    return {
      total: Number(capacity.total),
      free: Number(capacity.free),
      active: Number(capacity.active),
      pendingRecovery: Number(capacity.pendingRecovery),
      cooling: Number(capacity.cooling),
    };
  } catch {
    return null;
  }
}
