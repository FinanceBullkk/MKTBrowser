#!/usr/bin/env node

/*
 * Shared Windows packaging pipeline.
 *
 * Every Windows artifact — the technical directory package and the team installer — must run
 * through here.
 *
 * ## Why this exists rather than calling electron-builder directly
 *
 * `better-sqlite3` ships a C++ binding that must match the ABI of whatever runtime loads it, and
 * that runtime is Electron, not Node. `electron-builder.yml` sets `npmRebuild: false`, so
 * electron-builder packages whatever copy is already on disk — which, after a normal `yarn install`,
 * is the Node-ABI build. The result installs cleanly, then dies on its first database call with a
 * startup error dialog and no log.
 *
 * That shipped once: on 12 August 2026 the NSIS installer was produced by invoking
 * `electron-builder --win` directly, and the installed application would not start. The directory
 * package was unaffected because it already went through this rebuild. Both entry points now share
 * it so the two artifacts cannot drift apart again.
 *
 * ## Why the pipeline restores everything afterwards
 *
 * Packaging mutates the working tree: it rewrites `package.json`, moves the workspace symlinks out
 * of the package tree, and replaces the native binaries with Electron-ABI builds. Left in place,
 * that state breaks `yarn test` and `yarn typecheck`, which load the same modules under Node. The
 * `finally` block restores all three, so a packaging run is never a prerequisite for a cleanup step
 * someone has to remember.
 */

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { rebuild } = require("@electron/rebuild");
const { assertSupportedNodeVersion } = require("../../../scripts/verify-node-version.cjs");
const {
  assertWorkspaceQualityContract,
} = require("../../../scripts/workspace-quality-contract.cjs");
const { fetchPinnedRelay } = require("./fetch-pinned-relay.cjs");
const { generateWindowsFirewallCommands } = require("./generate-windows-firewall-commands.cjs");
const {
  emitWindowsCompatibilityEvidence,
} = require("./emit-windows-compatibility-evidence.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const localElectronDist = path.join(desktopRoot, "node_modules", "electron", "dist");
const workspaceLinksPath = path.join(desktopRoot, "node_modules", "@mktbrowser");
const relayPayloadPath = path.join(desktopRoot, ".relay-payload", "MKTTool-Relay.zip");

/**
 * Both copies exist because yarn's workspace layout gives `profile-manager` its own `node_modules`.
 * A rebuild may replace either, so both are captured and restored.
 */
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

function readPinnedElectronVersion() {
  const builderConfig = readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
  const versionMatch = builderConfig.match(/^electronVersion:\s*([^\s#]+)$/m);
  if (!versionMatch) {
    throw new Error("electron-builder.yml must pin electronVersion before native modules are rebuilt.");
  }
  return versionMatch[1];
}

/**
 * Run electron-builder with the Electron-ABI native modules in place, then undo every mutation.
 *
 * @param {object} options
 * @param {string[]} options.builderArgs Target selection passed straight to electron-builder,
 *   for example `["--dir"]` or `["--win"]`.
 * @param {string} options.label Prefix for this run's console output.
 * @param {boolean} [options.includeRelay] Fetch and stage the pinned Relay payload.
 */
async function packageWindows({ builderArgs, label, includeRelay = false }) {
  assertSupportedNodeVersion();
  assertWorkspaceQualityContract(repoRoot);
  runPrepackageQualityGates(label);

  if (includeRelay) {
    generateWindowsFirewallCommands();
    process.stdout.write(`[${label}] generated self-contained WebRTC firewall commands.\n`);
  }

  if (includeRelay) {
    const { manifest, archivePath } = await fetchPinnedRelay();
    copyFileSync(archivePath, relayPayloadPath);
    process.stdout.write(`[${label}] staged verified Relay v${manifest.version}.\n`);
  }

  const electronVersion = readPinnedElectronVersion();
  const developmentPackageJson = readFileSync(packageJsonPath);
  const developmentBinaries = nativeBinaries
    .filter((file) => existsSync(file))
    .map((file) => [file, readFileSync(file)]);

  let workspaceLinksBackup = null;
  try {
    await rebuild({
      buildPath: desktopRoot,
      electronVersion,
      force: true,
      onlyModules: ["better-sqlite3"],
    });
    process.stdout.write(`[${label}] rebuilt better-sqlite3 for Electron ${electronVersion}.\n`);

    // electron-builder refuses to package a package.json that resolves outside apps/desktop, which
    // the @mktbrowser/* workspace dependencies do. electron-vite has already inlined them into
    // out/main/index.js by this point, so the packaged app never needs them.
    const packageJson = JSON.parse(developmentPackageJson.toString("utf8"));
    packageJson.dependencies = Object.fromEntries(
      Object.entries(packageJson.dependencies ?? {}).filter(([name]) => !name.startsWith("@mktbrowser/")),
    );
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

    workspaceLinksBackup = moveWorkspaceLinksOutOfPackageTree(label);

    const args = [
      path.join(desktopRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
      ...builderArgs,
    ];
    if (existsSync(localElectronDist)) {
      args.push(`--config.electronDist=${localElectronDist}`);
    }
    execFileSync(process.execPath, args, { cwd: desktopRoot, stdio: "inherit" });
    if (includeRelay) {
      await emitWindowsCompatibilityEvidence({
        desktopRoot,
        outputDirectory: path.join(desktopRoot, "release", "installer"),
        engineReleasePath: process.env.MKT_BROWSER_ENGINE_RELEASE_FILE,
      });
      process.stdout.write(`[${label}] emitted compatibility artifact hashes and sizes.\n`);
    }
  } finally {
    writeFileSync(packageJsonPath, developmentPackageJson);
    try {
      restoreWorkspaceLinks(workspaceLinksBackup, label);
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

function runPrepackageQualityGates(label) {
  const { command, argsPrefix } = resolveCorepackInvocation();
  for (const script of ["lint", "test:installer"]) {
    process.stdout.write(`[${label}] running ${script} before artifact creation.\n`);
    execFileSync(command, [...argsPrefix, "yarn", script], { cwd: repoRoot, stdio: "inherit" });
  }
}

function resolveCorepackInvocation(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: "corepack", argsPrefix: [] };

  const execPath = options.execPath ?? process.execPath;
  const pathExists = options.pathExists ?? existsSync;
  const corepackEntrypoint = path.join(
    path.dirname(execPath),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );
  if (!pathExists(corepackEntrypoint)) {
    throw new Error(`Bundled Corepack entrypoint not found beside Node.js: ${corepackEntrypoint}`);
  }

  // Node 22 rejects direct spawn of .cmd shims on Windows. Invoke Corepack through node.exe so the
  // prepackage gates use the same pinned runtime without shell parsing.
  return { command: execPath, argsPrefix: [corepackEntrypoint] };
}

function moveWorkspaceLinksOutOfPackageTree(label) {
  if (!existsSync(workspaceLinksPath)) return null;
  const backup = path.join(desktopRoot, `.mktbrowser-workspace-links-${randomUUID()}`);
  renameSync(workspaceLinksPath, backup);
  process.stdout.write(`[${label}] moved workspace links to ${backup}.\n`);
  return backup;
}

function restoreWorkspaceLinks(backup, label) {
  if (!backup || !existsSync(backup)) return;
  if (existsSync(workspaceLinksPath)) {
    throw new Error(`Cannot restore workspace links because ${workspaceLinksPath} already exists.`);
  }
  renameSync(backup, workspaceLinksPath);
  process.stdout.write(`[${label}] restored workspace links.\n`);
}

/** Entry-point helper so each caller stays a few lines long. */
function runAsScript(options) {
  packageWindows(options).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { packageWindows, resolveCorepackInvocation, runAsScript };
