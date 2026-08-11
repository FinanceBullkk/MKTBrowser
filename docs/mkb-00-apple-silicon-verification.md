# MKB-07 Apple Silicon verification runbook

**Purpose:** Preserve the future MKB-07 native macOS verification path using a real Apple Silicon Mac.
**Current result:** Not run. CI configuration and release assets are not substitutes for this test.

**Scope update, 11 August 2026:** Windows x64 is the only v1 and team-demo platform. Do not run this
work on the current critical path; Apple Silicon no longer closes or blocks MKB-00.

This runbook uses only a disposable application data directory, a disposable browser profile, and a
dedicated test proxy. Do not sign in to Reddit, Facebook, Google, or any other account. Do not point
the test at an operational MultiZen/MKT Browser data directory.

Sections 1-4 intentionally reproduce the frozen, unmodified upstream MKB-00 baseline. Their
upstream application name, environment key, executable name, and port `7777` are historical test
inputs rather than active MKT Browser contracts. Section 5 uses the current post-W02 MKTTool
consumer names against that pinned baseline.

## Prerequisites

- A real Apple Silicon Mac needed by the operator fleet.
- Xcode Command Line Tools, Git, and an official Node.js release compatible with the pinned source.
- The MKTTool checkout for testing its current `MktBrowserAdapter`.
- A dedicated disposable HTTP or SOCKS5 proxy whose expected exit IP is known.
- No production account credentials, profile archive, cookies, or TOTP secret.

Record the operator-device inventory first:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
uname -m
sw_vers
sysctl -n machdep.cpu.brand_string
system_profiler SPHardwareDataType
```

Acceptance requires `uname -m` to return `arm64`. Record the Mac model, chip, memory, and macOS
version in the MKB-00 evidence without recording the operator's username or device serial number.

## 1. Pin and verify the source

Use a separate checkout. Do not reuse a working MultiZen installation directory.

```bash
git clone --origin upstream https://github.com/multizenteam/multizen-browser.git MKTBrowser-mkb00
cd MKTBrowser-mkb00
git checkout --detach 83c6898b2de3de1122b5fea88008fbbaa4677bff
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git describe --tags --exact-match HEAD
shasum -a 256 yarn.lock
git status --short
```

Expected values:

```text
HEAD:      83c6898b2de3de1122b5fea88008fbbaa4677bff
tree:      ed96a70b16fca62f9e495bcb97cd36f9e7a5b811
tag:       v0.3.1
yarn.lock: f256f994202bcbf5110985847b27d04fb6f4261cbf61b9b835143d27bd9af594
```

Stop if any value differs.

## 2. Install and build the unmodified arm64 baseline

The upstream CI uses Node.js 24 and has a compiler toolchain. Windows MKB-00 required official
Node.js 22.23.1 because the host lacked a compiler for a Node.js 24 native install. On this Mac,
record the exact Node version and use the first compatible official toolchain that completes an
immutable install without changing `yarn.lock`; do not rewrite dependencies to make the test pass.

```bash
node --version
corepack --version
corepack enable
corepack prepare yarn@4.5.0 --activate
yarn --version
yarn install --immutable
yarn typecheck
yarn lint
yarn build
git status --short
shasum -a 256 yarn.lock
```

`yarn lint` is currently a no-op because the workspaces have no lint scripts. Record that fact rather
than treating its exit code as lint coverage.

Find the directory package and inspect every native boundary:

```bash
APP="$(find apps/desktop/release -type d -name 'MultiZen.app' -print -quit)"
test -n "$APP"
APP_BIN="$APP/Contents/MacOS/MultiZen"
test -x "$APP_BIN"
file "$APP_BIN"
lipo -archs "$APP_BIN"

SQLITE_NODE="$(find "$APP" -type f -name 'better_sqlite3.node' -print -quit)"
test -n "$SQLITE_NODE"
file "$SQLITE_NODE"
lipo -archs "$SQLITE_NODE"

