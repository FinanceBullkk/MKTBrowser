const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const preflightPath = path.resolve(__dirname, "assert-tokenless-windows-packaging.cjs");
const packageJsonPath = path.resolve(__dirname, "..", "package.json");

test("rejects direct Windows packaging with a release token without printing it", () => {
  const token = "test-release-token-not-for-output";
  const result = spawnSync(process.execPath, [preflightPath], {
    encoding: "utf8",
    env: { ...process.env, MKTTOOL_RELEASE_TOKEN: token },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing direct Windows packaging/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
});

test("allows packaging after the wrapper has cleared the release token", () => {
  const result = spawnSync(process.execPath, [preflightPath], {
    encoding: "utf8",
    env: { ...process.env, MKTTOOL_RELEASE_TOKEN: "" },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("Windows build and package entries run the tokenless preflight before work", () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  for (const scriptName of [
    "build",
    "package:windows-directory",
    "package:windows-installer",
  ]) {
    const script = packageJson.scripts[scriptName];
    const preflight = script.indexOf("node ./scripts/assert-tokenless-windows-packaging.cjs");
    assert.ok(preflight >= 0, `${scriptName} can start packaging with a release token`);
    const applicationBuild = script.indexOf("electron-vite build");
    assert.ok(
      applicationBuild < 0 || preflight < applicationBuild,
      `${scriptName} starts the application build before rejecting a release token`,
    );
  }
  assert.equal(packageJson.scripts["build:win"], "yarn package:windows-installer");
  assert.ok(packageJson.scripts["package:windows-installer"].includes("node ./scripts/assert-tokenless-windows-packaging.cjs"));
});

test("a direct build:win call rejects the token before Node-version or Electron work", { skip: process.platform !== "win32" }, () => {
  const token = "test-release-token-not-for-output";
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/v:off", "/c", "corepack.cmd yarn workspace @mktbrowser/desktop build:win"],
    {
      cwd: path.resolve(__dirname, "..", "..", ".."),
      encoding: "utf8",
      env: { ...process.env, MKTTOOL_RELEASE_TOKEN: token },
      windowsHide: true,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /Refusing direct Windows packaging/);
  assert.doesNotMatch(output, /MKT Browser builds require Node\.js 22/);
  assert.equal(output.includes(token), false, "direct packaging printed the release token");
});
