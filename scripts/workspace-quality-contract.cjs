const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs"]);
const IGNORED_DIRECTORIES = new Set(["dist", "node_modules", "out", "release"]);

function workspaceDirectories(repoRoot) {
  const rootPackage = readPackage(path.join(repoRoot, "package.json"));
  const patterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  const directories = [];
  for (const pattern of patterns) {
    const match = /^(.+)\/\*$/.exec(pattern);
    if (!match) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = path.join(repoRoot, match[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(parent, entry.name, "package.json"))) {
        directories.push(path.join(parent, entry.name));
      }
    }
  }
  return directories.sort();
}

function sourceFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path.join(current, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(current, entry.name));
    }
  }
  return files;
}

function inspectWorkspaceQuality(repoRoot) {
  const problems = [];
  for (const directory of workspaceDirectories(repoRoot)) {
    const manifest = readPackage(path.join(directory, "package.json"));
    const scripts = manifest.scripts ?? {};
    const files = sourceFiles(directory);
    if (files.length > 0 && typeof scripts.lint !== "string") {
      problems.push(`${manifest.name ?? directory} has source files but no lint script.`);
    }
    if (files.some((file) => /\.test\.[cm]?[jt]sx?$/.test(file))) {
      const hasTest = Object.keys(scripts).some((name) => name === "test" || name.startsWith("test:"));
      if (!hasTest) problems.push(`${manifest.name ?? directory} has tests but no test script.`);
    }
  }
  return problems;
}

function assertWorkspaceQualityContract(repoRoot) {
  const problems = inspectWorkspaceQuality(repoRoot);
  if (problems.length > 0) throw new Error(`Workspace quality contract failed:\n- ${problems.join("\n- ")}`);
}

function readPackage(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

if (require.main === module) {
  assertWorkspaceQualityContract(path.resolve(__dirname, ".."));
  process.stdout.write("Workspace quality contract passed.\n");
}

module.exports = { assertWorkspaceQualityContract, inspectWorkspaceQuality };
