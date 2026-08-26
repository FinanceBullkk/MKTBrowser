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
  create, atomic launch, managed-profile locking, and correlated operation diagnostics; the current
  runtime contract is version `4`, which also removes profile deletion from MCP and conditionally
  reports local-install readiness. The Relay token is profile-management only; page, cookie, and
  raw-CDP tools are unavailable and no page-control token is issued by this build.
- MKB-03 local-onboarding fixes are implemented but still require human retest. The per-user Windows
  installer requests one Administrator approval for machine-wide outbound UDP rules covering the
  stable CFT and CloakBrowser runtime paths. Every proxied profile launch verifies its own engine's
  exact rule and all Windows firewall profiles, then fails closed before browser startup if the
  boundary is uncertain. CloakBrowser download failure can switch to CFT in-modal; CFT remains a
  compatibility fallback, not the primary antidetect runtime. The combined-installer manifest now
  pins the published Relay v15 archive, which accepts Browser contract v4. The
  installer also persists its conflict detector for runtime setup checks; contract v4 advertises
  `local-install-ready-v1` only after expected process, fixed-port, MultiZen-process, and startup
  ownership pass. The supported topology is one Windows operating-system user per PC; a foreign
  per-user installation is rejected before firewall mutation, and cross-user operation is not a
  release gate. The complete Node 22 installer suite, packaging contracts, typecheck, lint, and the
  production Electron bundle pass. Operational distribution remains
  blocked until the installer is rebuilt from the current source and the remaining human Windows
  gates pass.
- MKB-03 Browser profile deletion is implemented as a separate in-app lifecycle. Contract version
  `4` removes `delete_profile` from MCP, and profile schema version `3` records incomplete deletion
  for crash-safe retry. The operator must type `DELETE <full profile id>`; active launch/close work
  is refused. Deletion is limited to the selected owned profile directory and database row, never
  Relay configuration, device credentials, the MCP token, or MultiZen data.
- P0 automated proxy, lease-journal, and readiness hardening is green as of 22 August 2026. Proxied
  launch fails closed on unverifiable egress; lease storage is atomic, schema-validated,
  crash-recoverable, serialized, and redacted; aggregate capacity contains no key/profile identity.
  `license-capacity-v1` remains deliberately unadvertised while Relay-restart and reboot recovery
  are incomplete, even though driver journal writes and active Electron-crash startup recovery now
  pass. Real proxy/DNS/WebRTC evidence, human input, second-PC recovery, and canary gates remain
  open, so this is not rollout approval.
- Lifecycle and installer evidence is current through 25 August 2026. Normal close returns the
  seat; an exact Browser hard kill persists cooling and blocks false reuse; an active Electron
  crash leaves the owned browser alive so startup can close it through `Browser.close`, reconcile
  the durable lease to `confirmed-released`, and reuse the same seat. Clean combined install passed
  9/9, repair 13/13, and uninstall 15/15 on the updated Defender snapshot without detections or
  policy changes. Relay restart remains open. The reboot defect measured on 25 August 2026 as
  `FAIL - REBOOT_LEASE_STUCK_PENDING_RECOVERY` is fixed in code on 26 August 2026: startup now
  settles a lease no surviving browser can answer for, taking the boot time as proof that whatever
  held that seat cannot still be heartbeating, and rests the key for the vendor lease TTL counted
  from the boot instead of holding it with no deadline. Measured on the packaged app against a
  reconstructed reboot: the pre-fix build reproduces the 25 August verdict exactly, journal `active`
  and capacity 0 free / 1 pending, while the fixed bundle on the same runtime settles the lease and
  reports 1 free. A real power cycle on a real key is still owed, so `G3-RECOVERY` stays open.
- Release-readiness Phase 1 is verified locally on Windows as of 22 August 2026. The vulnerable
  direct runtime dependency `extract-zip@2.0.1` is replaced by pinned `yauzl@3.4.0` behind an owned
  fail-closed ZIP boundary for engine and CRX/ZIP extraction. Traversal, absolute and Windows device
  paths, links and special entries, case-folded collisions, zip bombs, truncation, and CRC failures
  are rejected before publication. CI audits production dependencies, and packaged verification
  inspects `app.asar` to require `yauzl@3.4.0` and reject `extract-zip` metadata or files.
- Release-readiness Phase 2 is in progress. Chromium now requests an OS-assigned DevTools port,
  accepts only a fresh bounded `DevToolsActivePort` record owned by the launched data directory and
  loopback listener, and uses one total 15-second operator budget or isolated 60-second packaged-CI
  budget. CI is split into quality, build-once package, and fresh-job packaged-contract jobs with a
  hashed uploaded archive. The final local directory package passed 5/5 cold lifecycle iterations
  while ports 9222 and 9223 were occupied. The required PR artifact run and seven independent 20/20
  Windows runner runs remain open, so Phase 2 is not complete.
- This build may be used for an owner-led technical demo with disposable profiles. It is not
  approved for real accounts, pilot distribution, or team rollout.
- The current desktop package version is `0.3.12`. The local Windows directory package measured on
  25 August 2026 has SHA-256
  `50b0ccb3ae470d7089203877f8cbf0e3b17718dabde693182fbc4be688655469`; packaged `app.asar` SHA-256
  is `7160c85a49afe0095a06e7e9df80ef5d07e2fc80f50df54ffb95b7102a1aa557`. Node `22.23.2`
  verification passes `test:mkb02` `120/120`, critical coverage `93/93` at 88.66% lines, 83.74%
  branches, and 87.78% functions, typecheck, zero-warning lint, the complete installer/build gate,
  the active Electron-crash recovery gate, and packaged runtime/profile-lifecycle verification.
  The repository's `yarn lint` enforces the workspace quality contract, strict TypeScript
  unused/fallthrough checks, and JavaScript syntax checks. The packaged verifier covers
  the restricted tool inventory, deterministic managed create/retry, correlated diagnostics,
  direct-launch/delete denial, endpoint-free proxy summaries, atomic managed launch, Windows Chrome
  launcher-PID handoff, OS-assigned owned DevTools discovery, per-stage timing, bounded verifier HTTP
  requests, sanitized failure snapshots, process-confirmed close, and clean process exit. It remains
  unsigned. The
  attested installer was built on 23 August from older source `eac77f8f` / tree `cce7b897`. It
  embeds the verified Relay v15 archive but predates four local Browser fixes, and its supported
  combined install/repair/uninstall gate remains open, so it is not the current rollout artifact
  and must not be distributed.

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

### Change history

This repository keeps no changelog of its own. Behaviour changes, including ones that affect an
operator's identity, are recorded in the MKTTool repository's `docs/project-changelog.md`, which
covers the product as a whole — MKTTool is the console, this is its execution layer, and a change
here usually lands with a matching change there.

Note when checking whether a build is affected by something recorded there: this repository _is_
versioned and tagged (`v0.3.1` at the time of writing), while MKTTool is not, so a changelog entry
naming a build range is naming **these** tags.

## Upstream and license

The fetch-only `upstream` remote points to
[multizenteam/multizen-browser](https://github.com/multizenteam/multizen-browser). Preserve upstream
history and attribution when syncing changes.

The application source remains under the upstream MIT license; see [LICENSE](LICENSE). The MIT
license for the application does not grant redistribution rights for a downloaded browser engine.
The current unpacked package does not copy this root MIT license beside the executable, and the PE
copyright field is blank. Both remain distribution gates for a later authorized release slice.
