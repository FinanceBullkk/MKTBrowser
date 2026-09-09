const { execFileSync } = require("node:child_process");
const { readFileSync, realpathSync } = require("node:fs");
const path = require("node:path");
const { NODE_MAJOR, YARN_VERSION, hashFile } = require("./local-release-quality-contract.cjs");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshotRepository(root, lockfile) {
  const directory = realpathSync(root);
  const top = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]));
  if (top !== directory) throw new Error("A quality source path must be a repository root.");
  if (git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Quality execution requires clean committed source in both repositories.");
  }
  git(directory, ["ls-files", "--error-unmatch", lockfile]);
  return {
    directory, commit: git(directory, ["rev-parse", "HEAD"]),
    tree: git(directory, ["rev-parse", "HEAD^{tree}"]),
    lockfile, lockfileSha256: hashFile(path.join(directory, lockfile)),
  };
}

function snapshotSources(repoRoot, sibling) {
  const browser = snapshotRepository(repoRoot, "yarn.lock");
  const mkttool = snapshotRepository(sibling, "package-lock.json");
  if (browser.directory === mkttool.directory) throw new Error("Sibling must be a distinct repository.");
  return { browser, mkttool };
}

function childEnvironment(sibling) {
  const allowed = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME",
  ]);
  const env = {};
  // Only OS paths cross this boundary; release credentials and caller controls stay private.
  for (const [name, value] of Object.entries(process.env)) {
    const normalized = name.toUpperCase();
    if (allowed.has(normalized)) env[normalized] = value;
  }
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  env.MKTTOOL_ROOT = sibling;
  env.COREPACK_ENABLE_PROJECT_SPEC = "1";
  env.COREPACK_ENABLE_NETWORK = "0";
  env.YARN_ENABLE_IMMUTABLE_INSTALLS = "true";
  return env;
}

function inspectToolchain(repoRoot, yarnCli, env) {
  if (Number(process.versions.node.split(".")[0]) !== NODE_MAJOR) {
    throw new Error("Run the quality runner with an explicit Node 22 executable.");
  }
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (manifest.packageManager !== `yarn@${YARN_VERSION}`) throw new Error("Unsupported package-manager pin.");
  const cli = realpathSync(yarnCli);
  const yarnVersion = execFileSync(process.execPath, [cli, "--version"], {
    cwd: repoRoot, env, encoding: "utf8", timeout: 30_000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (yarnVersion !== YARN_VERSION) throw new Error("Yarn executable does not match the repository pin.");
  return {
    nodeVersion: process.versions.node, nodeExecutable: realpathSync(process.execPath),
    nodeSha256: hashFile(process.execPath), yarnVersion, yarnCli: cli, yarnSha256: hashFile(cli),
  };
}

module.exports = { snapshotRepository, snapshotSources, childEnvironment, inspectToolchain };
