const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { resolveCorepackInvocation } = require("./package-windows.cjs");

const desktopPackage = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

test("compiles fresh application bundles before every official installer package", () => {
  assert.equal(desktopPackage.scripts["build:win"], "yarn package:windows-installer");
  assert.match(
    desktopPackage.scripts["package:windows-installer"],
    /^node \.\.\/\.\.\/scripts\/verify-node-version\.cjs && electron-vite build && node /,
  );
});

test("quotes the live Windows gate so Yarn does not expand PowerShell environment syntax", () => {
  assert.equal(
    desktopPackage.scripts["test:packaging:windows-machine"],
    `powershell.exe -NoProfile -NonInteractive -Command '$env:MKT_BROWSER_RUN_WINDOWS_MACHINE_INTEGRATION="1"; node --test scripts/windows-installer-ownership-fixtures.test.cjs'`,
  );
});

test("runs bundled Corepack through node.exe on Windows", () => {
  const execPath = "C:\\node22\\node.exe";
  const expectedEntrypoint = path.join(
    path.dirname(execPath),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );

  assert.deepEqual(
    resolveCorepackInvocation({
      platform: "win32",
      execPath,
      pathExists: (candidate) => candidate === expectedEntrypoint,
    }),
    { command: execPath, argsPrefix: [expectedEntrypoint] },
  );
});

test("fails clearly when the Node 22 Corepack entrypoint is missing", () => {
  assert.throws(
    () => resolveCorepackInvocation({
      platform: "win32",
      execPath: "C:\\node22\\node.exe",
      pathExists: () => false,
    }),
    /Bundled Corepack entrypoint not found beside Node\.js/,
  );
});

test("keeps the native Corepack command on non-Windows platforms", () => {
  assert.deepEqual(resolveCorepackInvocation({ platform: "linux" }), {
    command: "corepack",
    argsPrefix: [],
  });
});

test("enables Authenticode signing only when a certificate is configured", () => {
  const { windowsSigningArgs } = require("./package-windows.cjs");
  // Unsigned stays the default: the pinned `signAndEditExecutable: false` protects ordinary
  // non-admin builds from electron-builder's winCodeSign symlink requirement.
  assert.deepEqual(windowsSigningArgs({}), []);
  assert.deepEqual(windowsSigningArgs({ CSC_LINK: "   " }), []);
  // ...but a certificate must actually reach the build, or buying one would change nothing.
  assert.deepEqual(windowsSigningArgs({ CSC_LINK: "cert.pfx" }), ["--config.win.signAndEditExecutable=true"]);
  assert.deepEqual(windowsSigningArgs({ WIN_CSC_LINK: "cert.pfx" }), ["--config.win.signAndEditExecutable=true"]);
});
