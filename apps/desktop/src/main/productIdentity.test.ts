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
  const windowsPackagePipeline = readFileSync(
    new URL("../../scripts/package-windows.cjs", import.meta.url),
    "utf8",
  );
  const windowsDirectoryPackager = readFileSync(
    new URL("../../scripts/package-windows-directory.cjs", import.meta.url),
    "utf8",
  );
  const windowsInstallerPackager = readFileSync(
    new URL("../../scripts/package-windows-installer.cjs", import.meta.url),
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
  assert.match(windowsPackagePipeline, /onlyModules: \["better-sqlite3"\]/);
  assert.match(windowsPackagePipeline, /--config\.electronDist=/);
  assert.match(windowsPackagePipeline, /assertSupportedNodeVersion\(\)/);
  assert.match(windowsPackagePipeline, /renameSync\(workspaceLinksPath, backup\)/);
  assert.match(windowsPackagePipeline, /renameSync\(backup, workspaceLinksPath\)/);

  // Every Windows artifact must go through the shared pipeline. Calling electron-builder directly
  // skips the Electron-ABI rebuild for better-sqlite3, which produces an application that installs
  // and then dies on its first database call — shipped once on 12 August 2026.
  assert.match(windowsDirectoryPackager, /require\("\.\/package-windows\.cjs"\)/);
  assert.match(windowsDirectoryPackager, /builderArgs: \["--dir"\]/);
  assert.match(windowsInstallerPackager, /require\("\.\/package-windows\.cjs"\)/);
  assert.match(windowsInstallerPackager, /"--win"/);
  assert.match(desktopPackage.scripts?.["build:win"] ?? "", /package:windows-installer/);
  assert.doesNotMatch(desktopPackage.scripts?.["build:win"] ?? "", /electron-builder/);

  // The installer must not overwrite the directory package a gate result cites by hash.
  assert.match(windowsInstallerPackager, /--config\.directories\.output=release\/installer/);

  // Packaging must leave the tree runnable: a run that kept the Electron-ABI binaries in place
  // would break the next `yarn test`, which loads the same modules under Node.
  assert.match(windowsPackagePipeline, /finally \{/);
  assert.match(windowsPackagePipeline, /writeFileSync\(file, contents\)/);
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
