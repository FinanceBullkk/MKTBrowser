import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("./", import.meta.url);
const source = (name: string): string => readFileSync(new URL(name, ROOT), "utf8");

test("normalizes Windows engine installs to a stable runtime path", () => {
  const bootstrap = source("ChromiumBootstrap.ts");
  const runtimePath = source("chromium-runtime-path.ts");
  assert.match(bootstrap, /stableWindowsRuntime/);
  assert.match(bootstrap, /\.mkt-runtime\.json/);
  assert.match(runtimePath, /win32\.join\(cacheDir, "runtime", "chrome\.exe"\)/);
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
