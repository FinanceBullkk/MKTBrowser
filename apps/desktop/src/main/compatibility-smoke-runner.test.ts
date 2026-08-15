import assert from "node:assert/strict";
import test from "node:test";
import type { Profile, ProfileSummary, ProxyConfig } from "@mktbrowser/types";
import { runCompatibilitySmoke } from "./compatibility-smoke-runner.ts";
import type { CompatibilitySmokeAuthorization } from "./compatibility-smoke-authorization.ts";

const proxy: ProxyConfig = { type: "http", host: "proxy.test", port: 8080 };
const profile = {
  id: "profile-smoke",
  name: "Compatibility smoke",
  tags: ["mkttool-compatibility-smoke"],
  proxy,
  managed: true,
  deletionPending: false,
} as Profile;
const authorization: CompatibilitySmokeAuthorization = {
  schemaVersion: 1,
  type: "mkttool.compatibility-smoke-authorization",
  authorizationId: "741d4377-4c55-4fb0-8c41-133aaa15057a",
  sequence: 7,
  manifestDigest: "a".repeat(64),
  profileId: profile.id,
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2026-08-15T00:01:00.000Z",
};

test("runs health, list, open, cookie, proxy, and close in order", async () => {
  const calls: string[] = [];
  const driver = createDriver(calls);
  await runCompatibilitySmoke(authorization, {
    profileManager: {
      list: () => (calls.push("list"), [summary(profile)]),
      get: () => profile,
    },
    browserDriver: driver,
    verifyHealth: async () => void calls.push("health"),
  });
  assert.deepEqual(calls, [
    "health",
    "list",
    "open",
    "cookie:set",
    "cookie:get",
    "cookie:delete",
    "proxy:navigate",
    "proxy:read",
    "close",
  ]);
});

test("refuses an arbitrary managed profile without the dedicated tag", async () => {
  const other = { ...profile, tags: ["mkttool"] };
  await assert.rejects(
    runCompatibilitySmoke(authorization, {
      profileManager: { list: () => [summary(other)], get: () => other },
      browserDriver: createDriver([]),
      verifyHealth: async () => {},
    }),
    /dedicated compatibility smoke profile/,
  );
});

test("closes the profile when cookie or proxy verification fails", async () => {
  const calls: string[] = [];
  const driver = createDriver(calls, { browserIp: "203.0.113.99" });
  await assert.rejects(
    runCompatibilitySmoke(authorization, {
      profileManager: { list: () => [summary(profile)], get: () => profile },
      browserDriver: driver,
      verifyHealth: async () => {},
    }),
    /egress did not match/,
  );
  assert.equal(calls.at(-1), "close");
});

function createDriver(calls: string[], options: { browserIp?: string } = {}) {
  return {
    launch: async () => {
      calls.push("open");
      return { id: profile.id, cdpEndpoint: "http://127.0.0.1:9222", pid: 1, startedAt: "now" };
    },
    close: async () => void calls.push("close"),
    isRunning: () => false,
    getRunningProfileState: () => ({ proxy, observedProxyIp: "203.0.113.10" }),
    navigate: async () => {
      calls.push("proxy:navigate");
      return { url: "https://ipapi.co/json/" };
    },
    cdpSend: async (_profileId: string, method: string) => {
      if (method === "Network.setCookie") {
        calls.push("cookie:set");
        return { success: true };
      }
      if (method === "Network.getCookies") {
        calls.push("cookie:get");
        return { cookies: [{ name: "mkt_compatibility_smoke", value: authorization.authorizationId.replaceAll("-", "") }] };
      }
      if (method === "Network.deleteCookies") {
        calls.push("cookie:delete");
        return {};
      }
      calls.push("proxy:read");
      return { result: { value: JSON.stringify({ ip: options.browserIp ?? "203.0.113.10" }) } };
    },
  };
}

function summary(value: Profile): ProfileSummary {
  return {
    id: value.id,
    name: value.name,
    tags: value.tags,
    proxy: value.proxy,
    isRunning: false,
    managed: value.managed,
    deletionPending: value.deletionPending,
  };
}
