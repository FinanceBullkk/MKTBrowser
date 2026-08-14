const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const roots = ["apps", "packages", "scripts"];
const ignored = new Set(["dist", "node_modules", "out", "release"]);
const extensions = new Set([".js", ".cjs", ".mjs"]);
const repoRoot = path.resolve(__dirname, "..");
let checked = 0;

for (const root of roots) checkDirectory(path.join(repoRoot, root));
process.stdout.write(`Checked JavaScript syntax in ${checked} files.\n`);

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) checkDirectory(target);
      continue;
    }
    if (!extensions.has(path.extname(entry.name))) continue;
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
    checked += 1;
  }
}
