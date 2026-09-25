# MKT Browser

MKT Browser is the internal desktop browser-profile runtime for MKTTool. It is derived from
MultiZen, preserves the proven profile/tool behavior and data formats, and owns its first-party
package, preload, MCP, and configuration identities.

This repository is an internal engineering fork. It is not a public release channel, a hosted
browser service, or an authorization boundary. MKTTool Web decides which account action is allowed,
the Relay verifies signed tickets and holds operator secrets, and MKT Browser stores and launches
profiles on the operator device.

## Where things stand

Everything below this section is an append-only log of dated checkpoints. Each entry is correct for
its own date and is deliberately not rewritten, so the newest entry is not necessarily the current
state. This block is the current state, and is the only part of this file that gets updated in
place.

| | |
|---|---|
| Current source candidate | `20260925-browser-0.3.27-relay-20-cold-start-tls-profiles-cft`; Browser `0.3.27`, control contract `6`, profile schema `3` |
| Current source | Replacement pins selected; final committed-source validation and artifact binding in progress |
| Source behavior | verified sequential admission, SDK shutdown and explicit capacity refresh |
| Pinned Relay | production-origin v20 archive `c66a3935...5526b`; final commit-bound rebuild and acceptance remain required |
| Pinned engine | CFT `152.0.7977.64` (`b0db25de…8004`), exact archive published in sequences 24 and 25 |
| Packaged Cloak lifecycle | **PASS** — R27 completed `P1 -> P2 -> P1 -> P2`, 4/4 usable launches in 3.647-3.929 s with clean seat return |
| Native fingerprint gate | **FAIL** — R28 completed 10/10 launches; criteria A/B/C all failed, so identity and real-account-safety claims remain prohibited |
| Candidate status | **OPEN** — two isolated 0.3.27 builds and exact clean-VM acceptance are not complete |
| Local gate | Candidate pin regressions 23/23; final frozen-source quality refresh remains required |
| Prior two-build equivalence | PASS for 0.3.23 — 129 files; `app.asar` byte-identical (51,770,195 bytes) |
| Prior clean-VM lifecycle | PASS (scope-limited) for exact 0.3.23 — clean `9/9`, repair `13/13`, uninstall `15/15` |
| Clean-VM CFT activation | **OPEN** — signed first-run provisioning and real engine execution are not yet accepted |
| Prior compatibility publication | PASS for 0.3.23 — sequences 23/24/25 immutable objects read back |
| 0.3.27 published / promoted | **No / No** |

Relay packaging now normalizes delivered Windows script line endings to CRLF while preserving
the PowerShell BOM. The candidate pins clean-checkout archive `c66a3935...5526b`; the previous
`e749be84...7439ff` archive remains historical evidence. Final source-bound rebuild and validation
remain required.

Rollout remains NO-GO. The abandoned `0.3.26` candidate passed local quality and two-build
comparison, but its retained Relay v20 archive failed terminal update handoff. Those receipts do
not validate `0.3.27`; the release contract rejects the failed archive hash. Current checkpoint
evidence is tracked in the workspace
[repair plan](../plans/260924-0114-relay-cold-start-tls-profiles/plan.md).

No 0.3.27 installer has been accepted or published. The Windows package is
still expected to be unsigned under the 12 August 2026 owner decision, so exact SmartScreen/UAC
behavior must be re-observed on the retained candidate rather than inherited from 0.3.23.

Current evidence of record lives in the workspace fast-switch and local-VM release plans, not in
this file. The 0.3.23 report remains historical evidence only.

## Fast sequential profile reuse live checkpoint - 22 September 2026

Current source keeps one local profile at a time and adds a five-second, count-only capacity
observation before each Windows CloakBrowser admission. The desktop coordinator serializes refresh
and launch admission, rejects duplicate work instead of queueing it, invalidates stale results on
state/key changes, and makes at most one engine attempt per operator request. Fresh aggregate
availability can retire a reconciled local cooling/refusal hold as `expired`; it never proves or
records that a specific vendor lease was confirmed released.

Contract 5 adds sanitized availability/reason/freshness fields and the authenticated
`refresh_license_capacity` profile-lifecycle tool. The capability `license-capacity-v1` remains
unadvertised pending live integration acceptance. `MKT_BROWSER_FAST_LICENSE_REUSE=0` restores the
conservative 25/30-minute path. Native fingerprint arguments, profile storage, proxy checks, and
managed authorization remain unchanged.

R26 proved that executing the licensed binary with `--version` consumed the only provider session;
production now reads the already verified bootstrap version instead. R27 then passed the full
packaged `P1 -> P2 -> P1 -> P2` sequence: all four profiles became usable within 3.647-3.929 seconds
of the previous close, retained all 13 required native flags, closed through `Browser.close`, left
no engine process and returned provider capacity to `0/1`.

