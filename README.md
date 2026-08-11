# MKT Browser

MKT Browser is the internal desktop browser-profile runtime for MKTTool. It is derived from
MultiZen, preserves the proven profile/tool behavior and data formats, and owns its first-party
package, preload, MCP, and configuration identities.

This repository is an internal engineering fork. It is not a public release channel, a hosted
browser service, or an authorization boundary. MKTTool Web decides which account action is allowed,
the Relay verifies signed tickets and holds operator secrets, and MKT Browser stores and launches
profiles on the operator device.

## Current status

- Upstream application baseline: MultiZen `v0.3.1` at commit
  `83c6898b2de3de1122b5fea88008fbbaa4677bff`.
- MKB-W01 Windows product isolation: implemented and verified on Windows x64 on 10 August 2026.
- MKB-W02 internal clean break: implemented and verified across MKT Browser, MKTTool, and Relay on
  Windows x64 on 10 August 2026.
- Windows x64 is the only v1 and team-demo platform. macOS Apple Silicon is deferred to MKB-07 and
  does not block current work.
- MKB-00 was verified on 11 August 2026. The current packaged Windows build launched a disposable
  profile through a dedicated working proxy, and its in-browser exit IP matched an independent
  proxy probe. No proxy value or observed IP was recorded in evidence.
- This build may be used for an owner-led technical demo with disposable profiles. It is not
  approved for real accounts, pilot distribution, or team rollout.
- The Windows directory package was regenerated on 11 August 2026 with SHA-256
  `27c27443385f4ecdbc0187772934adb5d1718169d7c387d41b3718ef72ba2b18`; W02 guards and typecheck
  passed. It remains unsigned.

## Owned product and local contract

| Item                      | Value                                |
| ------------------------- | ------------------------------------ |
| Display name              | `MKT Browser`                        |
| Application ID            | `com.mkttool.browser`                |
| Windows executable        | `MKTBrowser.exe`                     |
| Windows data root         | `%LOCALAPPDATA%\MKTTool\MKTBrowser\` |
| Workspace package scope   | `@mktbrowser/*`                      |
| Preload bridge            | `window.mktBrowser`                  |
| MCP server/bin identity   | `mkt-browser` / `mkt-browser-mcp`    |
| Default MCP endpoint      | `http://127.0.0.1:47822/mcp`         |
| Desktop port override     | `MKT_BROWSER_MCP_PORT`               |
| MKTTool dev/test override | `MKT_BROWSER_MCP_URL`                |
| Relay config override     | `mktBrowserUrl`                      |

Normal launches use the fixed product data root. MKT Browser does not scan, read, copy, move, or
delete the legacy `%APPDATA%\MultiZen` store. An explicit Electron
`--user-data-dir` remains available for disposable development tests.

The upstream application updater, manual update IPC, GitHub publish configuration, and usage
heartbeat are absent from the runtime. Application updates are intentionally disabled until an
approved internal release channel and rollback process exist.

W02 deliberately removed the retained first-party MultiZen package, preload, MCP client/server,
adapter, and configuration identities. There is no dual-name compatibility fallback. Existing MCP
tool names, profile schema, archive format, upstream attribution, and engine-license boundary are
unchanged. Port `7777` is no longer a MKT Browser dependency.

## Windows development

Use Node.js 22 and the pinned Yarn version:

```powershell
corepack yarn install --immutable
corepack yarn workspace @mktbrowser/desktop test:w02
corepack yarn typecheck
corepack yarn workspace @mktbrowser/desktop build
```

The Windows directory package is written to:

```text
apps/desktop/release/win-unpacked/MKTBrowser.exe
```

The current build command creates an unpacked technical package. W02 does not publish an installer,
create a release, sign binaries, or update an installed copy.

The packaging helper removes local `apps/desktop/node_modules/@mktbrowser/*` workspace links before
invoking electron-builder. Run `corepack yarn install --immutable` again after a local package build
before continuing with development commands such as typecheck or dev.

## Local data

The Windows implementation uses this layout:

```text
%LOCALAPPDATA%\MKTTool\MKTBrowser\
├── settings.json
├── mcp-token
├── chromium\
└── data\
    ├── profiles.db
    ├── profiles\
    └── extension-store\
```

The MCP token and profile directory contain sensitive local state. Never log, commit, or share them.
Uninstalling the application must not delete profiles by default.

The browser engine is a separately licensed dependency. It is downloaded unmodified from an
approved official source and is not bundled in the application package. Review the exact engine
license and checksum before operational use.

## Engineering records

- [MKB-00 source, license, engine, and Windows baseline](docs/mkb-00-source-license-engine-inventory.md)
- [MKB-W01 Windows product isolation](docs/mkb-w01-windows-product-isolation.md)
- [MKB-W02 Windows internal clean break](docs/mkb-w02-windows-internal-clean-break.md)
- [Deferred MKB-07 Apple Silicon verification runbook](docs/mkb-00-apple-silicon-verification.md)

## Upstream and license

The fetch-only `upstream` remote points to
[multizenteam/multizen-browser](https://github.com/multizenteam/multizen-browser). Preserve upstream
history and attribution when syncing changes.

The application source remains under the upstream MIT license; see [LICENSE](LICENSE). The MIT
license for the application does not grant redistribution rights for a downloaded browser engine.
The current unpacked package does not copy this root MIT license beside the executable, and the PE
copyright field is blank. Both remain distribution gates for a later authorized release slice.
