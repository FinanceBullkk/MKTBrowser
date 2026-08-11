#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { rebuild } = require("@electron/rebuild");
const { assertSupportedNodeVersion } = require("../../../scripts/verify-node-version.cjs");

assertSupportedNodeVersion();

const desktopRoot = path.resolve(__dirname, "..");
const builderConfig = readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
const packageJsonPath = path.join(desktopRoot, "package.json");
const developmentPackageJson = readFileSync(packageJsonPath);
const versionMatch = builderConfig.match(/^electronVersion:\s*([^\s#]+)$/m);
if (!versionMatch) {
  throw new Error("electron-builder.yml must pin electronVersion before native modules are rebuilt.");
}

const repoRoot = path.resolve(desktopRoot, "..", "..");
const localElectronDist = path.join(desktopRoot, "node_modules", "electron", "dist");
const workspaceLinksPath = path.join(desktopRoot, "node_modules", "@mktbrowser");
const nativeBinaries = [
  path.join(desktopRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  path.join(
    repoRoot,
    "packages",
    "profile-manager",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  ),
];
const developmentBinaries = nativeBinaries
  .filter((file) => existsSync(file))
  .map((file) => [file, readFileSync(file)]);

async function main() {
  let workspaceLinksBackup = null;
  try {
    await rebuild({
      buildPath: desktopRoot,
      electronVersion: versionMatch[1],
      force: true,
      onlyModules: ["better-sqlite3"],
    });
    process.stdout.write("Rebuilt better-sqlite3 for packaged Electron.\n");

    const packageJson = JSON.parse(developmentPackageJson.toString("utf8"));
    packageJson.dependencies = Object.fromEntries(
      Object.entries(packageJson.dependencies ?? {}).filter(([name]) => !name.startsWith("@mktbrowser/")),
    );
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

    workspaceLinksBackup = moveWorkspaceLinksOutOfPackageTree();
    const builderArgs = [
      path.join(desktopRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
      "--dir",
    ];
    if (existsSync(localElectronDist)) {
      builderArgs.push(`--config.electronDist=${localElectronDist}`);
    }
    execFileSync(process.execPath, builderArgs, { cwd: desktopRoot, stdio: "inherit" });
  } finally {
    writeFileSync(packageJsonPath, developmentPackageJson);
    try {
      restoreWorkspaceLinks(workspaceLinksBackup);
    } finally {
      // Rebuild may replace hardlinks rather than editing them in place, so restore every workspace
      // copy explicitly. The packaged copy retains the Electron ABI.
      for (const [file, contents] of developmentBinaries) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
      }
    }
  }
}

function moveWorkspaceLinksOutOfPackageTree() {
  if (!existsSync(workspaceLinksPath)) return null;
  const backup = path.join(desktopRoot, `.mktbrowser-workspace-links-${randomUUID()}`);
  renameSync(workspaceLinksPath, backup);
  process.stdout.write(`[package-windows-directory] moved workspace links to ${backup}.\n`);
  return backup;
}

function restoreWorkspaceLinks(backup) {
  if (!backup || !existsSync(backup)) return;
  if (existsSync(workspaceLinksPath)) {
    throw new Error(`Cannot restore workspace links because ${workspaceLinksPath} already exists.`);
  }
  renameSync(backup, workspaceLinksPath);
  process.stdout.write("[package-windows-directory] restored workspace links.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
