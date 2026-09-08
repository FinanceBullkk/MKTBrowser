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
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const builderConfig = readFileSync(
    new URL("../../electron-builder.yml", import.meta.url),
    "utf8",
  );
  const installerBuilderConfig = readFileSync(
    new URL("../../electron-builder-installer.yml", import.meta.url),
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
  const relayManifest = JSON.parse(
    readFileSync(new URL("../../relay-release.json", import.meta.url), "utf8"),
  ) as { version?: number; sizeBytes?: number; sha256?: string; url?: string };
  const relayFetcher = readFileSync(
    new URL("../../scripts/fetch-pinned-relay.cjs", import.meta.url),
    "utf8",
  );
  const releaseWorkflow = readFileSync(
    new URL("../../../../.github/workflows/windows-pipeline.yml", import.meta.url),
    "utf8",
  );
  const releaseCandidateWorkflow = readFileSync(
    new URL("../../../../.github/workflows/release-candidate.yml", import.meta.url),
    "utf8",
  );
  const viteConfig = readFileSync(
    new URL("../../electron.vite.config.ts", import.meta.url),
    "utf8",
  );
  const lockfile = readFileSync(new URL("../../../../yarn.lock", import.meta.url), "utf8");
  const installerIncludeBytes = readFileSync(new URL("../../build/installer.nsh", import.meta.url));
  const installerInclude = installerIncludeBytes.toString("ascii");
  const relayCleanup = readFileSync(
    new URL("../../build/windows-relay-cleanup.ps1", import.meta.url),
    "utf8",
  );

  assert.equal(desktopPackage.productName, PRODUCT_NAME);
  assert.match(desktopPackage.scripts?.build ?? "", /verify-node-version\.cjs/);
  assert.match(desktopPackage.scripts?.build ?? "", /package:windows-directory/);
  assert.equal(
    rootPackage.scripts?.["audit:production"],
    "yarn npm audit --all --recursive --environment production --severity high",
  );
  assert.match(releaseWorkflow, /run: yarn audit:production/);
  assert.doesNotMatch(builderConfig, /^\s+extract-zip:/m);
  assert.match(builderConfig, /^\s+yauzl: "3\.4\.0"$/m);
  assert.doesNotMatch(viteConfig, /"extract-zip"/);
  assert.match(viteConfig, /"yauzl"/);
  assert.doesNotMatch(lockfile, /(^|\n)"extract-zip@npm:/);
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
  assert.match(windowsInstallerPackager, /includeRelay: true/);
  assert.match(desktopPackage.scripts?.["build:win"] ?? "", /package:windows-installer/);
  assert.doesNotMatch(desktopPackage.scripts?.["build:win"] ?? "", /electron-builder/);

  // The installer must not overwrite the directory package a gate result cites by hash.
  assert.match(windowsInstallerPackager, /--config\.directories\.output=release\/installer/);
  assert.equal(Number.isSafeInteger(relayManifest.version), true);
  assert.equal(Number.isSafeInteger(relayManifest.sizeBytes), true);
  assert.equal((relayManifest.sizeBytes ?? 0) > 0, true);
  assert.match(relayManifest.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(relayManifest.url ?? "", new RegExp(`/v${relayManifest.version}$`));
  assert.doesNotMatch(builderConfig, /MKTTool-Relay\.zip/);
  assert.match(installerBuilderConfig, /from: \.relay-payload\/MKTTool-Relay\.zip/);
  assert.match(windowsInstallerPackager, /--config=electron-builder-installer\.yml/);
  assert.match(builderConfig, /include: build\/installer\.nsh/);
  assert.match(relayFetcher, /checksum mismatch/);
  assert.match(relayFetcher, /headers\.Range = `bytes=\$\{start\}-`/);

  // The build machine authenticates with a token scoped to the release route. A session cookie
  // unlocks the whole app including the identity vault, so leaving that path in place invites
  // someone to paste a full-privilege credential into CI.
  assert.match(relayFetcher, /headers\.Authorization = `Bearer \$\{releaseToken\}`/);
  assert.doesNotMatch(relayFetcher, /MKTTOOL_RELEASE_COOKIE/);

  // The fetcher reading the right variable is only half of it. CI shipped a stale
  // `MKTTOOL_RELEASE_COOKIE` env line that nothing read, so the installer job ran with no
  // Authorization header and the pinned Relay download failed closed — a break nobody saw because
  // that job only runs on workflow_dispatch. Pin the name the workflow actually passes.
  assert.match(
    releaseCandidateWorkflow,
    /MKTTOOL_RELEASE_TOKEN: \$\{\{ secrets\.MKTTOOL_RELEASE_TOKEN \}\}/,
  );
  assert.doesNotMatch(releaseCandidateWorkflow, /MKTTOOL_RELEASE_COOKIE/);
  assert.doesNotMatch(releaseWorkflow, /MKTTOOL_RELEASE_COOKIE/);
  assert.match(installerInclude, /windows-install-relay-payload\.ps1/);
  assert.match(installerInclude, /windows-startup-coordination\.ps1/);
  assert.match(installerInclude, /-Mode Takeover/);
  assert.match(installerInclude, /-Mode RemoveBrowser/);
  assert.match(installerInclude, /"Publisher" "Techieslab"/);
  assert.match(installerInclude, /"RelayOwned"/);
  assert.match(installerInclude, /StrCpy \$2 0\s+ClearErrors\s+ReadRegDWORD \$2/);
  assert.match(installerInclude, /\$2 == 1/);
  assert.match(installerInclude, /windows-relay-cleanup\.ps1/);
  assert.match(relayCleanup, /CreateShortcut/);
  assert.match(relayCleanup, /Remove-Item -LiteralPath \$relayExe/);
  assert.doesNotMatch(installerInclude, /nsProcess/);
  assert.doesNotMatch(installerInclude, /Remove-Item[^\r\n]*relay-config\.json/i);
  assert.doesNotMatch(relayCleanup, /Remove-Item[^\r\n]*relay-config\.json/i);
  assert.equal(
    installerIncludeBytes.every((byte) => byte <= 0x7f),
    true,
    "installer.nsh must remain ASCII-only so NSIS never depends on the system ANSI codepage",
  );

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
