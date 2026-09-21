import type {
  MktBrowserLicenseAvailability,
  MktBrowserLicenseCapacity,
} from "@mktbrowser/types";

export type RuntimeLicenseCapacityProvider = () => unknown | Promise<unknown>;

const LICENSE_AVAILABILITY = new Set<MktBrowserLicenseAvailability>([
  "ready",
  "checking",
  "in-use",
  "cooling",
  "recovering",
  "unable-to-verify",
]);

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
      !isCanonicalTimestamp(capacity.retryAt) ||
      capacity.free !== 0 || Number(capacity.cooling) === 0
    )) return null;

    const hasAvailability = capacity.availability !== undefined;
    const hasReason = capacity.reason !== undefined;
    if (hasAvailability !== hasReason) return null;
    if (hasAvailability && (
      typeof capacity.availability !== "string" ||
      !LICENSE_AVAILABILITY.has(capacity.availability as MktBrowserLicenseAvailability) ||
      typeof capacity.reason !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(capacity.reason)
    )) return null;

    const hasObservedAt = capacity.observedAt !== undefined;
    const hasFreshUntil = capacity.freshUntil !== undefined;
    if (hasObservedAt !== hasFreshUntil) return null;
    if (hasObservedAt && (
      typeof capacity.observedAt !== "string" ||
      typeof capacity.freshUntil !== "string" ||
      !isCanonicalTimestamp(capacity.observedAt) ||
      !isCanonicalTimestamp(capacity.freshUntil) ||
      Date.parse(capacity.freshUntil) < Date.parse(capacity.observedAt)
    )) return null;

    const hasVendorActive = capacity.vendorActive !== undefined;
    const hasVendorLimit = capacity.vendorLimit !== undefined;
    if (hasVendorActive !== hasVendorLimit) return null;
    if (hasVendorActive && (
      !hasObservedAt ||
      !Number.isSafeInteger(capacity.vendorActive) ||
      Number(capacity.vendorActive) < 0 ||
      !Number.isSafeInteger(capacity.vendorLimit) ||
      Number(capacity.vendorLimit) < 1 ||
      Number(capacity.vendorActive) > Number(capacity.vendorLimit)
    )) return null;

    return {
      total: Number(capacity.total),
      free: Number(capacity.free),
      active: Number(capacity.active),
      pendingRecovery: Number(capacity.pendingRecovery),
      cooling: Number(capacity.cooling),
      ...(capacity.retryAt === undefined ? {} : { retryAt: capacity.retryAt }),
      ...(hasAvailability
        ? {
            availability: capacity.availability as MktBrowserLicenseAvailability,
            reason: capacity.reason as string,
          }
        : {}),
      ...(hasObservedAt
        ? {
            observedAt: capacity.observedAt as string,
            freshUntil: capacity.freshUntil as string,
          }
        : {}),
      ...(hasVendorActive
        ? {
            vendorActive: Number(capacity.vendorActive),
            vendorLimit: Number(capacity.vendorLimit),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function isCanonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
