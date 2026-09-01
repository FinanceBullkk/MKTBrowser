# MKB-00 source, license, engine, and Windows baseline inventory

> **Historical licensing inventory — superseded for the 30 August 2026 release record.** This
> 11 August source/origin snapshot remains useful background, but it is not the current Browser
> provenance or vendor-channel authority. Current truth is the consolidation plan: 0.3.13/P4b
> provenance is OPEN, P4a Web is independent, and Lane C is **CLOSED** because no CloakBrowser
> channel exists; no vendor request is sent. Do not infer redistribution or identity-isolation
> approval from this retained inventory.

**Last updated:** 11 August 2026
**Status:** Verified on Windows x64; later release and pilot gates remain open
**Scope:** Engineering inventory for an internal product. It is not legal advice.

## Decision summary

The pinned MultiZen application source can be forked under MIT, and the unmodified Windows x64
baseline builds and remains compatible with MKTTool's current `MultizenAdapter`. The default
CloakBrowser engine is not open source merely because its wrapper repository is MIT. Its compiled
binary uses a separate proprietary license that permits controlled internal use but prohibits
redistribution, repackaging, modification, and third-party browser control without a separate
agreement.

MKT Browser may continue as an internal experiment only under all of these constraints:

- Do not bundle or redistribute the CloakBrowser binary in an installer.
- Download an unmodified binary from an official CloakHQ distribution channel and verify its
  published checksum.
- Keep the browsing process under the organization's control; do not expose it as a customer-facing
  browser service or API.
- Recheck the current binary license and subscription terms before every engine approval.
- Keep application, engine, and release-channel approval separate.

On 10 August 2026, the project owner made Windows x64 the only v1 platform and moved Apple Silicon
to MKB-07 after v1. On 11 August the owner stopped active MacBook setup so the Windows technical
demo could remain on the critical path. Mac evidence no longer closes or blocks MKB-00. Later that
day, the disposable Windows correct-proxy positive path passed and completed MKB-00. See
[MKB-W01 Windows product isolation](mkb-w01-windows-product-isolation.md) and
[MKB-W02 Windows internal clean break](mkb-w02-windows-internal-clean-break.md).

## Pinned application source

