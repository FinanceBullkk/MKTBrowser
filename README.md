# MKT Browser

MKT Browser is the internal desktop browser-profile runtime for MKTTool. It is derived from
MultiZen and retains the compatible local MCP/profile behavior while the product-specific safety
and delivery layers are built.

This repository is an internal engineering fork. It is not a public release channel, a hosted
browser service, or an authorization boundary. MKTTool Web decides which account action is allowed,
the Relay verifies signed tickets and holds operator secrets, and MKT Browser stores and launches
profiles on the operator device.

## Current status

- Upstream application baseline: MultiZen `v0.3.1` at commit
  `83c6898b2de3de1122b5fea88008fbbaa4677bff`.
- MKB-W01 Windows product isolation: implemented and verified on Windows x64 on 10 August 2026.
- MKB-00 remains open because a native Apple Silicon build and runtime/proxy test have not run on
  real Mac hardware.
- This build is for technical development only. It is not approved for pilot or team rollout.

## W01 product boundary

| Item               | Value                                |
| ------------------ | ------------------------------------ |
| Display name       | `MKT Browser`                        |
| Application ID     | `com.mkttool.browser`                |
| Windows executable | `MKTBrowser.exe`                     |
| Windows data root  | `%LOCALAPPDATA%\MKTTool\MKTBrowser\` |
| MCP endpoint       | `http://127.0.0.1:7777/mcp`          |

Normal launches use the fixed product data root. MKT Browser does not scan, read, copy, move, or
delete the legacy `%APPDATA%\MultiZen` store. An explicit Electron
`--user-data-dir` remains available for disposable development tests.

The upstream application updater, manual update IPC, GitHub publish configuration, and usage
heartbeat are absent from the W01 runtime. Application updates are intentionally disabled until an
approved internal release channel and rollback process exist.

Compatibility names such as the `@multizen/*` package scope, `window.multizen`
preload bridge, MCP server name, and existing tool names remain unchanged in W01. They are protocol
and upstream-merge compatibility details, not the product display identity. MultiZen and MKT
Browser also still contend for MCP port `7777`; do not run both simultaneously.

## Windows development

Use Node.js 22 and the pinned Yarn version:

```powershell
corepack yarn install --immutable
corepack yarn workspace @multizen/desktop test:w01
corepack yarn typecheck
corepack yarn build
```

The Windows directory package is written to:

```text
apps/desktop/release/win-unpacked/MKTBrowser.exe
```

The current build command creates an unpacked technical package. W01 does not publish an installer,
create a release, sign binaries, or update an installed copy.

The packaging helper removes local `apps/desktop/node_modules/@multizen/*` workspace links before
invoking electron-builder. Run `corepack yarn install --immutable` again after a local package build
before continuing with development commands such as typecheck or dev.

## Local data

The compatibility implementation currently uses this layout:

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
- [Apple Silicon verification runbook](docs/mkb-00-apple-silicon-verification.md)

## Upstream and license

The fetch-only `upstream` remote points to
[multizenteam/multizen-browser](https://github.com/multizenteam/multizen-browser). Preserve upstream
history and attribution when syncing changes.

The application source remains under the upstream MIT license; see [LICENSE](LICENSE). The MIT
license for the application does not grant redistribution rights for a downloaded browser engine.
