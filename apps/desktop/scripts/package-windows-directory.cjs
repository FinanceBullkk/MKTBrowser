#!/usr/bin/env node

/*
 * Technical Windows directory package.
 *
 * This is the artifact CI verifies and the one `scripts/verify-packaged-runtime-contract.cjs`
 * drives. It is not a release: there is no installer, no shortcuts, and no uninstall entry.
 *
 * Output lands in `release/win-unpacked/` per `electron-builder.yml`. The installer writes to a
 * separate directory so producing one never overwrites the artifact a gate result cites by hash.
 *
 * All the packaging work — and the reason it cannot be a bare electron-builder call — lives in
 * `package-windows.cjs`.
 */

const { runAsScript } = require("./package-windows.cjs");

runAsScript({ builderArgs: ["--dir"], label: "package-windows-directory" });
