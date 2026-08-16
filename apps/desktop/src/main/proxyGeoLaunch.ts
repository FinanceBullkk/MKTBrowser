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

/**
 * Convert an optional proxy-geo result into launch inputs. A probe outage must
 * never produce a direct WebRTC path: the caller uses a null IP to select the
 * blocking WebRTC script instead.
 */
export function resolveProxyGeoLaunch<T extends { timezone: string }>(
  fingerprint: T,
  geo: ProxyGeoResult | null,
): ProxyGeoLaunchDecision<T> {
  if (!geo) {
    return {
      status: "unavailable",
      fingerprint,
      webrtcSpoofIp: null,
      geoCoords: null,
      diagnosticCode: "PROXY_GEO_UNAVAILABLE",
    };
  }

  return {
    status: "resolved",
    fingerprint:
      geo.timezone && geo.timezone !== fingerprint.timezone
        ? { ...fingerprint, timezone: geo.timezone }
        : fingerprint,
    webrtcSpoofIp: geo.ip || null,
    geoCoords:
      typeof geo.latitude === "number" && typeof geo.longitude === "number"
        ? { latitude: geo.latitude, longitude: geo.longitude }
        : null,
  };
}
