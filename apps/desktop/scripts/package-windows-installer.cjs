#!/usr/bin/env node

/*
 * Per-user Windows installer (NSIS).
 *
 * Produces the artifact MKB-03 hands to an operator: one file, no UAC, its own uninstaller. It is
 * unsigned by the 12 August 2026 decision, so Windows shows SmartScreen once and the setup journey
 * is required to announce that prompt before it appears.
 *
 * ## Why the output directory is overridden
 *
 * electron-builder stages an unpacked tree before it compresses the installer. Left at the default
 * it would write `release/win-unpacked/`, overwriting the technical package whose SHA-256 the
 * MKB-02 gate result cites. Nesting under `release/installer/` keeps both artifacts and stays
 * inside the already-ignored `release/` directory.
 *
 * The Electron-ABI rebuild that makes the installed application actually start lives in
 * `package-windows.cjs`; this file only chooses the target.
 */

const { runAsScript } = require("./package-windows.cjs");

runAsScript({
  builderArgs: ["--win", "--config.directories.output=release/installer"],
  label: "package-windows-installer",
});
