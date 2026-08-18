import assert from "node:assert/strict";
import test from "node:test";
import { resolveProxyGeoLaunch } from "./proxyGeoLaunch.ts";

test("H36: a failed proxy geo probe keeps the configured timezone and blocks WebRTC", () => {
  const decision = resolveProxyGeoLaunch({ timezone: "Europe/Paris" }, null);

  assert.equal(decision.status, "unavailable");
  assert.equal(decision.webrtcSpoofIp, null);
  assert.equal(decision.geoCoords, null);
  assert.equal(decision.fingerprint.timezone, "Europe/Paris");
  assert.equal(decision.diagnosticCode, "PROXY_GEO_UNAVAILABLE");
});

test("H36: a successful proxy geo probe supplies the egress identity", () => {
  const decision = resolveProxyGeoLaunch(
    { timezone: "Europe/Paris" },
    {
      country: "fr",
      countryName: "France",
      timezone: "Europe/Paris",
      city: "Paris",
      ip: "203.0.113.10",
      latitude: 48.8566,
      longitude: 2.3522,
    },
  );

  assert.equal(decision.status, "resolved");
  assert.equal(decision.webrtcSpoofIp, "203.0.113.10");
  assert.deepEqual(decision.geoCoords, { latitude: 48.8566, longitude: 2.3522 });
  assert.equal(decision.diagnosticCode, undefined);
});
