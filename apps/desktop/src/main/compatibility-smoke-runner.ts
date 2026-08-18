import type { BrowserDriver, RunningProfileState } from "@mktbrowser/mcp-server";
import type { ProfileManager } from "@mktbrowser/profile-manager";
import type { Profile, ProxyConfig } from "@mktbrowser/types";
import {
  COMPATIBILITY_SMOKE_PROFILE_TAG,
  type CompatibilitySmokeAuthorization,
} from "./compatibility-smoke-authorization.ts";

const COOKIE_URL = "https://example.com/";
const PROXY_CHECK_URL = "https://ipapi.co/json/";

export interface CompatibilitySmokeDependencies {
  profileManager: Pick<ProfileManager, "get" | "list">;
  browserDriver: Pick<
    BrowserDriver,
    "launch" | "close" | "isRunning" | "getRunningProfileState" | "navigate" | "cdpSend"
  >;
  verifyHealth(): Promise<void>;
}

export async function runCompatibilitySmoke(
  authorization: CompatibilitySmokeAuthorization,
  dependencies: CompatibilitySmokeDependencies,
): Promise<void> {
  const { profileManager, browserDriver } = dependencies;
  await dependencies.verifyHealth();

  const listed = profileManager.list().find((profile) => profile.id === authorization.profileId);
  if (!listed) throw new Error("The dedicated compatibility smoke profile was not listed.");
  const profile = profileManager.get(authorization.profileId);
  assertDedicatedSmokeProfile(profile);
  if (browserDriver.isRunning(profile.id)) {
    throw new Error("The dedicated compatibility smoke profile is already running.");
  }

  await browserDriver.launch(profile.id);
  try {
    const running = browserDriver.getRunningProfileState(profile.id);
    assertActiveProxy(running, profile.proxy);
    await verifyCookieRoundTrip(browserDriver, profile.id, authorization.authorizationId);
    await verifyBrowserProxy(browserDriver, profile.id, running.observedProxyIp!);
  } finally {
    await browserDriver.close(profile.id);
  }
}

function assertDedicatedSmokeProfile(profile: Profile | null): asserts profile is Profile & {
  proxy: ProxyConfig;
} {
  if (
    !profile ||
    !profile.managed ||
    profile.deletionPending ||
    !profile.tags.includes(COMPATIBILITY_SMOKE_PROFILE_TAG) ||
    !profile.proxy
  ) {
    throw new Error("A managed, proxied, dedicated compatibility smoke profile is required.");
  }
}

function assertActiveProxy(
  running: RunningProfileState | null,
  expected: ProxyConfig,
): asserts running is RunningProfileState & { observedProxyIp: string } {
  if (
    !running ||
    !proxyConfigsEqual(running.proxy, expected) ||
    typeof running.observedProxyIp !== "string" ||
    running.observedProxyIp.length === 0
  ) {
    throw new Error("The compatibility smoke profile did not start with its verified static proxy.");
  }
}

async function verifyCookieRoundTrip(
  driver: CompatibilitySmokeDependencies["browserDriver"],
  profileId: string,
  authorizationId: string,
): Promise<void> {
  const name = "mkt_compatibility_smoke";
  const value = authorizationId.replaceAll("-", "");
  try {
    const setResult = (await driver.cdpSend(profileId, "Network.setCookie", {
      name,
      value,
      url: COOKIE_URL,
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    })) as { success?: boolean };
    if (setResult.success !== true) throw new Error("cookie write was refused");
    const readResult = (await driver.cdpSend(profileId, "Network.getCookies", {
      urls: [COOKIE_URL],
    })) as { cookies?: Array<{ name?: string; value?: string }> };
    if (!readResult.cookies?.some((cookie) => cookie.name === name && cookie.value === value)) {
      throw new Error("cookie read-back did not match");
    }
  } finally {
    await driver.cdpSend(profileId, "Network.deleteCookies", { name, url: COOKIE_URL });
  }
}

async function verifyBrowserProxy(
  driver: CompatibilitySmokeDependencies["browserDriver"],
  profileId: string,
  expectedIp: string,
): Promise<void> {
  await driver.navigate(profileId, PROXY_CHECK_URL);
  const result = (await driver.cdpSend(profileId, "Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const body = result.result?.value;
  if (typeof body !== "string") throw new Error("The Browser proxy probe returned no body.");
  const payload = JSON.parse(body) as { ip?: unknown };
  if (payload.ip !== expectedIp) {
    throw new Error("The Browser egress did not match the configured static proxy.");
  }
}

function proxyConfigsEqual(left: ProxyConfig | undefined, right: ProxyConfig): boolean {
  return (
    left?.type === right.type &&
    left.host === right.host &&
    left.port === right.port &&
    left.username === right.username &&
    left.password === right.password
  );
}
