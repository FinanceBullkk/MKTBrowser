# MKB-W02 Windows internal clean break

**Status:** Implemented and verified on Windows x64 on 10 August 2026.
**Readiness:** Technical-only. Not approved for pilot, team rollout, or distribution.

This record covers only the coordinated W02 slice across `E:\MKTBrowser` and `E:\MKTTool`. The
verified W01 checkpoint remains immutable and is the comparison baseline; this document does not
repeat its product-isolation evidence.

## Frozen inputs and scope

- MKT Browser W01 checkpoint: `ffff909040ee78ba22fd29b49a1a3ec06c1edb1a`.
- MKTTool W01 documentation checkpoint: `14917689f7d24d0e0e3716e0ebdf80b420e4db0c`.
- Upstream application baseline and MIT attribution remain MultiZen `v0.3.1` at
  `83c6898b2de3de1122b5fea88008fbbaa4677bff`.
- Browser engine source, binary, schema, archive format, and licensing were not changed.
- No real account, cookie, production profile, TOTP secret, proxy credential, or operator data was
  used.
- No commit, tag, push, remote creation, publication, or installed MultiZen launch occurred.

## Owned W02 contract

| Surface                   | Contract                                    |
| ------------------------- | ------------------------------------------- |
| Product/provider          | `MKT Browser` / `mkt-browser`               |
| Workspace packages        | `@mktbrowser/*`                             |
| Renderer preload bridge   | `window.mktBrowser`                         |
| MCP server identity       | `mkt-browser`, version `0.3.1`              |
| MCP health identity       | `mkt-browser-mcp`                           |
| Standalone bin            | `mkt-browser-mcp`                           |
| Type and class prefix     | `MktBrowser*`                               |
| Desktop default MCP port  | `47822`                                     |
| Desktop port override     | `MKT_BROWSER_MCP_PORT`                      |
| MKTTool endpoint override | `MKT_BROWSER_MCP_URL`                       |
| Relay endpoint override   | `mktBrowserUrl`                             |
| MKTTool bearer-token key  | `MKT_BROWSER_MCP_TOKEN` / `mktBrowserToken` |

The desktop default port is defined once in `@mktbrowser/types`. MKTTool mirrors the sibling-repo
contract in its consumer contract module because the repositories remain intentionally separate.
Both sides have focused drift tests. Overrides accept only valid loopback origins/ports, and Relay
does not read retired configuration keys as a fallback.

The existing MCP tool names remain unchanged because they describe operations rather than the
upstream product. Profile IDs, the SQLite schema, and archive format also remain unchanged.

## Implementation result

- Renamed active first-party package manifests, imports, workspace links, preload APIs, renderer
  calls, MCP server/bin names, standalone paths, activity IDs, local UI storage, companion markers,
  tests, and development commands.
- Renamed the MKTTool client/adapter files and classes to `mkt-browser-*` / `MktBrowser*` and updated
  Relay configuration, status, forms, ticket handling, examples, and environment keys in the same
  slice.
- Removed endpoint and tool-name probing. The consumer uses `/mcp`, exact tool names, and snake-case
  payload fields. A transport/session failure may re-handshake once; a tool rejection is never
  replayed.
- Removed the retired provider/config fallback. `ANTIDETECT_PROVIDER=multizen` now fails instead of
  silently selecting MKT Browser.
- Removed inert `autoUpdate`, `usageReporting`, and stored MCP-port settings. Runtime port selection
  now comes only from the owned contract and its explicit environment override.
- Removed obsolete release-note and compatibility branches retained by W01. Upstream Git history,
  attribution, and historical evidence remain intact.

## Verification

Baseline verification and final workspace restoration used checksum-verified portable Node.js
`22.23.1`; the reviewer-driven final package rebuild and checks also ran with installed Node.js
`24.14.1`. Both paths used Yarn `4.5.0`.

