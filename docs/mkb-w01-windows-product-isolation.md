# MKB-W01 Windows product isolation

**Last updated:** 10 August 2026

**Status:** Implemented and verified on Windows x64

**Scope:** Windows-first technical development slice; not a pilot or release approval

## Decision

The project owner approved a Windows-first product-isolation slice while MKB-00 remains open on
Apple Silicon. This is a deliberate exception to the original phase ordering so Windows
implementation can continue without making a cross-platform compatibility claim.

MKB-W01 does not pass MKB-00 or MKB-01. It does not authorize real accounts, pilot distribution,
team rollout, signing, an installer, or a release channel.

## Implemented boundary

| Concern                 | W01 result                                                      |
| ----------------------- | --------------------------------------------------------------- |
| Display name            | `MKT Browser`                                                   |
| Electron application ID | `com.mkttool.browser`                                           |
| Windows AppUserModelID  | `com.mkttool.browser`                                           |
| Windows executable      | `MKTBrowser.exe`                                                |
| Windows PE VersionInfo  | `MKT Browser`; original filename `MKTBrowser.exe`               |
| Artifact prefix         | `MKTBrowser`                                                    |
| Windows data root       | `%LOCALAPPDATA%\MKTTool\MKTBrowser\`                            |
| Legacy data handling    | No scan, read, copy, move, delete, or automatic migration       |
| Upstream app updater    | Removed from runtime and dependencies                           |
| Upstream heartbeat      | Removed from runtime and UI                                     |
| Upstream publishing     | Publish scripts/provider removed; workflow is manual build-only |

The fixed data root is configured before `app.whenReady()`. The directory is created before
calling `app.setPath("userData", ...)`. A caller-supplied `--user-data-dir`
continues to take precedence for disposable development tests; normal product launches cannot fall
back to Electron's display-name-derived MultiZen directory.

All existing state consumers already resolve from `app.getPath("userData")`, so this one
boundary isolates:

- settings and the MCP token;
- `profiles.db` and Chromium profile directories;
- the shared extension store;
- the downloaded engine cache and Chromium session/cache data.

The current compatibility layout retains the upstream `chromium/` cache directory under
the new root. Renaming it to `engines/` is deferred until an engine migration and rollback
contract exists; W01 does not move cached binaries.

## Upstream channel quarantine

Setting `autoUpdate=false` alone was not sufficient because the old manual update action
could still contact MultiZen releases. W01 therefore removed:

- `electron-updater` and its transitive-only dependencies from the application and
  lockfile;
- updater initialization, timers, event listeners, install/restart behavior, and release URLs;
- update IPC and preload methods;
- the renderer update banner, manual check button, and automatic-update toggle;
- all `--publish always` scripts and the hard-coded MultiZen GitHub publish provider;
- tag-triggered release creation and write permissions from the workflow.

The workflow at `.github/workflows/release.yml` is now a manual Windows directory-build
check with read-only repository permissions. It cannot create or publish a release.

The opt-in heartbeat was also unsuitable for an independent product because enabling it contacted
`ping.getmultizen.com`. W01 removed the usage-reporting service from startup, removed the
consent and Settings controls, and deleted the runtime implementation. The old settings fields
remain inert and default to `false` only to avoid an unnecessary settings-schema break.
The unwired upstream telemetry-ingest service and deployment snippets were removed from the fork as
well, so the retired endpoint is absent from both application and service source.

## Compatibility retained

W01 deliberately did not rename:

- the `@multizen/*` workspace packages;
- `window.multizen` in the renderer bridge;
- the MCP server compatibility name and configuration key;
- `/mcp`, loopback port `7777`, bearer authentication, or tool names;
- profile IDs, profile schema, archive extension, or current MKTTool adapter calls.

These are compatibility surfaces, not display branding. Keeping them stable allowed the existing
MKTTool `MultizenAdapter` to verify the fork without server, ticket, or database changes.

Visible desktop copy now says MKT Browser, including the title bar, onboarding/bootstrap states,
Settings/About, errors, archive dialogs, MCP guidance, and companion-extension button. The upstream
layout and components remain unchanged.

## Verification evidence

All checks ran on Windows build `10.0.26200` with the checksum-verified portable
Node.js `22.23.1` and Yarn `4.5.0`.

| Check                                     | Result                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Dependency resolution                     | Passed; lockfile removed `electron-updater`                                         |
| Product identity tests                    | Passed, 4/4, including packaging metadata alignment                                 |
| Full workspace TypeScript check           | Passed                                                                              |
| Full workspace build                      | Passed                                                                              |
| Packaged Windows identity                 | Product name and file description `MKT Browser`; original filename `MKTBrowser.exe` |
| Packaged updater dependency               | Absent                                                                              |
| Packaged upstream URL/service marker scan | No MultiZen release URL, heartbeat endpoint, or application service match           |
| Windows executable                        | PE x64, `188,614,144` bytes                                                         |
| Executable SHA-256                        | `16462e535593b0ee572bf32069bee514774f6a7be1cda2f8329ff1a1efc60022`                  |

The resulting executable is:

```text
apps/desktop/release/win-unpacked/MKTBrowser.exe
```

### Default-root runtime and current-adapter smoke test

The final packaged application ran with a temporary `LOCALAPPDATA` and no `--user-data-dir`
argument. On the first launch the canonical product directory did not exist; the packaged main
process created it before readiness and wrote its generated MCP token there. Its command line
contained no override. After that process was stopped, the verified engine cache was copied into
the new root and the same artifact was launched again for the adapter lifecycle. Electron child
processes received the resulting `<temporary LocalAppData>\MKTTool\MKTBrowser` path after the
application configured `userData`; `data\profiles.db` also landed under that canonical root.

Only the previously checksum-verified engine cache was copied into the disposable root, avoiding a
new engine download. No account, cookie, production profile, real proxy credential, or external
proxy traffic was used. The test proxy target was the closed local endpoint `127.0.0.1:1`.

| Operation                                       | Result                             |
| ----------------------------------------------- | ---------------------------------- |
| MCP initialize and tools list                   | Passed; 22 tools                   |
| `list_profiles` through current MKTTool adapter | Passed; initial count 0            |
| Fingerprint options                             | Passed; 19 devices and 72 locales  |
| Create disposable profile                       | Passed                             |
| Apply invalid proxy with port `0`               | Rejected                           |
| State after invalid proxy                       | Profile remained closed            |
| Apply closed-loopback proxy                     | Passed                             |
| Launch profile                                  | Passed; running state became true  |
| Close profile                                   | Passed; running state became false |
| Delete disposable profile                       | Passed; final count 0              |

The existing `%APPDATA%\MultiZen` tree contained 3,059 files, including the state-bearing
`settings.json`, `mcp-token`, and `data\profiles.db`. No file in that legacy tree had a write time
during the final W01 runtime test. The temporary canonical product root, including its generated
bearer token, was deleted after all test processes and port `7777` were closed.

## Remaining work and limits

- W01 is frozen as the verified Windows isolation checkpoint. Because MKTTool has no operational
  deployment or production compatibility obligation yet, the owner deferred the internal-name,
  dedicated-port, and adapter clean break to MKB-W02 instead of widening this slice.
- The application icon is still inherited from the upstream baseline because no MKT Browser visual
  asset has been approved. W01 is technical identity isolation, not complete visual identity.
- The application version remains the pinned upstream-compatible `0.3.1`. Independent
  version/capability reporting belongs to W02.
- MultiZen and MKT Browser cannot run together while both use port `7777`.
- The automatic copy-only legacy-directory importer is deferred. Manual encrypted
  `.mzar` import remains available, but W01 never discovers legacy data by itself.
- Electron 33 is end-of-life. Upgrade, sandbox/CSP/IPC hardening, and
  `get_runtime_info` belong to W02.
- Signing, a Windows installer, Relay discovery, approved updates, and rollback belong to W04.
- The unpacked W01 technical package is not distributable release material: PE copyright metadata
  is blank and the root MIT license is not copied beside the executable. Release packaging must add
  the required application and third-party notices before any distribution.
- Apple Silicon remains unverified; no macOS readiness claim is made.
- The W01 checkpoint is recorded in local Git history. No destination `origin`, tag, or push has
  been created.

## Rollback position

W01 changes no MKTTool server data and no legacy MultiZen files. Stopping MKT Browser and reopening
the independently installed MultiZen application returns to the previous desktop runtime. Because
the stores are separate and no synchronization exists, profiles created in one product do not
silently appear in the other.
