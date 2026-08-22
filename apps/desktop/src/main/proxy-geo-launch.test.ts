import assert from "node:assert/strict";
import test from "node:test";
import { resolveProxyGeoLaunch, verifyProxyGeoLaunch } from "./proxyGeoLaunch.ts";

test("H36: a failed proxy egress probe blocks a proxied launch", () => {
  assert.throws(
    () => resolveProxyGeoLaunch({ timezone: "Europe/Paris" }, null),
    /proxy egress could not be verified/i,
  );
});

test("H36: an empty or malformed proxy egress IP blocks a proxied launch", () => {
  for (const ip of ["", "not-an-ip", "203.0.113.10 extra"]) {
    assert.throws(
      () =>
        resolveProxyGeoLaunch(
          { timezone: "Europe/Paris" },
          {
            country: "fr",
            countryName: "France",
            timezone: "Europe/Paris",
            city: "Paris",
            ip,
          },
        ),
      /proxy egress could not be verified/i,
    );
  }
});

test("H36: the launch preflight maps probe failure to PROXY_REJECTED", async () => {
  await assert.rejects(
    () =>
      verifyProxyGeoLaunch({
        profileId: "profile-1",
        fingerprint: { timezone: "Europe/Paris" },
        probe: async () => {
          throw new Error("provider-specific failure");
        },
        reject: (message, options) =>
          Object.assign(new Error(message, options), { code: "PROXY_REJECTED" }),
      }),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      assert.equal(failure.code, "PROXY_REJECTED");
      assert.match(failure.message ?? "", /could not be verified/i);
      assert.doesNotMatch(failure.message ?? "", /provider-specific/i);
      return true;
    },
  );
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
