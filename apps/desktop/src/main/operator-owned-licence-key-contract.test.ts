/**
 * The product is bring-your-own-key: it ships no licence key, and each operator registers their
 * own with the vendor. The failure this guards against is not a crash but a misunderstanding —
 * one key passed around a team shares that key's one-browser-at-a-time limit, and the refusal
 * that follows is indistinguishable from a crash (exit 76). These assertions keep the app saying
 * so, and keep the registration link unsteerable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CLOAKBROWSER_FREE_KEY_URL } from "../shared/cloakbrowser-signup-url.ts";

const ROOT = new URL("./", import.meta.url);
const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, ROOT), "utf8").replace(/\r\n/g, "\n");

test("ships no licence key: the stored default is empty", () => {
  const store = readFileSync(
    new URL("../../../../packages/settings-store/src/index.ts", ROOT),
    "utf8",
  );
  assert.match(store, /cloakBrowserLicenseKey: ""/);
  assert.match(store, /cloakBrowserLicenseKeys: \[\]/);
});

test("the registration URL is a constant, not an environment-steerable one", () => {
  // Comments stripped: the prose explains what the code must not do, and would match itself.
  const code = source("../shared/cloakbrowser-signup-url.ts").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.equal(CLOAKBROWSER_FREE_KEY_URL, "https://cloakbrowser.dev/free");
  // A base that tests and self-hosting may override must never reach the operating system's
  // browser: retargeting a download is a smaller problem than retargeting where a person types
  // their credentials.
  assert.doesNotMatch(code, /process\.env/);
  assert.doesNotMatch(code, /CLOAKBROWSER_DOWNLOAD_BASE/);
});

test("the renderer cannot choose where the signup link goes", () => {
  const preload = readFileSync(new URL("../preload/create-mkt-browser-api.ts", ROOT), "utf8");
  const main = source("index.ts");

  // No argument crosses the bridge, so no in-page value can steer the destination.
  assert.match(
    preload,
    /openLicenceSignup: \(\): Promise<void> =>\s*bridge\.invoke\(\s*IPC\.SYSTEM_OPEN_LICENCE_SIGNUP,?\s*\)/,
  );
  assert.match(main, /shell\.openExternal\(CLOAKBROWSER_FREE_KEY_URL\)/);
  assert.doesNotMatch(main, /shell\.openExternal\((?!CLOAKBROWSER_FREE_KEY_URL)/);
});

test("Settings tells the operator the key is theirs to register", () => {
  const settings = source("../renderer/src/components/screens/Settings.tsx");

  assert.match(settings, /This install carries no key until you add one/);
  assert.match(settings, /register\s*\n?\s*your own with CloakBrowser/);
  assert.match(settings, /shared\s*\n?\s*key shares its one-browser-at-a-time limit/);
  assert.match(settings, /openLicenceSignup\(\)/);
});
