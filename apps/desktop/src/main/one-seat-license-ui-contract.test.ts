import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("./", import.meta.url);
const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, ROOT), "utf8").replace(/\r\n/g, "\n");

test("keeps additional licence controls fail-closed until vendor entitlement is verified", () => {
  const component = source("../renderer/src/components/screens/AdditionalLicenceKeys.tsx");
  const settings = source("../renderer/src/components/screens/Settings.tsx");
  const main = source("index.ts");

  assert.match(component, /additionalKeysEnabled\?: boolean/);
  assert.match(component, /additionalKeysEnabled = false/);
  assert.match(component, /if \(!additionalKeysEnabled\)/);
  assert.match(component, /disabled=\{busy\}/);
  assert.match(component, /Remove this inactive stored key/);
  assert.match(
    component,
    /disabled=\{!additionalKeysEnabled \|\| busy \|\| draft\.trim\(\)\.length === 0\}/,
  );
  assert.match(component, /Stored additional keys are preserved but inactive/);
  assert.match(component, /Nothing is deleted/);
  assert.doesNotMatch(component, /Hold more keys to open more at once/);
  assert.doesNotMatch(component, /up to.*profiles? open at once/i);
  assert.match(settings, /additionalKeysEnabled=\{false\}/);
  assert.match(
    settings,
    /settings\.cloakBrowserLicenseKey \|\| settings\.cloakBrowserLicenseKeys\.length > 0/,
  );
  assert.match(main, /const ADDITIONAL_LICENSE_KEYS_ENABLED = false/);
  assert.match(main, /function resolvePrimaryLicenseKey/);
  assert.match(main, /cloakBrowserLicenseKeys\[0\]/);
  assert.match(main, /const licensePoolKeys = ADDITIONAL_LICENSE_KEYS_ENABLED/);
  assert.match(main, /resolvePrimaryLicenseKey\(cachedSettings\)/);
  assert.match(main, /keys: licensePoolKeys/);
  assert.doesNotMatch(main, /keys: cachedSettings\.cloakBrowserLicenseKeys/);
});

test("keeps the primary-key replacement path separate from additional-seat entitlement", () => {
  const settings = source("../renderer/src/components/screens/Settings.tsx");

  // Replacing the primary still preserves unrelated stored keys. The one-seat UI must not solve
  // the entitlement problem by silently dropping those keys.
  assert.match(settings, /const kept = \(settings\?\.cloakBrowserLicenseKeys \?\? \[\]\)/);
  assert.match(settings, /cloakBrowserLicenseKeys: trimmed \? \[trimmed, \.\.\.kept\] : kept/);
  assert.match(settings, /additionalKeysEnabled=\{false\}/);
});