codesign -dv --verbose=4 "$APP" 2>&1 || true
```

Acceptance:

- The application binary reports `arm64`; it must not be an x64-only Rosetta build.
- `better_sqlite3.node` reports `arm64` or a universal binary containing `arm64`.
- Build, typecheck, and immutable install pass without a lockfile change.
- Signing output is recorded honestly. The upstream baseline is not Developer ID signed or
  notarized, so Gatekeeper warnings are expected and do not count as production readiness.

## 3. Start with a disposable Electron data directory

Do not rely on changing `HOME`, `TMPDIR`, or `APPDATA`-style variables. Pass Electron's explicit
`--user-data-dir` flag.

```bash
MKB00_USER_DATA="$(mktemp -d "${TMPDIR%/}/mkb00-multizen.XXXXXX")"
export MKB00_USER_DATA

env -u ELECTRON_RUN_AS_NODE \
  MULTIZEN_NO_TELEMETRY=1 \
  "$APP_BIN" "--user-data-dir=$MKB00_USER_DATA" \
  >"$MKB00_USER_DATA/app.stdout.log" \
  2>"$MKB00_USER_DATA/app.stderr.log" &
MKB00_APP_PID=$!
export MKB00_APP_PID
trap 'kill "$MKB00_APP_PID" 2>/dev/null || true' EXIT
```

Wait for authenticated MCP without printing the token:

```bash
for _ in $(seq 1 180); do
  test -s "$MKB00_USER_DATA/mcp-token" && break
  sleep 1
done
test -s "$MKB00_USER_DATA/mcp-token"

MKB00_MCP_TOKEN="$(tr -d '\r\n' < "$MKB00_USER_DATA/mcp-token")"
test -n "$MKB00_MCP_TOKEN"

UNAUTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:7777/healthz)"
test "$UNAUTH_STATUS" = "401"

curl --fail --silent --show-error \
  -H "Authorization: Bearer $MKB00_MCP_TOKEN" \
  http://127.0.0.1:7777/healthz >/dev/null
```

Never run `echo "$MKB00_MCP_TOKEN"`, enable shell tracing, or paste the token into evidence.

## 4. Verify the downloaded engine

Wait for `current.json`, then inspect its recorded version and architecture:

```bash
ENGINE_MARKER="$MKB00_USER_DATA/chromium/cloakbrowser/current.json"
for _ in $(seq 1 900); do
  test -s "$ENGINE_MARKER" && break
  sleep 1
done
test -s "$ENGINE_MARKER"

ENGINE_VERSION="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.env.MKB00_USER_DATA+"/chromium/cloakbrowser/current.json","utf8"));process.stdout.write(p.version)')"
ENGINE_RELATIVE="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.env.MKB00_USER_DATA+"/chromium/cloakbrowser/current.json","utf8"));process.stdout.write(p.binaryRelative)')"
ENGINE_SHA256="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.env.MKB00_USER_DATA+"/chromium/cloakbrowser/current.json","utf8"));process.stdout.write(p.sha256)')"
ENGINE_BIN="$MKB00_USER_DATA/chromium/cloakbrowser/$ENGINE_VERSION/$ENGINE_RELATIVE"

test -x "$ENGINE_BIN"
file "$ENGINE_BIN"
lipo -archs "$ENGINE_BIN"
printf 'ENGINE_VERSION=%s\n' "$ENGINE_VERSION"
printf 'ENGINE_ARCHIVE_SHA256=%s\n' "$ENGINE_SHA256"
```

At the 10 August 2026 audit, the public macOS arm64 candidate was
`145.0.7632.109.2` with archive SHA-256
`505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c`. If the selected version or
hash differs, stop and re-audit the corresponding official release asset and current binary license
before launching a profile.

Acceptance:

- The engine executable contains native `arm64`.
- `current.json.sha256` matches `SHA256SUMS` from the exact official CloakHQ release.
- The engine launches without Rosetta.
- Any `codesign` or Gatekeeper result is recorded; do not describe the ad-hoc upstream engine or app
  as Developer ID signed/notarized.

## 5. Run the current MKTTool adapter with a disposable proxy

Clone or open the MKTTool checkout, install its pinned dependencies, and supply a dedicated test
proxy through interactive prompts so credentials do not enter shell history:

```bash
MKTTOOL_ROOT=/absolute/path/to/MKTTool
cd "$MKTTOOL_ROOT"
npm ci