R28 completed five disposable profiles twice. Lifecycle remained clean for all 10 launches, but
fingerprint criteria A, B and C independently failed. This preserves the product boundary: MKT
Browser is a profile manager with proxy binding, not an antidetect or identity-isolation product.
The redacted measurement receipt is retained and the raw host-identifying file was deleted.

Final review also closed two cancellation races so a close or app shutdown arriving during capacity
state persistence cannot start a later engine attempt. Relay 18 is now locally built and
smoke-verified, but packaged two-process contention, real proxy/DNS/WebRTC, two isolated Browser
builds, exact clean-VM installer evidence, second-PC, human acceptance and canary remain OPEN. No
new installer, publication or promotion is recorded. See the
[active plan](../plans/260921-1331-cloak-fast-profile-switch/plan.md).

## Quality review source repairs - 10 September 2026

Current source hardens pending-launch shutdown, archive validation and rollback, concurrent settings
updates, missing Startup cleanup, and pinned-Relay recovery attempts during an interrupted update.
These changes are not included in the accepted 0.3.17 / Relay 17 installer. That exact installer is
available for controlled internal Windows distribution; its acceptance is recorded in the workspace
release report and MKTTool roadmap. A replacement still needs fresh build and exact-tuple acceptance.
Starting a pinned Relay during an update block is an attempt, not proof of mixed-version recovery.
Historical candidate checkpoints below describe earlier verification, not current release status.

## Single-entry startup candidate - 8 September 2026

Replacement candidate **0.3.17 / Relay 17** is under verification and has no MSI acceptance yet.
The retained 0.3.16 passes the native nonblocking notice and empty-session tray checks, but signed
activation smoke fails because the geolocation service presents a Cloudflare HTML challenge.
The replacement uses an IP-only browser observer and still requires its address to match the
independent proxy probe. Invalid responses and redirects fail closed without exposing response
content. A disposable CFT diagnostic reaches that observer through the same proxy with normal TLS;
this is diagnostic evidence only. New independent builds and exact VM/MSI acceptance remain required.
The retained 0.3.15 is rejected: its native Relay failure dialog blocked Browser MCP and tray
handling until dismissed. The replacement uses an asynchronous, deduplicated error notice while
preserving owned-installation checks. Five notification regressions cover pending dialogs,
background notices, presentation failure and the actual Electron API wiring. Exact VM verification
must include an unanswered Relay error with responsive MCP before the replacement can be accepted.
Retained 0.3.14 / Relay 17 reached signed activation smoke, then Browser failed to recognize the
Relay-installed engine without a download index and retried its authenticated artifact URL without
authorization. The replacement recognizes an existing stable runtime only when its metadata matches
the signed engine version. Actual bootstrap regression: failed before, four tests passed after.
The unchanged Relay 17 fixes the earlier 0.3.13 / Relay 16 shutdown defect. Both older installers
remain rejected for promotion. Independent builds and exact VM/MSI acceptance precede delivery.

For normal packaged Windows sessions, open **MKT Browser** as the single entry point. It checks
the installed current-user Relay and starts it only when the owned executable and installation
checks permit it. Reopening Browser activates the existing manager and can retry Relay startup;
there is no background restart loop, automatic registration, or ownership repair.

Closing the manager hides it only when its tray is usable; browser profiles stay open. The tray
offers **Open MKT Browser**, **Check Relay**, and **Quit MKT Browser**. Quit closes browser profiles
and the Browser control endpoint, but leaves Relay available for vault operations. If tray setup
fails, the manager stays visible and closing it quits normally. Development, disposable
`--user-data-dir`, and compatibility-smoke sessions keep their existing lifecycle.

