/**
 * The Chromium switches that keep a profile's name resolution and background
 * chatter on the path its IP implies.
 *
 * These lived inline in ChromiumBrowserDriver and regressed twice from there.
 * 88dad47 found them sitting inside `if (profile.proxy)`, so a profile with no
 * proxy received none of them and resolved through Chromium's built-in DoH —
 * browserscan read six foreign resolvers. c6ff114 then found the telemetry half
 * had gone missing again during an unrelated edit. Both regressions were silent:
 * a launch with the flags and a launch without look identical from the app.
 *
 * Keeping them here makes the property testable as a value rather than as a
 * hopeful reading of a 2,700-line file: the set does not depend on whether the
 * profile has a proxy, and that is what the test asserts.
 */

/**
 * Everything this build wants switched off, in ONE list on purpose.
 *
 * Chromium honours only the LAST `--disable-features` it is handed. A second
 * flag elsewhere in argv does not merge — it replaces, discarding this list
 * with nothing logged. That is why UX toggles (Translate, MediaRouter) share a
 * list with the DNS ones they have nothing to do with.
 */
export const DISABLED_CHROMIUM_FEATURES = [
  "Translate",
  "MediaRouter",
  "DnsOverHttps",
  "DnsOverHttpsUpgrade",
  "EncryptedClientHello",
  "AsyncDns",
  "DnsHttpsSvcb",
  "DnsHttpsSvcbAlpn",
  "NetworkPrediction",
] as const;

/** The single `--disable-features` flag. Never emit a second one. */
export function disableFeaturesArg(): string {
  return `--disable-features=${DISABLED_CHROMIUM_FEATURES.join(",")}`;
}

/**
 * The command-switch half of the same job — the feature toggles above cover
 * what Chromium exposes as features, these cover what it exposes as switches.
 *
 * Takes the proxy state only to state, in the signature, that it changes
 * nothing. A proxied profile resolves at its SOCKS5 egress and an unproxied one
 * at the connection's own resolver; in both cases DoH and the prefetcher would
 * bypass that path, so both get the same treatment.
 */
export function networkPrivacySwitches(
  _hasProxy: boolean,
  options: { allowBackgroundNetworking?: boolean } = {},
): string[] {
  return [
    "--dns-over-https-mode=off",
    "--dns-prefetch-disable",
    "--disable-async-dns",
    "--no-prerender",
    "--no-pings",
    // CloakBrowser sends its vendor session-release request during SDK shutdown. R13 isolated this
    // switch as the cause of delayed seat release, so only that measured lifecycle omits it.
    ...(options.allowBackgroundNetworking ? [] : ["--disable-background-networking"]),
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
  ];
}
