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

test("sandboxes the renderer and applies a restrictive CSP", () => {
  const main = source("apps/desktop/src/main/index.ts");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /preload\/index\.cjs/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-navigate/);

  const html = source("apps/desktop/src/renderer/index.html");
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
    assert.ok(html.includes(directive), `CSP is missing ${directive}`);
  }
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
    "delete_profile",
  ]) {
    assert.ok(verifier.includes(`"${tool}"`), `Packaged verifier does not call ${tool}.`);
  }
  assert.doesNotMatch(verifier, /ENGINE_UNAVAILABLE/);
  assert.match(verifier, /INVALID_INPUT/);
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
  assert.match(driver, /MKT_BROWSER_PACKAGED_CONTRACT_VERIFY === "1"/);
  assert.match(driver, /mkt-browser-packaged-contract-/);
  assert.match(driver, /"--disable-gpu", "--disable-software-rasterizer", "--no-sandbox"/);
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
