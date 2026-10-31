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
  // The Relay writes the pin from a published compatibility set, so the unpinned refusal must not
  // send the operator to installer repair: a clean-VM run did exactly that, ran repair to
  // completion, and the pin was still absent.
  const unpinnedRefusal = bootstrap.match(
    /"This MKT Browser build has no verified compatibility-set engine pin[^"]*"/,
  );
  assert.ok(unpinnedRefusal, "missing the unpinned-manifest refusal message");
  assert.doesNotMatch(unpinnedRefusal[0], /Run installer repair/);
  assert.match(unpinnedRefusal[0], /verified compatibility activation through the paired Relay/);
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

test("runs the one engine and offers no engine-switch surface", () => {
  const main = source("index.ts");
  const settings = readFileSync(
    new URL("../renderer/src/components/screens/Settings.tsx", ROOT),
    "utf8",
  );
  const modal = readFileSync(
    new URL("../renderer/src/components/onboarding/ChromiumBootstrapModal.tsx", ROOT),
    "utf8",
  );
  const policy = source("../shared/ipc-exposure-policy.ts");
  const preload = source("../preload/create-mkt-browser-api.ts");
  const store = readFileSync(
    new URL("../../../../packages/settings-store/src/index.ts", ROOT),
    "utf8",
  );
  assert.match(main, /activeCompatibilityEnginePin/);
  assert.match(main, /switching engines independently/);
  // CloakBrowser is the only engine: no switch channel may exist and the UI must not offer one.
  assert.doesNotMatch(policy, /switch-to-cft/);
  assert.doesNotMatch(preload, /switchToCft/);
  assert.doesNotMatch(main, /CHROMIUM_SWITCH_TO_CFT/);
  assert.doesNotMatch(settings, /engineOptions/);
  assert.doesNotMatch(modal, /Switch to Chrome for Testing/);
  assert.match(settings, /CloakBrowser is the only engine/);
  // Settings must still be persisted before the in-memory cache is replaced on update.
  assert.ok(
    store.indexOf("writeFileSync") < store.lastIndexOf("this.cache = next"),
    "Settings must be persisted before the in-memory cache changes.",
  );
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

test("redacts signed download URLs from operator-facing bootstrap errors", () => {
  const bootstrap = source("ChromiumBootstrap.ts");
  assert.match(bootstrap, /redactDownloadError/);
  assert.match(bootstrap, /HTTP \$\{status\} fetching \$\{this\.engine\} runtime/);
  assert.match(bootstrap, /redacted download URL/);
  assert.doesNotMatch(bootstrap, /Last error: \$\{lastError\?\.message/);
});

test("bounds engine metadata, archive, range-probe, and Web Store requests", () => {
  const bootstrap = source("ChromiumBootstrap.ts");
  const descriptor = source("resolve-licensed-engine-descriptor.ts");
  const webStore = source("extensions/webstoreDownload.ts");
  const deadlines = source("network-request-deadlines.ts");

  assert.match(bootstrap, /signal: AbortSignal\.timeout\(ENGINE_METADATA_TIMEOUT_MS\)/);
  assert.equal(
    bootstrap.match(/createNetworkRequestDeadlines\(/g)?.length,
    1,
    "the Electron engine transfer must own one header/body deadline controller",
  );
  assert.match(descriptor, /signal: AbortSignal\.timeout\(ENGINE_METADATA_TIMEOUT_MS\)/);
  assert.match(descriptor, /Unable to measure the licensed archive before the request deadline/);
  assert.match(webStore, /createNetworkRequestDeadlines\(/);
  assert.match(webStore, /await rm\(outPath, \{ force: true \}\)/);
  assert.match(bootstrap, /request\.end\(\);\s*\} catch \(error\) \{\s*fail\(/);
  assert.match(webStore, /request\.end\(\);\s*\} catch \(error\) \{\s*fail\(/);
  assert.match(bootstrap, /finalizationStarted\(\)/);
  assert.match(webStore, /finalizationStarted\(\)/);
  assert.match(bootstrap, /stream\.once\("close"/);
  assert.match(webStore, /stream\.once\("close"/);
  assert.match(deadlines, /expire\("response headers", headerTimeoutMs\)/);
  assert.match(deadlines, /expire\("response body activity", bodyIdleTimeoutMs\)/);
  assert.match(deadlines, /expire\("download finalization", finalizationTimeoutMs\)/);
});
