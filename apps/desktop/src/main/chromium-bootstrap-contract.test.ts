import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("./", import.meta.url);
const source = (name: string): string => readFileSync(new URL(name, ROOT), "utf8");

test("normalizes Windows engine installs to a stable runtime path", () => {
  const bootstrap = source("ChromiumBootstrap.ts");
  const safeExtraction = source("safe-archive-extraction.ts");
  const runtimePath = source("chromium-runtime-path.ts");
  assert.match(bootstrap, /stableWindowsRuntime/);
  assert.match(bootstrap, /extractArchiveSafely/);
  assert.doesNotMatch(bootstrap, /from "extract-zip"/);
  assert.match(safeExtraction, /strictFileNames: true/);
  assert.match(safeExtraction, /EntryIntegrityTransform/);
  assert.match(bootstrap, /\.mkt-runtime\.json/);
  assert.match(runtimePath, /win32\.join\(cacheDir, "runtime", "chrome\.exe"\)/);
});

test("packaged engine bootstrap consumes only a compatibility-set pin", () => {
  const bootstrap = source("ChromiumBootstrap.ts");
  const main = source("index.ts");
  const pin = source("compatibility-engine-pin.ts");
  assert.match(bootstrap, /pinnedManifest/);
  assert.match(bootstrap, /no verified compatibility-set engine pin/);
  assert.match(bootstrap, /manifest\.sizeBytes/);
  assert.match(main, /readCompatibilityEnginePin/);
  assert.match(main, /MKT_BROWSER_ALLOW_UNPINNED_ENGINE/);
  assert.match(main, /hasExplicitUserDataDir: app\.commandLine\.hasSwitch\("user-data-dir"\)/);
  assert.match(bootstrap, /removeMismatchedCachedRuntime/);
  assert.match(pin, /MKTTool.*compatibility-updater/);
});

test("packaged verification isolates disposable engine state from the installed compatibility set", () => {
  const verifier = readFileSync(
    new URL("../../../../scripts/verify-packaged-runtime-contract.cjs", ROOT),
    "utf8",
  );
  assert.match(
    verifier,
    /const isolatedLocalAppData = path\.join\(userData, "local-app-data"\)/,
  );
  assert.match(verifier, /LOCALAPPDATA: isolatedLocalAppData/);
  assert.match(verifier, /MKT_BROWSER_ALLOW_UNPINNED_ENGINE:\s*"1"/);
});

test("locks engine selection while a signed compatibility set is active", () => {
  const main = source("index.ts");
  const settings = readFileSync(
    new URL("../renderer/src/components/screens/Settings.tsx", ROOT),
    "utf8",
  );
  const modal = readFileSync(
    new URL("../renderer/src/components/onboarding/ChromiumBootstrapModal.tsx", ROOT),
    "utf8",
  );
  assert.match(main, /activeCompatibilityEnginePin/);
  assert.match(main, /switching engines independently/);
  assert.match(settings, /Locked by compatibility set/);
  assert.match(settings, /disabled=\{Boolean\(info\?\.compatibilityEnginePin\)\}/);
  assert.match(modal, /!enginePinned/);
});

test("switches a failed CloakBrowser bootstrap to CFT through the settings boundary", () => {
  const main = source("index.ts");
  const modal = readFileSync(
    new URL("../renderer/src/components/onboarding/ChromiumBootstrapModal.tsx", ROOT),
    "utf8",
  );
  assert.match(main, /CHROMIUM_SWITCH_TO_CFT/);
  assert.match(main, /settingsStore\.update\(\{ browserEngine: "cft" \}\)/);
  assert.match(main, /switchToCftInFlight/);
  const settings = readFileSync(
    new URL("../../../../packages/settings-store/src/index.ts", ROOT),
    "utf8",
  );
  assert.ok(
    settings.indexOf("writeFileSync") < settings.lastIndexOf("this.cache = next"),
    "Settings must be persisted before the in-memory engine changes.",
  );
  assert.match(modal, /Switch to Chrome for Testing/);
  assert.match(modal, /compatibility fallback/i);
  assert.match(modal, /engine === "cloakbrowser"/);
});

test("renders unknown download totals as an indeterminate connecting state", () => {
  const modal = readFileSync(
    new URL("../renderer/src/components/onboarding/ChromiumBootstrapModal.tsx", ROOT),
    "utf8",
  );
  assert.match(modal, /Connecting\.\.\./);
  assert.match(modal, /status\.attempt/);
  assert.match(modal, /status\.resuming/);
});
