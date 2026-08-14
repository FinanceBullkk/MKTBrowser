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
- MKB-01 Windows compatibility and product identity was completed on 11 August 2026. A fresh normal
  launch can copy legacy MultiZen profiles without changing the source; five primary-screen visual
  baselines are checked in; Windows CI runs the W01/W02, MKB-01, and MKB-01E guards, typecheck,
  build, and packaged runtime-contract verification on every push and pull request.
- MKB-01E Electron upgrade and renderer hardening was completed on 11 August 2026. The packaged
  application runs Electron `42.8.1` with modules ABI `146` and `better-sqlite3` `12.11.1`; the
  renderer is sandboxed with a restrictive CSP, IPC and MCP exposure inventories fail closed, and
  the fixed-seed fingerprint measurement remained identical before and after the upgrade.
- MKB-02 managed mode was completed on 12 August 2026. Contract version `3` introduced idempotent
  create, atomic launch, managed-profile locking, and correlated operation diagnostics. The Relay
  token is profile-management only; page, cookie, and raw-CDP tools are unavailable and no
  page-control token is issued by this build.
- MKB-03 local-onboarding fixes are implemented but still require human retest. The per-user Windows
  installer requests one Administrator approval for machine-wide outbound UDP rules covering the
  stable CFT and CloakBrowser runtime paths. Every proxied profile launch verifies its own engine's
  exact rule and all Windows firewall profiles, then fails closed before browser startup if the
  boundary is uncertain. CloakBrowser download failure can switch to CFT in-modal; CFT remains a
  compatibility fallback, not the primary antidetect runtime. The combined-installer manifest now
  pins the locally verified, unpublished Relay v12 archive, which accepts Browser contract v4. The
  installer also persists its conflict detector for runtime setup checks; contract v4 advertises
  `local-install-ready-v1` only after expected process, fixed-port, MultiZen-process, and startup
  ownership pass. The complete Node 22 installer suite passes 97/97, packaging contracts pass 24/24,
  and typecheck, lint, and the production Electron bundle pass. Operational distribution remains
  blocked until the immutable v12 object is published and the human Windows gates pass.
- MKB-03 Browser profile deletion is implemented as a separate in-app lifecycle. Contract version
  `4` removes `delete_profile` from MCP, and profile schema version `3` records incomplete deletion
  for crash-safe retry. The operator must type `DELETE <full profile id>`; active launch/close work
  is refused. Deletion is limited to the selected owned profile directory and database row, never
  Relay configuration, device credentials, the MCP token, or MultiZen data.
- This build may be used for an owner-led technical demo with disposable profiles. It is not
  approved for real accounts, pilot distribution, or team rollout.
- The Windows directory package was regenerated on 12 August 2026 with SHA-256
  `238d5d6fd5e373b052c484ceab90698f6dc295205a59be6573f9928b01db4f42`; Node guard 2/2,
  W02 guards 8/8, MKB-01 tests 8/8, MKB-01E tests 7/7, MKB-02 tests 18/18, Windows packaging guards
  3/3, typecheck, build, and packaged runtime/profile-lifecycle verification passed. The repository's
  `yarn lint` now enforces the workspace quality contract, strict TypeScript unused/fallthrough
  checks, and JavaScript syntax checks. The packaged verifier covers
  the restricted tool inventory, deterministic managed create/retry, correlated diagnostics,
  direct-launch/delete denial, endpoint-free proxy summaries, atomic managed launch, Windows Chrome
  launcher-PID handoff, process-confirmed close, and clean process exit. It remains unsigned.

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

Normal launches use the fixed product data root. On the first normal launch only, when MKT Browser
has no profile database and `%APPDATA%\MultiZen\data\profiles.db` exists, the app asks whether to
copy the profiles. It copies the profile database, profile directories, and shared extension store
into the MKT Browser root, rewrites copied profile paths, and never changes or deletes the MultiZen
source. It does not copy the legacy MCP token or settings. Choosing `Start fresh` creates an
independent empty store. An explicit Electron `--user-data-dir` remains available for disposable
development tests and skips legacy discovery entirely.