The combined installer makes Browser `--background` the sole owned login entry, replacing only
the verified Relay Startup shortcut. Uninstall restores standalone Relay startup when that Relay
is retained. Device identity, profile ownership, and signed authorization retain their contracts.
The Web candidate distinguishes an outdated Relay from an unavailable Browser and offers
**Check again**. Follow the [current checkpoint](../MKTTool/docs/development-roadmap.md#single-entry-browser-startup---8-september-2026)
for verification and new-candidate delivery; source checks are not installer acceptance.

## Product direction - 8 September 2026

The owner accepted MKT Browser as a **browser profile manager with proxy binding**. Its value is
local browser data, assigned proxy, explicit nick/PC ownership, and human-controlled lifecycle
through Relay. It makes no antidetect, unique-fingerprint, identity-isolation, or account-safety
promise. Prioritize Proxy vault and Relay operations, then reliable manual profile use.

Active antidetect/identity-engine research, custom Chromium fingerprint work, and further
Brave/Cloak identity experiments are closed. Security and compatibility maintenance continue;
existing runtime code, engine pins, adapters, and measured evidence remain intact. A future vendor
integration requires a separate owner decision with API, licensing, and measured acceptance
evidence; no vendor contact or integration is scheduled.

Current use remains bounded, admin-led technical demonstration with disposable data, one profile
at a time, and human login/input. Lane C stays **CLOSED**, `G2-IDENTITY=FAIL` remains recorded,
and the Browser release gates stay open. This scope decision does not approve team distribution
or real-account use. See the [product decision](../MKTTool/docs/project-overview-pdr.md#product-direction-decision---8-september-2026)
and [release boundary](../MKTTool/docs/internal-beta-release.md).

## Consolidation truth — 1 September 2026

The current consolidation branch is `release/consolidation-20260830` at `b9f9477`. The accepted provenance
receipt was generated from source commit `5ef710dd931028d4d608bea098311bf54bf5dc31`; subsequent
commits are documentation-only release-lane and CI-status corrections and do not change the
packaged payload.
Q14's dedicated safety commit corrects the MCP/driver capability language: raw CDP is session
restoration, and fingerprint reconciliation is internal coherence—not stealth evidence or identity
isolation.

The Windows `0.3.13` payload and Relay v16 bytes are measured, but the outer installer still has an
open NSIS/resource-order variance and the exact CloakBrowser Stable `.2` engine archive is absent.
The five-artifact Browser tuple is therefore P4b **OPEN** and not published. It is independent of
the MKTTool Web/Lane A deployment. `G2-IDENTITY` remains **FAIL** on the recorded font/audio/WebGL
collisions. There is no CloakBrowser channel, so Lane C is **CLOSED**: no vendor request, date, or
“coming soon” promise. MKT Browser remains a controlled Lane A/B tool with one profile at a time,
human login/input, and no identity-isolation claim.

## Fingerprint decision - 2 September 2026

The experimental acceptance gate has now been applied for the first time. CloakBrowser Stable `.2`
remains `BLOCKED` with `0/10` valid profile readings because the licensed engine would not launch.
Official Brave `v1.94.117` was measured with five disposable profiles, two runs each, against an
exact-revision same-machine CFT control. Brave failed all three criteria: restart/context
consistency, stable-subset collision, and cohort plausibility.

Brave audio did not form an invariant Brave vendor mark: seven components matched stock and five
rendered hashes varied by profile. Those five hashes also changed after restart, so they do not form
a persistent profile identity. Every pair still collided on a `62`/`63`-component stable subset.
The product can drive Brave with ordinary application/installer work, but identity evidence rejects
an engine migration under the owner-signed Phase 05 NO-GO. No migration work is authorized;
`G2-IDENTITY` remains `FAIL`, and no rollout or real-account permission changed.
See the [Phase 04 report](../plans/260902-0544-fingerprint-gate-and-brave-spike/reports/brave-identity.md)
and the [signed Phase 05 decision](../plans/260902-0544-fingerprint-gate-and-brave-spike/reports/go-no-go.md).

## Current status

- Upstream application baseline: MultiZen `v0.3.1` at commit
  `83c6898b2de3de1122b5fea88008fbbaa4677bff`.
- MKB-W01 Windows product/data isolation (not identity evidence): implemented and verified on Windows x64 on 10 August 2026.
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
  boundary is uncertain. CloakBrowser download failure can switch to CFT in-modal; CFT is a
  compatibility fallback only, not identity evidence. The combined-installer manifest now pins the
  verified Relay v16 archive, which accepts Browser contract v4. The
  installer also persists its conflict detector for runtime setup checks; contract v4 advertises
  `local-install-ready-v1` only after expected process, fixed-port, MultiZen-process, and startup
  ownership pass. The supported topology is one Windows operating-system user per PC; a foreign
  per-user installation is rejected before firewall mutation, and cross-user operation is not a
  release gate. The complete Node 22 installer suite, packaging contracts, typecheck, lint, and the
  production Electron bundle pass on the last verified package. The current `0.3.13` source
  candidate is a measured technical draft only; it is not published or approved for real-account
  use. The remaining Browser tuple and human/operator gates are explicit; Lane A Web deployment is
  tracked separately in MKTTool.
- MKB-03 Browser profile deletion is implemented as a separate in-app lifecycle. Contract version
  `4` removes `delete_profile` from MCP, and profile schema version `3` records incomplete deletion
  for crash-safe retry. The operator must type `DELETE <full profile id>`; active launch/close work
  is refused. Deletion is limited to the selected owned profile directory and database row, never
  Relay configuration, device credentials, the MCP token, or MultiZen data.
- P0 automated proxy, lease-journal, and readiness hardening is green as of 22 August 2026. Proxied
  launch fails closed on unverifiable egress; lease storage is atomic, schema-validated,
  crash-recoverable, serialized, and redacted; aggregate capacity contains no key/profile identity.
  Historical packaged Relay v15 restart and real VirtualBox power-cycle recovery passed on 27 August
  2026 using a disposable licensed profile; that v15 artifact is not the current candidate.
  `license-capacity-v1` remains deliberately unadvertised because
  live vendor schema/sidecar integration, real proxy/DNS/WebRTC evidence, human input, second-PC
  recovery, and canary gates remain open, so this is not rollout approval. The custom-engine path is
  closed and there is no CloakBrowser channel; Lane C is closed rather than waiting for a response.
- Lifecycle and installer evidence is current through 27 August 2026. Normal close returns the
  seat; an exact Browser hard kill persists cooling and blocks false reuse; an active Electron
  crash leaves the owned browser alive so startup can close it through `Browser.close`, reconcile
  the durable lease to `confirmed-released`, and reuse the same seat. Clean combined install passed
  9/9, repair 13/13, and uninstall 15/15 on the updated Defender snapshot without detections or
  policy changes. Relay v15 preserved device identity and spent-ticket replay protection across
  restart. The final disposable-VM power-cycle gate validated an active lease before one real
  `VBoxManage controlvm poweroff`, found no Browser process after boot while the exact lease remained
  active, converged through `cooling` with `pendingRecovery=0`, returned capacity after TTL, and
  relaunched and cleanly released the same profile. Evidence:
  `local-test-artifacts/phase5/real-power-cycle-recovery-evidence-20260827-ownership-fix-r2.json`.
- Release-readiness Phase 1 is verified locally on Windows as of 22 August 2026. The vulnerable
  direct runtime dependency `extract-zip@2.0.1` is replaced by pinned `yauzl@3.4.0` behind an owned
  fail-closed ZIP boundary for engine and CRX/ZIP extraction. Traversal, absolute and Windows device
  paths, links and special entries, case-folded collisions, zip bombs, truncation, and CRC failures
  are rejected before publication. CI audits production dependencies, and packaged verification
  inspects `app.asar` to require `yauzl@3.4.0` and reject `extract-zip` metadata or files.
- Release-readiness Phase 2 remains partial. Chromium now requests an OS-assigned DevTools port,
  accepts only a fresh bounded `DevToolsActivePort` record owned by the launched data directory and
  loopback listener, and uses one total 15-second operator budget or isolated 60-second packaged-CI
  budget. CI is split into quality, build-once package, and fresh-job packaged-contract jobs with a
  hashed uploaded archive. The final local directory package passed 5/5 cold lifecycle iterations
  while ports 9222 and 9223 were occupied. Remote run `33303002259` (attempt 2, source `b9f9477`)
  passed quality, package, and packaged-contract with no required skip and five cold launches. A
  future run still needs reviewed private-sibling checkout access or must fail closed; the separate
  scratch-branch negative matrix remains open.
- Consolidation push workflow run `33296202751` is retained as a runner failure: the
  self-hosted Windows PowerShell shell could not resolve `node` after setup, so package jobs were
  skipped. The earlier `33291356306` run showed the same failure mode and is historical evidence.
  These are failure receipts superseded by `33303002259`, not promotion evidence by themselves.
- Phase S3 produced a measured Windows x64 internal-beta candidate `0.3.13` at the consolidation
  tree `5ef710dd`; the verified Relay v16 archive is pinned. The installer remains unpublished and
  is not authorized for real-account use: the payload is deterministic, but the outer NSIS/resource
  ordering varies and the exact Stable `.2` engine archive is absent. It is intended for one profile
  at a time with human login and input; identity isolation is not proven. The [MKTTool internal-beta
  release guide](../MKTTool/docs/internal-beta-release.md) records the P4b tuple and closed Lane C.
- The former `0.3.12` installer and published Relay v15 payload remain quarantined negative evidence;
  their hashes are retained only to explain the failed restart-replay gate and must not be reused.
- The packaged runtime verifier uses a system Chrome compatibility fixture when selected; that is
  compatibility evidence only, not evidence that CloakBrowser identity surfaces are unique. Real-
  account pilot and broad team rollout remain gated by the acceptance matrix.

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

The browser engine is a separately licensed dependency. The current candidate records the approved
Stable `.2` pin and checksum, but the exact engine archive is not present in this workspace, so engine
provenance and identity gates remain open. It is not bundled in the application package. Review the
exact engine license and checksum before operational use.

## Engineering records

- [MKB-00 source, license, engine, and Windows baseline](docs/mkb-00-source-license-engine-inventory.md)
- [MKB-W01 Windows product isolation](docs/mkb-w01-windows-product-isolation.md)
- [MKB-W02 Windows internal clean break](docs/mkb-w02-windows-internal-clean-break.md)
- [Deferred MKB-07 Apple Silicon verification runbook](docs/mkb-00-apple-silicon-verification.md)
- [First attested release candidate, 23 August 2026](docs/first-attested-release-candidate.md)

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
