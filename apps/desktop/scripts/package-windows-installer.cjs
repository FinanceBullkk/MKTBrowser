#!/usr/bin/env node

/*
 * Per-user Windows installer (NSIS).
 *
 * Produces the artifact MKB-03 hands to an operator: one file, a per-user install directory, its
 * own uninstaller. It is unsigned by the 12 August 2026 decision, so Windows shows SmartScreen
 * once and the setup journey is required to announce that prompt before it appears.
 *
 * Per-user is the install *location*, not the privilege level: this installer is not UAC-free.
 * The mandatory WebRTC containment rules are machine-wide Windows Firewall rules, so
 * `build/installer.nsh` elevates through `ExecShellWait "runas"` in both `customInstall` and
 * `customUnInstall`, and fails closed if approval is declined. Every install, upgrade and
 * uninstall therefore raises one Administrator prompt, and a standard user needs an
 * administrator's credentials to get past it. An earlier version of this comment claimed "no UAC",
 * which described the NSIS target rather than what the installer actually does.
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
  builderArgs: [
    "--win",
    "--config=electron-builder-installer.yml",
    "--config.directories.output=release/installer",
  ],
  includeRelay: true,
  label: "package-windows-installer",
});