An unreadable legacy database is reported without crashing startup and offers `Start fresh` or
`Quit`. Import also fails closed if any database row points outside the legacy profile root or its
profile directory is missing.

The upstream application updater, manual update IPC, GitHub publish configuration, and usage
heartbeat are absent from the runtime. Application updates are intentionally disabled until an
approved internal release channel and rollback process exist.

The HTTP bearer token stored in this data root grants profile management only. It can inspect runtime
and profile state and call authorized non-destructive lifecycle tools, but it cannot delete profiles,
navigate, click, type, read pages, access cookies, or send raw CDP. `tools/list` is authoritative.
Managed profiles can be opened
only through the MKTTool → Relay → `launch_managed_profile` path; ordinary direct launch, delete,
export, and proxy/fingerprint edits are locked.

Permanent deletion is initiated only inside MKT Browser. It requires the full profile id in a typed
confirmation and refuses while Chromium is launching, running, or closing. The profile directory is
atomically moved to an owned quarantine before removal. If disk or database cleanup stops midway,
the row stays visibly marked for retry instead of silently orphaning data or reporting success.

W02 deliberately removed the retained first-party MultiZen package, preload, MCP client/server,
adapter, and configuration identities. There is no dual-name compatibility fallback. Existing MCP
tool names, profile schema, archive format, upstream attribution, and engine-license boundary are
unchanged. Port `7777` is no longer a MKT Browser dependency.

## Windows development

Use Node.js 22 and the pinned Yarn version:

```powershell
corepack yarn install --immutable
corepack yarn verify:node
corepack yarn workspace @mktbrowser/desktop test:w02
corepack yarn workspace @mktbrowser/desktop test:mkb01
corepack yarn workspace @mktbrowser/desktop test:mkb01e
corepack yarn workspace @mktbrowser/desktop test:mkb02
corepack yarn typecheck
corepack yarn lint
corepack yarn workspace @mktbrowser/desktop build
corepack yarn verify:packaged-contract
```

The Windows directory package is written to:

```text
apps/desktop/release/win-unpacked/MKTBrowser.exe
```

The normal build command creates an unpacked technical package. MKB-03 also provides
`corepack yarn workspace @mktbrowser/desktop package:windows-installer`, which builds the unsigned
combined installer after verifying the pinned Relay archive. Building does not publish or install it.

The build fails before touching native modules unless it runs on Node.js 22. The packaging helper
moves local `apps/desktop/node_modules/@mktbrowser/*` workspace links outside the package tree,
reuses the installed Electron distribution when available, temporarily rebuilds `better-sqlite3`
for the packaged Electron ABI, then restores both the workspace links and Node ABI even when
packaging fails. No post-build dependency reinstall is required.

Regenerate the reviewed MKB-01 screen references with `corepack yarn capture:mkb01-baselines`. The
five PNG files live under `assets/images/mkb-01-visual-baselines/`. Measure a deliberate Electron
upgrade fingerprint comparison with `corepack yarn measure:mkb01e-fingerprint` and explicit
`--output` / `--label` arguments passed after `--`.

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

Permanent deletion removes only the selected directory under `data\profiles\` and its database row.
It never removes `settings.json`, `mcp-token`, Relay state, device identity, or legacy MultiZen data.

On Windows, each engine executable lives at a deliberately unversioned path:
`chromium\cft\runtime\chrome.exe` or `chromium\cloakbrowser\runtime\chrome.exe`. Runtime updates
atomically replace the containing directory with rollback protection, so installer-managed firewall
rules stay attached across version changes. CFT and CloakBrowser have separate rules and separate
pre-launch verification; protection observed for one engine is never evidence for the other.

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
