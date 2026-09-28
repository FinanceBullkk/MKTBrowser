import { request } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxyConfig } from "@mktbrowser/types";

/**
 * Result of probing a proxy for its public IP geolocation.
 *
 * Used to verify that a profile's locale + timezone are coherent with the
 * proxy IP's country — detection vendors flag mismatches like
 * "Accept-Language: ru-RU + IP in US".
 */
export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
  /** Egress IP coordinates — fed into CloakBrowser's --fingerprint-location
   *  so navigator.geolocation reports the proxy's geo, matching the IP. */
  latitude?: number;
  longitude?: number;
}

/**
 * Probe https://ipapi.co/json/ through the supplied proxy. Uses Node's
 * built-in `https.request` with `https-proxy-agent` / `socks-proxy-agent`
 * (Electron's bundled Node lacks the latest undici APIs).
 */
export async function probeProxyGeo(
  proxy: ProxyConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ProxyGeoResult> {
  const proxyUrl = buildProxyUrl(proxy);
  const agent =
    proxy.type === "socks5" ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);

  const json = await new Promise<RawIpapi>((resolve, reject) => {
    const req = request(
      "https://ipapi.co/json/",
      {
        agent,
        method: "GET",
        headers: {
          "user-agent": "MKTBrowser/0.3.28 (proxy-geo-probe)",
          accept: "application/json",
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`ipapi.co returned HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawIpapi;
            resolve(parsed);
          } catch (e) {
            reject(new Error(`ipapi.co returned invalid JSON: ${(e as Error).message}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.setTimeout(opts.timeoutMs ?? 10000, () => {
      req.destroy(new Error("proxy probe timed out"));
    });
    req.on("error", reject);
    req.end();
  });

  if (!json.country_code || !json.timezone) {
    if (json.error) {
      throw new Error(`ipapi.co error: ${json.reason ?? "rate-limit or block"}`);
    }
    throw new Error("ipapi.co returned an unexpected payload");
  }

  return {
    country: json.country_code.toLowerCase(),
    countryName: json.country_name ?? json.country_code,
    timezone: json.timezone,
    city: json.city ?? "",
    ip: json.ip ?? "",
    latitude: typeof json.latitude === "number" ? json.latitude : undefined,
    longitude: typeof json.longitude === "number" ? json.longitude : undefined,
  };
}

interface RawIpapi {
  ip: string;
  city: string;
  country_code: string;
  country_name: string;
  timezone: string;
  latitude?: number;
  longitude?: number;
  error?: boolean;
  reason?: string;
}

function buildProxyUrl(p: ProxyConfig): string {
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : p.username
        ? `${encodeURIComponent(p.username)}@`
        : "";
  const scheme = p.type === "socks5" ? "socks5" : "http";
  return `${scheme}://${auth}${p.host}:${p.port}`;
}
