import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IPC,
  IPC_EVENTS,
  IPC_EVENT_EXPOSURE,
  IPC_INVOKE_EXPOSURE,
} from "../shared/ipc-exposure-policy.ts";
import {
  MCP_TOOL_EXPOSURE,
  PROFILE_MANAGEMENT_ACCESS_POLICY,
  isMcpToolAllowed,
} from "../../../../packages/mcp-server/src/tool-exposure-policy.ts";
import { applyNavigationHardening, mainWindowOptions } from "./main-window-security.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);

test("uses a supported Electron line consistently", () => {
  const desktop = JSON.parse(source("apps/desktop/package.json")) as {
    devDependencies: Record<string, string>;
  };
  const electron = desktop.devDependencies.electron;
  if (!electron) throw new Error("Desktop package must pin Electron.");
  const major = Number(electron.match(/\d+/)?.[0]);
  assert.ok(major >= 42, `Electron ${electron} is below the MKB-01E supported line.`);

  const builder = source("apps/desktop/electron-builder.yml");
  assert.match(builder, new RegExp(`^electronVersion: ${electron.replace(/^\^/, "")}$`, "m"));
});

test("sandboxes the renderer", () => {
  // Asserts the object Electron is actually handed, not that a string appears in a file. The
  // previous version regex-matched index.ts, which would have passed with the options sitting in
  // dead code or overridden a line later.
  const options = mainWindowOptions({ mainDir: "/app/out/main", iconPath: null });
  const prefs = options.webPreferences;

  assert.ok(prefs, "The main window must declare webPreferences.");
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.match(String(prefs.preload).replaceAll("\\", "/"), /\/preload\/index\.cjs$/);

  // Nothing may re-enable Node in the renderer through a side door.
  assert.equal(prefs.nodeIntegrationInWorker ?? false, false);
  assert.equal(prefs.nodeIntegrationInSubFrames ?? false, false);
  assert.equal(prefs.allowRunningInsecureContent ?? false, false);
  assert.equal(prefs.experimentalFeatures ?? false, false);
});

test("refuses renderer-initiated navigation and window opening", () => {
  // Drives the real hardening function with a recording stub and checks the resulting behavior,
  // rather than matching the source text of the call.
  const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
  let windowOpenHandler: (() => { action: string }) | null = null;

  applyNavigationHardening({
    setWindowOpenHandler(handler: () => { action: string }) {
      windowOpenHandler = handler;
    },
    on(channel: string, listener: (event: { preventDefault: () => void }) => void) {
      listeners.set(channel, listener);
    },
    // The stub only implements the surface applyNavigationHardening touches.
  } as unknown as Parameters<typeof applyNavigationHardening>[0]);

  assert.ok(windowOpenHandler, "A window-open handler must be installed.");
  assert.deepEqual((windowOpenHandler as () => { action: string })(), { action: "deny" });

  const willNavigate = listeners.get("will-navigate");
  assert.ok(willNavigate, "A will-navigate listener must be installed.");
  let prevented = false;
  willNavigate({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true, "will-navigate must be cancelled.");
});

test("applies a restrictive CSP", () => {
  const html = source("apps/desktop/src/renderer/index.html");
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
    assert.ok(html.includes(directive), `CSP is missing ${directive}`);
  }
});

