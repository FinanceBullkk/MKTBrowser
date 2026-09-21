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
    if (capacity.retryAt !== undefined && (
      typeof capacity.retryAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capacity.retryAt) ||
      !Number.isFinite(Date.parse(capacity.retryAt)) ||
      new Date(capacity.retryAt).toISOString() !== capacity.retryAt ||
      capacity.free !== 0 || Number(capacity.cooling) === 0
    )) return null;
    return {
      total: Number(capacity.total),
      free: Number(capacity.free),
      active: Number(capacity.active),
      pendingRecovery: Number(capacity.pendingRecovery),
      cooling: Number(capacity.cooling),
      ...(capacity.retryAt === undefined ? {} : { retryAt: capacity.retryAt }),
    };
  } catch {
    return null;
  }
}