| Check                               | Result                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| Immutable dependency install        | Passed; lockfile unchanged                                       |
| Node workspace native-module smoke  | Passed with `better-sqlite3` in memory under Node.js 22          |
| W02 identity/contract tests         | Passed, 8/8                                                      |
| Full MKT Browser TypeScript check   | Passed                                                           |
| MKT Browser lint command            | Completed; still a no-op because workspaces define no lint tasks |
| Windows directory build             | Passed                                                           |
| Focused MKTTool adapter/Relay tests | Passed, 10 files and 98 tests                                    |
| Full MKTTool suite                  | Passed, 114 files and 1,120 tests                                |
| MKTTool TypeScript check            | Passed                                                           |
| MKTTool ESLint                      | Passed                                                           |
| MKTTool production build            | Passed                                                           |

Known non-failing warnings were retained:

- Yarn reports existing React and Vite peer-range mismatches.
- electron-builder reports missing desktop `description`/`author` metadata and unresolved dependency
  traversal messages before packaging the already bundled workspace code.
- A post-package install attempt under Node.js 24 could not rebuild the Node-target
  `better-sqlite3`; an interim immutable link-only restore passed, then the full immutable install
  and an in-memory native-module smoke passed under checksum-verified Node.js 22. electron-builder
  had already rebuilt the packaged native module, and the final packaged runtime passed.
- The MKTTool Next.js build reports the existing dynamic `pg_dump` filesystem tracing warning in
  `database-backup.ts`.
- npm printed an available minor-version notice; no toolchain or dependency upgrade was performed.
- Git reports expected LF-to-CRLF working-copy notices on this Windows checkout; `git diff --check`
  still passes in both repositories.

## Packaged application inspection

Artifact: `apps/desktop/release/win-unpacked/MKTBrowser.exe`.

| Property             | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| PE architecture      | x64 (`0x8664`)                                                     |
| Size                 | `188,614,144` bytes                                                |
| SHA-256              | `27c27443385f4ecdbc0187772934adb5d1718169d7c387d41b3718ef72ba2b18` |
| Product name         | `MKT Browser`                                                      |
| File description     | `MKT Browser`                                                      |
| Original filename    | `MKTBrowser.exe`                                                   |
| File/product version | `0.3.1` / `0.3.1`                                                  |
| PE copyright         | blank                                                              |

The executable size is unchanged from W01. Its W01 SHA-256 was
`16462e535593b0ee572bf32069bee514774f6a7be1cda2f8329ff1a1efc60022`; the W02 hash changed as
expected because the packaged first-party contract changed.

The `app.asar` scan included five packaged first-party text assets under `out/main`, `out/preload`,
and `out/renderer`, plus the packaged `package.json` (six assets total). It excluded images and
`node_modules` to avoid third-party false positives. The following exact markers all had zero
findings:

```text
@multizen/
window.multizen
MULTIZEN_MCP_
multizenToken
multizenUrl
127.0.0.1:7777
bin/multizen-mcp
.multizen
mz-
autoUpdate
usageReporting
electron-updater
autoUpdater
getmultizen.com
ping.getmultizen.com
github.com/multizenteam/multizen-browser/releases
--publish
```

The exact `ping.getmultizen.com` marker covers the retired upstream heartbeat endpoint. The generic
word `heartbeat` was intentionally excluded because the packaged emoji dataset legitimately uses it
as an emoji name and keyword.

The same contract/updater/service markers were scanned in active application, package, workflow,
and build configuration sources. Remaining plain `MultiZen` references were reviewed and are
limited to upstream attribution, the explicit legacy-store non-access boundary, frozen W01/MKB-00
records, or negative no-fallback assertions and tests.

## Disposable runtime evidence

The final packaged run used temporary `LOCALAPPDATA` and `APPDATA` roots and no Electron
`--user-data-dir` argument. The harness explicitly removed inherited `ELECTRON_RUN_AS_NODE=1`
before launch and restored it afterward; leaving that verification-host variable set makes an
Electron executable run as Node and exit before application startup.