read -r -p 'Proxy protocol (http or socks5): ' MKB00_PROXY_PROTOCOL
read -r -p 'Proxy host: ' MKB00_PROXY_HOST
read -r -p 'Proxy port: ' MKB00_PROXY_PORT
read -r -p 'Expected exit IP: ' MKB00_EXPECTED_EXIT_IP
read -r -p 'Proxy username (blank if none): ' MKB00_PROXY_USERNAME
read -r -s -p 'Proxy password (blank if none): ' MKB00_PROXY_PASSWORD
printf '\n'
export MKB00_PROXY_PROTOCOL MKB00_PROXY_HOST MKB00_PROXY_PORT
export MKB00_EXPECTED_EXIT_IP MKB00_PROXY_USERNAME MKB00_PROXY_PASSWORD
```

Run this exact smoke program from the MKTTool root. It imports the current adapter, uses raw MCP only
for the negative input, exit-IP check, and cleanup, and redacts the password from any diagnostic:

```bash
node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import { MktBrowserAdapter } from "./src/lib/antidetect/mkt-browser-adapter.ts";

const baseUrl = "http://127.0.0.1:7777";
const token = fs.readFileSync(`${process.env.MKB00_USER_DATA}/mcp-token`, "utf8").trim();
const password = process.env.MKB00_PROXY_PASSWORD || undefined;
const redact = (value) => password ? String(value).split(password).join("[REDACTED]") : String(value);
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

async function rawTool(id, name, args) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`MCP RPC ${payload.error.code}`);
  return payload.result;
}

const adapter = new MktBrowserAdapter(baseUrl, token);
let profileId;

