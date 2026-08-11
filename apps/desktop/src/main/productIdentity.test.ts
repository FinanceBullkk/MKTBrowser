import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { win32 } from "node:path";
import {
  PRODUCT_APP_ID,
  PRODUCT_EXECUTABLE_NAME,
  PRODUCT_NAME,
  resolveProductUserDataPath,
} from "./productIdentity.ts";

test("defines stable MKT Browser product identifiers", () => {
  assert.equal(PRODUCT_NAME, "MKT Browser");
  assert.equal(PRODUCT_APP_ID, "com.mkttool.browser");
  assert.equal(PRODUCT_EXECUTABLE_NAME, "MKTBrowser");
});

test("keeps desktop packaging metadata aligned with the product identity", () => {
  const desktopPackage = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { productName?: string; scripts?: Record<string, string> };
  const builderConfig = readFileSync(
    new URL("../../electron-builder.yml", import.meta.url),
    "utf8",
  );
  const windowsResourceHook = readFileSync(
    new URL("../../scripts/edit-windows-executable.cjs", import.meta.url),
    "utf8",
  );
  const devPlistPatch = readFileSync(
    new URL("../../scripts/patch-electron-info-plist.cjs", import.meta.url),
    "utf8",
  );
  const windowsDirectoryPackager = readFileSync(
    new URL("../../scripts/package-windows-directory.cjs", import.meta.url),
    "utf8",
  );

  assert.equal(desktopPackage.productName, PRODUCT_NAME);
  assert.match(desktopPackage.scripts?.build ?? "", /verify-node-version\.cjs/);
  assert.match(desktopPackage.scripts?.build ?? "", /package:windows-directory/);
  assert.match(builderConfig, /^appId: com\.mkttool\.browser$/m);
  assert.match(builderConfig, /^productName: MKT Browser$/m);
  assert.match(builderConfig, /^executableName: MKTBrowser$/m);
  assert.match(builderConfig, /^afterPack: scripts\/edit-windows-executable\.cjs$/m);
  assert.match(windowsResourceHook, /const PRODUCT_NAME = "MKT Browser";/);
  assert.match(windowsResourceHook, /const EXECUTABLE_NAME = "MKTBrowser\.exe";/);
  assert.match(devPlistPatch, /const APP_NAME = "MKT Browser";/);
  assert.match(devPlistPatch, /const APP_ID = "com\.mkttool\.browser\.dev";/);
  assert.match(windowsDirectoryPackager, /onlyModules: \["better-sqlite3"\]/);
  assert.match(windowsDirectoryPackager, /--config\.electronDist=/);
  assert.match(windowsDirectoryPackager, /assertSupportedNodeVersion\(\)/);
  assert.match(windowsDirectoryPackager, /renameSync\(workspaceLinksPath, backup\)/);
  assert.match(windowsDirectoryPackager, /renameSync\(backup, workspaceLinksPath\)/);
  assert.match(windowsDirectoryPackager, /finally \{/);
  assert.match(windowsDirectoryPackager, /writeFileSync\(file, contents\)/);
});

test("uses the fixed Windows LocalAppData product root", () => {
  const localAppData = "C:\\Users\\operator\\AppData\\Local";
  assert.equal(
    resolveProductUserDataPath({
      platform: "win32",
      appData: "C:\\Users\\operator\\AppData\\Roaming",
      localAppData,
    }),
    win32.join(localAppData, "MKTTool", "MKTBrowser"),
  );
});

test("fails closed when Windows LocalAppData is unavailable", () => {
  assert.throws(
    () =>
      resolveProductUserDataPath({
        platform: "win32",
        appData: "C:\\Users\\operator\\AppData\\Roaming",
      }),
    /LOCALAPPDATA is required/,
  );
});
