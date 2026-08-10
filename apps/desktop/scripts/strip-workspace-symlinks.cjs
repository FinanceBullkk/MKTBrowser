#!/usr/bin/env node
/*
 * Remove the workspace symlink directory before electron-builder packs.
 *
 * Yarn 4 with nodeLinker:node-modules creates symlinks under
 *   apps/desktop/node_modules/@mktbrowser/*
 * pointing to packages/<x>/. electron-builder follows those symlinks
 * and refuses to package "package.json under a path outside the app"
 * with the error:
 *   "packages/<x>/package.json must be under apps/desktop/"
 *
 * Workspace packages are already bundled into out/main/index.js by
 * electron-vite (see NATIVE_EXTERNALS in electron.vite.config.ts;
 * @mktbrowser/* is NOT in that list, so rollup inlines them). The
 * symlinks have served their purpose by the time this script runs.
 *
 * Cross-platform: uses fs.rmSync, no shell tools.
 */

const fs = require("node:fs");
const path = require("node:path");

const target = path.resolve(__dirname, "..", "node_modules", "@mktbrowser");

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[strip-workspace-symlinks] removed ${target}`);
} else {
  console.log("[strip-workspace-symlinks] nothing to remove");
}