try {
  const initial = await adapter.listProfiles();
  if (initial.length !== 0) throw new Error("Disposable vault is not empty.");
  console.log("LIST_PROFILES=ok");

  const options = await adapter.fingerprintOptions();
  if (options.devices.length === 0 || options.locales.length === 0) {
    throw new Error("Fingerprint options are empty.");
  }
  console.log("LIST_FINGERPRINT_OPTIONS=ok");

  profileId = await adapter.createProfile({
    name: "MKB-00 disposable Apple Silicon adapter",
    notes: "No account data. Delete after MKB-00.",
    tags: ["mkb-00", "disposable", "apple-silicon"],
  });
  console.log("CREATE_PROFILE=ok");

  const rejected = await rawTool(100, "update_profile", {
    profile_id: profileId,
    proxy: { type: "http", host: "127.0.0.1", port: 0 },
  });
  if (!rejected.isError) throw new Error("Invalid proxy was unexpectedly accepted.");
  const afterReject = (await adapter.listProfiles()).find((profile) => profile.id === profileId);
  if (afterReject?.isRunning) throw new Error("Profile ran after failed proxy application.");
  console.log("FAILED_PROXY_PREVENTED_LAUNCH=ok");

  const proxy = {
    protocol: process.env.MKB00_PROXY_PROTOCOL,
    host: process.env.MKB00_PROXY_HOST,
    port: Number(process.env.MKB00_PROXY_PORT),
    ...(process.env.MKB00_PROXY_USERNAME ? { username: process.env.MKB00_PROXY_USERNAME } : {}),
    ...(password ? { password } : {}),
  };
  await adapter.applyProxy(profileId, proxy);
  console.log("UPDATE_PROFILE=ok");

  await adapter.launchProfile(profileId);
  const launched = (await adapter.listProfiles()).find((profile) => profile.id === profileId);
  if (!launched?.isRunning) throw new Error("Profile did not enter running state.");
  console.log("LAUNCH_PROFILE=ok");

  const navigation = await rawTool(101, "navigate", {
    profile_id: profileId,
    url: "https://api.ipify.org?format=json",
  });
  if (navigation.isError) throw new Error("Exit-IP navigation failed.");
  const extracted = await rawTool(102, "extract", { profile_id: profileId });
  if (extracted.isError) throw new Error("Exit-IP extraction failed.");
  const extractedText = extracted.content?.map((item) => item.text || "").join("\n") || "";
  if (!extractedText.includes(process.env.MKB00_EXPECTED_EXIT_IP)) {
    throw new Error("Observed exit IP did not match the expected proxy IP.");
  }
  console.log("PROXY_EXIT_IP_MATCH=ok");

  await adapter.closeProfile(profileId);
  const closed = (await adapter.listProfiles()).find((profile) => profile.id === profileId);
  if (closed?.isRunning) throw new Error("Profile remained running after close.");
  console.log("CLOSE_PROFILE=ok");
} catch (error) {
  console.error(`MKB00_MAC_SMOKE_ERROR=${redact(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
} finally {
  if (profileId) {
    await adapter.closeProfile(profileId).catch(() => {});
    const deleted = await rawTool(103, "delete_profile", { profile_id: profileId }).catch(() => null);
    console.log(`DISPOSABLE_PROFILE_DELETED=${Boolean(deleted && !deleted.isError)}`);
  }
}
NODE
```

Then run the focused Relay/adapter fail-closed tests:

```bash
npm test -- relay/src/handle-ticket.test.ts src/lib/antidetect/mkt-browser-adapter.test.ts
```

Acceptance:

- The script prints `ok` for list, fingerprint options, create, failed-proxy rejection, update,
  launch, exit-IP match, and close.
- The expected proxy IP matches without printing proxy credentials.
- The disposable profile is deleted and no account was used.
- The focused MKTTool tests pass and continue to assert that proxy-application failure never calls
  `launchProfile`.

## 6. Stop, inspect, and record

```bash
kill "$MKB00_APP_PID" 2>/dev/null || true
wait "$MKB00_APP_PID" 2>/dev/null || true
trap - EXIT

unset MKB00_MCP_TOKEN MKB00_PROXY_PASSWORD MKB00_PROXY_USERNAME
unset MKB00_PROXY_PROTOCOL MKB00_PROXY_HOST MKB00_PROXY_PORT MKB00_EXPECTED_EXIT_IP

pgrep -fl 'MultiZen|CloakBrowser|Chromium' || true
git -C "$MKTTOOL_ROOT" status --short
git status --short
```

Do not recursively delete the temporary user-data directory until its absolute path has been checked
and the evidence owner has decided whether to retain the engine cache. It must contain no account or
proxy credentials after the environment variables are unset.

Record only redacted facts:

- Mac model, chip, memory, macOS version, Node/Yarn versions.
- Source commit, tree, and lockfile hashes.
- App, native-module, and engine architectures.
- Exact engine version, official release URL, and archive checksum.
- MCP tool count and pass/fail for each required operation.
- Boolean proxy exit-IP match, not the proxy password.
- Build/runtime errors with bearer tokens and proxy credentials removed.

## Gate result

Pass the native-runtime portion of MKB-07 only when every acceptance item above is green on a real
Apple Silicon Mac and the Windows evidence remains green. If the app or engine runs through Rosetta,
the checksum or license cannot be confirmed, proxy application fails, exit IP differs, or a failed
update is followed by a launch, keep MKB-07 blocked. This future result does not change Windows v1
pilot or distribution approval.
