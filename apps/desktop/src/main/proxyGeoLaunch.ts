import { isIP } from "node:net";
import type { ProxyGeoResult } from "./proxyGeo.ts";

export type ProxyGeoLaunchStatus = "resolved" | "unavailable";

export interface ProxyGeoLaunchDecision<T extends { timezone: string }> {
  status: ProxyGeoLaunchStatus;
  fingerprint: T;
  webrtcSpoofIp: string | null;
  geoCoords: { latitude: number; longitude: number } | null;
  /** Stable diagnostic code for logs and future UI/telemetry wiring. */
  diagnosticCode?: "PROXY_GEO_UNAVAILABLE";
}

export interface VerifiedProxyGeoLaunch<T extends { timezone: string }> {
  geo: ProxyGeoResult;
  decision: ProxyGeoLaunchDecision<T>;
}

/**
 * Convert a verified proxy egress result into launch inputs. A proxied profile
 * cannot launch when the probe is unavailable because its active route would be
 * unverified even if WebRTC were disabled.
 */
export function resolveProxyGeoLaunch<T extends { timezone: string }>(
  fingerprint: T,
  geo: ProxyGeoResult | null,
): ProxyGeoLaunchDecision<T> {
  if (!geo) throw new Error("The proxy egress could not be verified.");
  const egressIp = geo.ip.trim();
  if (isIP(egressIp) === 0) throw new Error("The proxy egress could not be verified.");

  return {
    status: "resolved",
    fingerprint:
      geo.timezone && geo.timezone !== fingerprint.timezone
        ? { ...fingerprint, timezone: geo.timezone }
        : fingerprint,
    webrtcSpoofIp: egressIp,
    geoCoords:
      typeof geo.latitude === "number" && typeof geo.longitude === "number"
        ? { latitude: geo.latitude, longitude: geo.longitude }
        : null,
  };
}

/** Map all provider/probe details to the stable Browser launch contract. */
export async function verifyProxyGeoLaunch<T extends { timezone: string }>(options: {
  profileId: string;
  fingerprint: T;
  probe: () => Promise<ProxyGeoResult | null>;
  reject: (message: string, options: { cause: unknown }) => Error;
}): Promise<VerifiedProxyGeoLaunch<T>> {
  try {
    const geo = await options.probe();
    if (!geo) throw new Error("The proxy egress could not be verified.");
    return {
      geo,
      decision: resolveProxyGeoLaunch(options.fingerprint, geo),
    };
  } catch (cause) {
    throw options.reject(
      `The proxy egress for profile ${options.profileId} could not be verified; the profile was not launched.`,
      { cause },
    );
  }
}
