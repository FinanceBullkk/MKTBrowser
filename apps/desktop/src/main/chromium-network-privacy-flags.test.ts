import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DISABLED_CHROMIUM_FEATURES,
  disableFeaturesArg,
  networkPrivacySwitches,
} from "./chromium-network-privacy-flags.ts";

const driverSource = readFileSync(new URL("./ChromiumBrowserDriver.ts", import.meta.url), "utf8");

test("a profile with no proxy still gets the DNS switches", () => {
  // The regression 88dad47 fixed. The switches sat inside `if (profile.proxy)`,
  // so an unproxied profile fell through to Chromium's built-in DoH and
  // browserscan read six foreign resolvers where the IP implied one Vietnamese
  // one. Nothing failed and nothing logged; the leak was only visible from
  // outside the machine.
  const unproxied = networkPrivacySwitches(false);

  assert.ok(unproxied.includes("--dns-over-https-mode=off"));
  assert.ok(unproxied.includes("--dns-prefetch-disable"));
  assert.ok(unproxied.includes("--disable-async-dns"));
});

test("proxy state changes nothing about the set", () => {
  // Stated as an equality rather than two lists, so a future switch added for
  // one case only fails here instead of shipping as an asymmetry nobody meant.
  assert.deepEqual(networkPrivacySwitches(false), networkPrivacySwitches(true));
});

test("the telemetry switches travel with the DNS ones", () => {
  // c6ff114's regression: an unrelated edit dropped this half while the DNS
  // half survived, which is why they are one set and not two.
  const switches = networkPrivacySwitches(false);

  for (const flag of [
    "--no-prerender",
    "--no-pings",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
  ]) {
    assert.ok(switches.includes(flag), `${flag} must ship with the DNS switches.`);
  }
});

test("the SDK lifecycle leaves background networking available for prompt vendor release", () => {
  const switches = networkPrivacySwitches(false, { allowBackgroundNetworking: true });

  assert.equal(switches.includes("--disable-background-networking"), false);
  for (const flag of [
    "--dns-over-https-mode=off",
    "--dns-prefetch-disable",
    "--disable-async-dns",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
  ]) {
    assert.ok(switches.includes(flag), `${flag} must remain on the SDK lifecycle.`);
  }
});

test("the feature list carries every DNS bypass Chromium exposes as a feature", () => {
  const arg = disableFeaturesArg();

  assert.ok(arg.startsWith("--disable-features="));
  for (const feature of [
    "DnsOverHttps",
    "DnsOverHttpsUpgrade",
    "EncryptedClientHello",
    "AsyncDns",
    "DnsHttpsSvcb",
    "DnsHttpsSvcbAlpn",
    "NetworkPrediction",
  ]) {
    assert.ok(DISABLED_CHROMIUM_FEATURES.includes(feature as never), `${feature} must be disabled.`);
    assert.ok(arg.includes(feature));
  }
});

test("the driver emits exactly one --disable-features flag", () => {
  // Uniqueness across the file is not a property any single value can carry, so
  // this one reads the source. Chromium keeps only the last such flag it is
  // handed: a second one added anywhere in argv would silently discard the DNS
  // list above, which is precisely how the two-flag bug behaved.
  const occurrences = driverSource.match(/"--disable-features=/g) ?? [];

  assert.equal(
    occurrences.length,
    0,
    "The driver must build the flag through disableFeaturesArg(), not inline.",
  );
  assert.equal(
    (driverSource.match(/disableFeaturesArg\(\)/g) ?? []).length,
    1,
    "Exactly one --disable-features flag may reach argv.",
  );
});

test("the switches are applied on one unconditional path", () => {
  // Also a source read, for the same reason: the bug was about WHERE the call
  // sits, and a second call site would mean one branch got the flags and
  // another did not — the shape of the original leak.
  assert.equal(
    (driverSource.match(/networkPrivacySwitches\(/g) ?? []).length,
    1,
    "One call site only; a branch-specific second one is the leak coming back.",
  );
  assert.match(
    driverSource,
    /allowBackgroundNetworking:\s*useSdkLifecycle/,
    "Only the measured SDK lifecycle may keep background networking available for vendor release.",
  );
});