test("constructs exactly one BrowserWindow, through the audited options builder", () => {
  // The structural assertions above describe one window. This is what stops a second window being
  // added later with its own inline, unaudited webPreferences.
  const main = source("apps/desktop/src/main/index.ts");
  assert.equal(
    [...main.matchAll(/new BrowserWindow\(/g)].length,
    1,
    "Only one BrowserWindow may be constructed.",
  );
  assert.match(main, /new BrowserWindow\(mainWindowOptions\(/);
  assert.doesNotMatch(main, /webPreferences:/);
});

test("keeps preload and main IPC channels inside the classified inventory", () => {
  const preload = source("apps/desktop/src/preload/index.ts");
  const main = source("apps/desktop/src/main/index.ts");
  assert.deepEqual(
    uniqueMatches(preload, /invoke\(IPC\.([A-Z0-9_]+)/g).sort(),
    Object.keys(IPC).sort(),
  );
  assert.deepEqual(
    uniqueMatches(preload, /subscribe\(IPC_EVENTS\.([A-Z0-9_]+)/g).sort(),
    Object.keys(IPC_EVENTS).sort(),
  );
  assert.deepEqual(Object.values(IPC).sort(), Object.keys(IPC_INVOKE_EXPOSURE).sort());
  assert.deepEqual(Object.values(IPC_EVENTS).sort(), Object.keys(IPC_EVENT_EXPOSURE).sort());
  assert.equal(
    [...main.matchAll(/ipcMain\.handle\(/g)].length,
    1,
    "Only the guarded IPC wrapper may call ipcMain.handle.",
  );
  assert.equal(
    [...main.matchAll(/webContents\.send\(/g)].length,
    1,
    "Only the guarded event wrapper may call webContents.send.",
  );
});

test("classifies every exposed MCP definition and dispatch case", () => {
  const server = source("packages/mcp-server/src/server.ts");
  const definitions = uniqueMatches(server, /\bname: "([a-z0-9_]+)"/g).filter((name) =>
    Object.hasOwn(MCP_TOOL_EXPOSURE, name),
  );
  const dispatchCases = uniqueMatches(server, /case "([a-z0-9_]+)"/g);
  const classified = Object.keys(MCP_TOOL_EXPOSURE).sort();
  assert.deepEqual(definitions.sort(), classified);
  assert.deepEqual(dispatchCases.sort(), classified);
  assert.match(server, /assertMcpToolInventory/);
  assert.match(server, /isClassifiedMcpTool/);
});

test("binds the discovered Relay token to profile management only", () => {
  const main = source("apps/desktop/src/main/index.ts");
  const server = source("packages/mcp-server/src/server.ts");
  assert.match(main, /PROFILE_MANAGEMENT_ACCESS_POLICY/);
  assert.match(server, /isMcpToolAllowed\(tool\.name, accessPolicy\)/);
  assert.match(server, /!isMcpToolAllowed\(name, accessPolicy\)/);
  for (const tool of ["navigate", "extract", "get_cookies", "set_cookies", "cdp_send"]) {
    assert.equal(isMcpToolAllowed(tool, PROFILE_MANAGEMENT_ACCESS_POLICY), false, tool);
  }
});

test("packaged verification exercises the profile lifecycle", () => {
  const verifier = source("scripts/verify-packaged-runtime-contract.cjs");
  for (const tool of [
    "list_profiles",
    "create_profile",
    "update_profile",
    "launch_profile",
    "close_profile",
  ]) {
    assert.ok(verifier.includes(`"${tool}"`), `Packaged verifier does not call ${tool}.`);
  }
  assert.doesNotMatch(verifier, /callTool(?:Result)?\([^\n]*"delete_profile"/);
  assert.doesNotMatch(verifier, /ENGINE_UNAVAILABLE/);
  assert.match(verifier, /INVALID_INPUT/);
  assert.match(verifier, /PROXY_REJECTED/);
  assert.match(verifier, /isProcessRunning/);
  assert.match(verifier, /stopChild/);
  assert.match(verifier, /MKT_BROWSER_PACKAGED_CONTRACT_VERIFY:\s*"1"/);

  const fixture = source("scripts/system-chrome-engine-fixture.cjs");
  assert.match(fixture, /MKT_BROWSER_SYSTEM_CHROME/);
  assert.match(fixture, /current\.json/);
  assert.match(fixture, /browserEngine:\s*"cft"/);
  assert.match(fixture, /symlink\([^\n]+"junction"\)/);
  assert.match(fixture, /unlink\(fixture\.junctionPath\)/);

  const driver = source("apps/desktop/src/main/ChromiumBrowserDriver.ts");
  assert.doesNotMatch(driver, /proxy IP probe failed[^\n]*\(e as Error\)\.message/);
  assert.match(driver, /MKT_BROWSER_PACKAGED_CONTRACT_VERIFY === "1"/);
  assert.match(driver, /mkt-browser-packaged-contract-/);
  assert.match(driver, /"--disable-gpu", "--disable-software-rasterizer", "--no-sandbox"/);
  assert.match(driver, /if \(profile\.proxy\) \{/);
  assert.doesNotMatch(driver, /profile\.proxy && !packagedContractFixture/);
  assert.match(
    driver,
    /stableWindowsRuntime\(join\(app\.getPath\("userData"\), "chromium", engine\)\)/,
  );
});

test("fingerprint measurement reports cleanup failures", () => {
  const measurement = source("scripts/measure-mkb01e-packaged-fingerprint.cjs");
  assert.doesNotMatch(measurement, /\.catch\(\(\) => \{\}\)/);
  assert.match(measurement, /Fingerprint cleanup failed/);
  assert.match(measurement, /cleanupErrors/);
});

function uniqueMatches(contents: string, pattern: RegExp): string[] {
  return [...new Set([...contents.matchAll(pattern)].map((match) => match[1]!))];
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}