The harness created `<temporary LocalAppData>\MKTTool\MKTBrowser` only to seed the verified engine
cache; the app populated its isolated data/token files there and served authenticated health
identity `mkt-browser-mcp` on default port `47822`. A disposable listener occupied
`127.0.0.1:7777` for the entire browser lifecycle. No installed MultiZen process was started.

Only the previously verified W01 engine cache was copied into the disposable canonical root. The
test used structurally invalid proxy port `0` for the negative case and closed loopback endpoint
`127.0.0.1:9` for the launch case; it generated no external proxy traffic.

| Operation through the updated MKTTool consumer | Result                              |
| ---------------------------------------------- | ----------------------------------- |
| MCP initialize                                 | Passed                              |
| MCP tools/list                                 | Passed; 22 tools                    |
| List profiles                                  | Passed; initial count 0             |
| Fingerprint options                            | Passed; 19 devices and 72 locales   |
| Create disposable profile                      | Passed                              |
| Apply invalid proxy port `0`                   | Rejected; host/credentials redacted |
| Running state after invalid proxy              | Closed; no launch                   |
| Apply closed-loopback proxy                    | Passed                              |
| Launch profile                                 | Passed; running state observed      |
| Close profile                                  | Passed; closed state observed       |
| Delete profile                                 | Passed                              |
| Final disposable profile count                 | 0                                   |

Before and after the final run, the legacy `%APPDATA%\MultiZen` tree contained 3,497 entries. A
metadata-only snapshot over item kind, relative path, file length, and last-write ticks was identical
before and after. An independent snapshot sorted entries by full path and serialized
`D/F|backslash-relative-path|length|UTC-ticks` with directory length `0`, CRLF delimiters, and no
trailing newline; its SHA-256 was
`a444455c10af589fce761023c6ac7351aec79881aeed5a764f279190740d26bf`. The final harness instead
serialized `directory/file|backslash-relative-path|length|UTC-ticks`, sorted the complete records,
and joined them with LF and no trailing newline; its SHA-256 was
`2b96b6827a547a5fd9c9b964a6f0c47154d8b9adb072ee2cb47c719e901e6f45`. The latest write remained
`2026-08-09T21:14:00.6487430Z`. File contents were not read.

The real `%LOCALAPPDATA%\MKTTool\MKTBrowser` root was absent before and after the test. Cleanup left
no disposable root, MKT Browser/CloakBrowser process, or listener on ports `7777` or `47822`.

## Coverage gap found after this record was written

The verification above covers both repositories' test suites, typechecks, the desktop package, and
the packaged browser lifecycle. It does not cover the MKTTool Relay packaging pipeline, and one W02
regression was hiding in exactly that gap.

The MKTTool side of the slice had saved `relay/install-relay.ps1` without its UTF-8 byte order mark
while the file still held 986 non-ASCII characters. Windows PowerShell 5.1 reads a BOM-less `.ps1`
in the machine ANSI code page, so the installer still installs correctly and only its on-screen text
becomes unreadable. The MKTTool packaging script already guarded this, which is why the defect
surfaced as a halted Relay build rather than a silent bad installer — but that guard runs only when
someone packages a release, so the regression passed a full 1,120-test suite untouched.

Restoring the mark changed nothing else, because the file bytes were already valid UTF-8. The same
check now also lives in the MKTTool installer encoding tests, and the repackaged Relay executable
passed its 24-check acceptance while carrying the W02 contract and port `47822`. This does not alter
any browser-side result recorded above; the packaged browser artifact and its hash are unchanged.

## Open distribution and product gates

W02 is technical-only. It does not close MKB-00 or MKB-01, and it does not authorize a pilot.
Apple Silicon native application/engine verification, Electron upgrade/hardening, signing,
notarization, installer/update/rollback design, and operational proxy/account validation remain
open.

The unpacked directory still does not copy the repository's root MIT license beside the executable,
and PE copyright remains blank. These are explicit distribution gates for a later authorized
release slice, not W02 acceptance failures.