| Item              | Pinned value                                       | Evidence                                                                                 |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Official upstream | `https://github.com/multizenteam/multizen-browser` | [`upstream`](https://github.com/multizenteam/multizen-browser)                           |
| Tag               | `v0.3.1`                                           | [Official release](https://github.com/multizenteam/multizen-browser/releases/tag/v0.3.1) |
| Commit            | `83c6898b2de3de1122b5fea88008fbbaa4677bff`         | Release commit shown by GitHub and local Git                                             |
| Tree              | `ed96a70b16fca62f9e495bcb97cd36f9e7a5b811`         | Local `git rev-parse HEAD^{tree}`                                                        |
| Commit date       | 26 July 2026                                       | Local Git metadata                                                                       |
| Lockfile          | `yarn.lock`                                        | SHA-256 `f256f994202bcbf5110985847b27d04fb6f4261cbf61b9b835143d27bd9af594`               |
| Package manager   | Yarn `4.5.0`                                       | Root `packageManager` field                                                              |
| Node declaration  | `>=20.0.0`                                         | Root `engines.node` field                                                                |
| Desktop version   | `0.3.1`                                            | `apps/desktop/package.json`                                                              |

The local fork lives at `E:\MKTWorkspace\MKTBrowser`. Its `origin` is the internal
`FinanceBullkk/MKTBrowser` repository. The `upstream` fetch remote remains pinned to MultiZen and
has push URL `NO_PUSH`; `master` tracks `upstream/master` for comparison while `main` contains the
owned W01/W02 work. No commit or push was made during the original MKB-00 baseline run; later W01
and W02 changes were committed and pushed to `origin/main`.

The pinned source tree has one tracked license/notice file: the root `LICENSE`. It remains intact.

## Device inventory

| Platform            | Observed inventory                                                    | Current disposition                               |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| Windows x64         | One Windows x64 host, build `10.0.26200`, tested on 10-11 August 2026 | Sole v1/demo platform; MKB-00 verified             |
| macOS Apple Silicon | No device, chip model, or macOS version was available in this session | Deferred to MKB-07; not an MKB-00 blocker         |
| Intel Mac           | No demonstrated operational need or test device                       | Out of scope                                      |
| Wider Windows fleet | Device count was not supplied                                         | Required before MKB-04, not MKB-00                |

### Current owned Windows artifact — 11 August 2026

The post-W02 directory package was regenerated at
`apps/desktop/release/win-unpacked/MKTBrowser.exe`. It is PE x64, reports product and file
description `MKT Browser`, and has SHA-256
`27c27443385f4ecdbc0187772934adb5d1718169d7c387d41b3718ef72ba2b18`, identical to the verified W02
artifact. W02 guards passed 8/8 and repository typecheck passed after packaging. The executable is
unsigned and remains suitable only for an owner-led technical demo with disposable profiles; this
does not authorize pilot distribution or real-account use.

## Windows build evidence

The source was built without rebranding or source changes.

### Toolchain

| Item                         | Result                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Host Node.js                 | `24.14.1`                                                          |
| Baseline Node.js used        | Official portable Node.js `22.23.1` Windows x64                    |
| Node ZIP SHA-256             | `7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29` |
| Official checksum comparison | Exact match with Node.js `SHASUMS256-v22.23.1.txt`                 |
| Git                          | `2.53.0.windows.3`                                                 |
| Installed Electron package   | `33.4.11` from the `^33.2.0` declaration                           |
| electron-builder             | `25.1.8`                                                           |

`yarn install --immutable` failed under host Node.js 24 because `better-sqlite3@11.10.0` had no
matching prebuilt host binary and this Windows host did not have the Visual Studio C++ workload
needed to compile it. The lockfile was not changed. Running the same immutable install under the
checksum-verified Node.js 22 portable toolchain succeeded. This is a reproducibility/developer
onboarding issue, not a reason to rewrite the lockfile.

### Commands and results

| Command                                       | Result                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `yarn install --immutable` under Node 22.23.1 | Passed; lockfile unchanged                                                   |
| `yarn typecheck`                              | Passed                                                                       |
| `yarn lint`                                   | Exit 0, but effectively a no-op because no workspace defines a `lint` script |
| `yarn build`                                  | Passed; Vite bundles and electron-builder directory package completed        |

The install emitted peer-range warnings for React and Vite. electron-builder emitted unresolved
dependency diagnostics while packaging, but returned exit 0. Runtime verification below was used to
catch material packaging failures rather than treating the build exit code as sufficient evidence.

### Built artifact

| Item            | Result                                                             |
| --------------- | ------------------------------------------------------------------ |
| Path            | `apps/desktop/release/win-unpacked/MultiZen.exe`                   |
| PE architecture | x64                                                                |
| Size            | 188,614,144 bytes                                                  |
| SHA-256         | `f275ab05b5f98fc69dbba57f69bfd5eb090d546a4137e6ebd76058f24020fc0e` |

The unpacked baseline logged a non-fatal updater error because `resources/app-update.yml` was
absent, and the application continued to start. MKB-W01 later removed the updater and its upstream
release target from the Windows development line. A signed internal update path remains
unimplemented and unverified.

## Windows runtime and MCP evidence

The 10 August baseline tests used an explicit Electron `--user-data-dir` pointing to a new temporary
vault, `MULTIZEN_NO_TELEMETRY=1`, no account login, no cookies, and no real proxy credentials.

Changing `APPDATA` and `LOCALAPPDATA` alone did not isolate Electron's application data on this host.
An initial launch therefore opened the pre-existing default MultiZen directory. It was stopped before
any MCP or profile operation. The existing `settings.json`, `mcp-token`, and `profiles.db` timestamps
remained unchanged, and no persistent file written after that launch remained in the directory. All
subsequent runs used `--user-data-dir`; this flag is mandatory for future disposable baseline tests.

### Direct MCP contract

| Check                      | Result                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| Bind address               | `127.0.0.1:7777`                                                      |
| Authentication             | A newly generated 64-byte bearer token was required and never printed |
| Initialize protocol        | `2025-03-26` accepted                                                 |
| Server identity            | `multizen` / `0.2.0-pre`                                              |
| Tool count                 | 22                                                                    |
| `list_profiles`            | Passed; isolated vault initially empty                                |
| `list_fingerprint_options` | Passed; 19 device options and 72 locale options                       |
| `create_profile`           | Passed with a disposable, account-free profile                        |
| `update_profile`           | Passed for name/notes/tags                                            |
| `launch_profile`           | Passed; `isRunning` became `true`                                     |
| `close_profile`            | Passed; `isRunning` became `false`                                    |
| Cleanup                    | Disposable profiles deleted; final isolated profile count was 0       |

An invalid proxy application using an otherwise local test payload with port `0` was rejected by
`update_profile`; the profile remained closed and was deleted. No launch command followed the failed
application.

### Current MKTTool adapter

The same isolated application was then exercised through the actual
`src/lib/antidetect/multizen-adapter.ts` from the MKTTool checkout:

| Adapter operation      | Result                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `listProfiles()`       | Passed; initial count 0                                                                         |
| `fingerprintOptions()` | Passed; 19 devices / 72 locales                                                                 |
| `createProfile()`      | Passed                                                                                          |
| `applyProxy()`         | Passed with `http://127.0.0.1:1`, a closed loopback endpoint that cannot carry external traffic |
| `launchProfile()`      | Passed; running state became `true`                                                             |
| `closeProfile()`       | Passed; running state became `false`                                                            |
| Cleanup                | Profile deleted through MCP; final count 0                                                      |

This proves contract compatibility and call ordering on Windows. It does **not** prove successful
traffic through an operational proxy. The loopback proxy deliberately prevented external traffic.

MKTTool's focused fail-closed tests also passed:

```text
npm test -- relay/src/handle-ticket.test.ts src/lib/antidetect/multizen-adapter.test.ts
Test Files  2 passed (2)
Tests       27 passed (27)
```

Those tests assert that a proxy-application exception does not invoke `launchProfile` and that proxy
passwords are redacted from errors. Together with the real MCP rejection above, this is the current
Windows negative-path evidence. Atomic application-and-launch remains MKB-02 work.

Every disposable profile and app process was closed after testing. The temporary engine cache was
left in the isolated test directory as reproducibility evidence; it contains no account data.

### Correct-proxy positive path — 11 August 2026

MKTTool's `smoke-test-mkt-browser-correct-proxy.ts` ran the current packaged Windows build through a
dedicated working proxy. The proxy was supplied through a fixed local handoff file, parsed only in
memory, and removed before any network request. The script redacted proxy fields, bearer tokens,
database URLs, and all observed IP values.

An independent proxy probe first returned an exit IP distinct from the direct connection. The
isolated MKT Browser instance then created a blank disposable profile, applied the same proxy,
launched it, and obtained an in-browser exit IP matching the independent probe. It closed and
deleted the profile and terminated the isolated application. Final checks found zero disposable
profiles, MKT Browser processes, handoff files, and temporary MKB-00 roots. No account, cookie,
account password, TOTP secret, or operational profile was used.

## Engine supply-chain inventory

### Selection behavior in the pinned source

The default setting is `cloakbrowser`. The bootstrap queries up to 30 official CloakBrowser GitHub
releases and walks newest to oldest for the first asset matching the current platform. This is
important because Windows and macOS releases currently move at different cadences. The optional
`cft` engine reads Google's Chrome for Testing stable manifest.

For CloakBrowser, the bootstrap downloads the official release asset, reads `SHA256SUMS` when
present, hashes the completed archive, rejects a mismatch, extracts to a temporary directory, and
renames atomically. The recorded `current.json.sha256` is the archive checksum, not the checksum of
the extracted executable.

For Chrome for Testing, the pinned implementation states that no canonical published archive hash
is available. It records a local SHA-256 but relies on HTTPS plus a best-effort macOS `codesign`
check. Despite stronger comments earlier in the file, the implementation logs and continues if the
basic signature check fails. CFT is therefore not approved as the operational antidetect engine.

### Observed and candidate artifacts

| Platform        | Engine artifact                    | Version observed/candidate       | SHA-256 / status                                                                                                          |
| --------------- | ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Windows x64     | `cloakbrowser-windows-x64.zip`     | `146.0.7680.177.5`               | Published and locally recorded archive hash `b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe`            |
| macOS arm64     | `cloakbrowser-darwin-arm64.tar.gz` | `145.0.7632.109.2` at audit time | Published archive hash `505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c`; **not downloaded or run here** |
| macOS x64       | `cloakbrowser-darwin-x64.tar.gz`   | `145.0.7632.109.2` at audit time | Available upstream; not required by current device inventory                                                              |
| CFT Mac/Windows | Dynamic Stable asset               | Not pinned                       | Experimental fallback only; not approved for the operational antidetect path                                              |

The Windows engine extracted successfully and its executable is PE x64. The current CloakBrowser
website advertises major version 150 across Windows and macOS, while the public GitHub assets found by
the pinned MultiZen bootstrap are older versions. If any selected version or asset changes, stop and
repeat the checksum, license, architecture, and runtime review rather than silently accepting it.

## License inventory and disposition

| Component                                 | License/source                                                                                                     | Engineering disposition                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MultiZen application source at `v0.3.1`   | MIT, copyright 2023 oboshto                                                                                        | Forking, modifying, and internal distribution are permitted when the copyright and license notice are preserved.                                                                                                                                                          |
| CloakBrowser wrapper repository           | MIT                                                                                                                | Does not grant rights to the compiled Chromium binary. Do not cite this as the engine license.                                                                                                                                                                            |
| CloakBrowser compiled binary              | CloakBrowser Binary License v1.3, July 2026, last license update commit `2e379e402b52838d37e469a40e6195e887e314d1` | Unmodified internal use and internal storage are permitted. Redistribution, repackaging, modification, reverse engineering, third-party control, and bundling are prohibited without a separate agreement. The latest major version requires the applicable subscription. |
| Electron source/runtime                   | MIT; pinned package `33.4.11`                                                                                      | License is compatible, but the version is end-of-life and is a technical/security blocker for MKB-01.                                                                                                                                                                     |
| Chrome for Testing dashboard/tools        | Repository is Apache-2.0; browser binaries include separate Google/open-source terms                               | Do not treat the dashboard repository license as a blanket binary redistribution grant. Keep CFT experimental until a separate binary/legal review is approved.                                                                                                           |
| Transitive JavaScript/native dependencies | Versions pinned in `yarn.lock`; individual package licenses                                                        | Not exhaustively assembled into an SBOM/NOTICE set in this gate. Complete that work before any distributable release.                                                                                                                                                     |

The current CloakBrowser license expressly permits internal operational use of an unmodified binary,
including internal infrastructure and artifact mirrors, while prohibiting external redistribution
and customer-controlled browser services. It also states that merely listing CloakBrowser as a
dependency is not redistribution when users download it from official channels. Version-specific
subscription and acceptable-use requirements still apply.

Official sources reviewed on 10 August 2026:

- [MultiZen v0.3.1 release](https://github.com/multizenteam/multizen-browser/releases/tag/v0.3.1)
- [MultiZen MIT license at v0.3.1](https://github.com/multizenteam/multizen-browser/blob/v0.3.1/LICENSE)
- [CloakBrowser Binary License v1.3](https://github.com/CloakHQ/CloakBrowser/blob/2e379e402b52838d37e469a40e6195e887e314d1/BINARY-LICENSE.md)
- [CloakBrowser v146.0.7680.177.5 Windows release and checksum](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5)
- [CloakBrowser v145.0.7632.109.2 macOS arm64 release and checksum](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v145.0.7632.109.2)
- [Current CloakBrowser plans and platform versions](https://cloakbrowser.dev/)
- [Electron release schedule](https://releases.electronjs.org/schedule)
- [Electron 33.4.11 end-of-support notice](https://releases.electronjs.org/release/v33.4.11)
- [Chrome for Testing official availability repository](https://github.com/GoogleChromeLabs/chrome-for-testing)
- [Chrome for Testing purpose and distribution model](https://developer.chrome.com/blog/chrome-for-testing)

## Platform and release findings

- The official MultiZen `v0.3.1` release is pinned to the same commit used locally. Its release notes
  specifically fix per-runner macOS architecture builds after a native-module mismatch.
- CI has separate Apple Silicon and Intel macOS runners, plus Windows x64 and Linux x64.
- macOS outputs are ad-hoc/unsigned and not notarized. Windows executable signing is disabled.
- The installed Electron package is `33.4.11`. Electron's official schedule lists Electron 33 end of
  life as 29 April 2025. It must be upgraded and retested before pilot distribution.
- The unmodified baseline targeted upstream MultiZen updates. MKB-W01 has since removed that
  updater and heartbeat, assigned an independent application ID/data root, and quarantined release
  publishing on the Windows development line. Signing and an approved release channel remain later
  gates.

## MKB-00 disposition

MKB-00 is complete for the Windows-only v1 scope. The pinned source and license boundaries are
recorded, the Windows engine is conditionally approved for unmodified internal use through its
official download path, and both the fail-closed invalid-proxy path and the positive working-proxy
path have passed with disposable profiles.

The Windows CloakBrowser artifact remains conditionally approved only for unmodified internal use
through its official download path. Recheck the exact version, checksum, license, and subscription
before operational use; that supply-chain check does not put macOS back into MKB-00.

The [Apple Silicon verification runbook](mkb-00-apple-silicon-verification.md) is retained for
MKB-07 and no longer closes MKB-00. Electron upgrade, production signing, independent updates, and a
complete dependency SBOM remain later Windows release gates after MKB-00.
