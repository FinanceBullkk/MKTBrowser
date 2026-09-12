/*
 * Behavioural coverage for build/windows-install-relay-payload.ps1.
 *
 * This script is the last link in the Relay supply chain and the only one that runs on the
 * operator's machine. Everything before it -- the download, the executable pin inside the archive,
 * the staged copy, the packaged tree -- is verified on the build machine, where the bytes are
 * already known good. The interesting question is therefore not "does the pinned archive install"
 * but "does a payload that no longer matches its pin get rejected before anything is extracted or
 * executed", which is why every failure case below asserts that install-relay.ps1 never ran.
 *
 * Both PowerShell hosts are exercised. NSIS is a 32-bit application, so the powershell.exe it
 * launches is the 32-bit host under WOW64; a defect that only reproduces there has shipped before
 * (see windows-relay-cleanup.test.cjs), so neither host is assumed to stand in for the other.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const script = join(__dirname, "..", "build", "windows-install-relay-payload.ps1");
const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";

const POWERSHELL_HOSTS = [
  ["native host", join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  [
    "32-bit host, as NSIS launches it",
    join(windowsRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ],
];

/**
 * The marker the bundled installer writes. Its absence is the assertion that matters in every
 * rejection case: a payload that fails its pin must not reach `& $installer`.
 */
const INSTALLER_MARKER = "install-relay-ran.txt";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Build a real archive containing a real install-relay.ps1, because a fixture that skips the
 * extraction step cannot tell a rejected payload from an accepted one.
 */
function buildRelayArchive(powershell, root) {
  const contents = join(root, "archive-contents");
  mkdirSync(contents, { recursive: true });
  // Records that it ran, and that the caller set the flag the real installer honours.
  writeFileSync(
    join(contents, "install-relay.ps1"),
    'Set-Content -LiteralPath (Join-Path $env:MKT_RELAY_TEST_OUTPUT "' +
      INSTALLER_MARKER +
      '") -Value $env:RELAY_SKIP_BROWSER\nexit 0\n',
    "utf8",
  );

  const archive = join(root, "MKTTool-Relay.zip");
  execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path (Join-Path '${contents}' '*') -DestinationPath '${archive}' -Force`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  return archive;
}

/**
 * Stage a payload directory shaped exactly like `$INSTDIR\resources\relay`: the archive beside the
 * manifest that pins it. `manifest` overrides let a test describe one specific mismatch.
 */
function stagePayload(t, powershell, { manifest: overrides = {}, tamper = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-payload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = buildRelayArchive(powershell, root);
  const bytes = readFileSync(archive);

  writeFileSync(
    join(root, "relay-release.json"),
    `${JSON.stringify({ version: 17, sizeBytes: bytes.length, sha256: sha256(bytes), ...overrides }, null, 2)}\n`,
    "utf8",
  );

  // After the pin is recorded, so the manifest describes the honest archive and the tampering is
  // exactly the divergence under test. Compress-Archive embeds timestamps, so pinning a separately
  // built archive would not be reproducible.
  if (tamper) tamper(archive);

  const staging = mkdtempSync(join(tmpdir(), "mkt-relay-staging-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));

  return { root, archive, staging, markerPath: join(root, INSTALLER_MARKER) };
}

/**
 * Build an archive carrying a path-traversal entry alongside a normal installer, and pin the
 * manifest to those exact bytes.
 *
 * Pinning the hostile archive is the point: after the digest check above, the only way a traversal
 * entry reaches the extractor is inside an archive that matches its pin, which is a compromised
 * build input rather than a file swapped on the operator's disk. A fixture that left the hash
 * mismatched would be rejected one step earlier and prove nothing about extraction.
 */
function stageTraversalPayload(t, powershell, escapedName) {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-traversal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = join(root, "MKTTool-Relay.zip");
  const build = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [IO.Compression.ZipFile]::Open('${archive}', 'Create')`,
    "$writer = New-Object IO.StreamWriter ($zip.CreateEntry('install-relay.ps1')).Open()",
    `$writer.Write('Set-Content -LiteralPath (Join-Path $env:MKT_RELAY_TEST_OUTPUT "${INSTALLER_MARKER}") -Value 1')`,
    "$writer.Dispose()",
    `$escape = New-Object IO.StreamWriter ($zip.CreateEntry('${escapedName}')).Open()`,
    "$escape.Write('escaped')",
    "$escape.Dispose()",
    "$zip.Dispose()",
  ].join("; ");
  execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", build],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );

  const bytes = readFileSync(archive);
  writeFileSync(
    join(root, "relay-release.json"),
    `${JSON.stringify({ version: 17, sizeBytes: bytes.length, sha256: sha256(bytes) }, null, 2)}\n`,
    "utf8",
  );

  const staging = mkdtempSync(join(tmpdir(), "mkt-relay-staging-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));

  return { root, archive, staging, markerPath: join(root, INSTALLER_MARKER) };
}

function runPayloadInstall(powershell, { archive, staging, root }) {
  return execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ArchivePath",
      archive,
      "-StagingDirectory",
      staging,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, MKT_RELAY_TEST_OUTPUT: root },
    },
  );
}

/** Run and require a rejection, returning the combined diagnostics for the token assertion. */
function expectRejection(powershell, payload) {
  try {
    runPayloadInstall(powershell, payload);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail("the payload installer should have refused this archive");
}

for (const [label, powershell] of POWERSHELL_HOSTS) {
  const hostAvailable = { skip: process.platform !== "win32" || !existsSync(powershell) };

  test(`installs a payload matching its pinned manifest from the ${label}`, hostAvailable, (t) => {
    const payload = stagePayload(t, powershell);

    runPayloadInstall(powershell, payload);

    assert.equal(existsSync(payload.markerPath), true, "install-relay.ps1 should have run");
    assert.equal(
      readFileSync(payload.markerPath, "utf8").trim(),
      "1",
      "the bundled installer should see RELAY_SKIP_BROWSER=1",
    );
  });

  test(`refuses an archive whose bytes no longer match the pin from the ${label}`, hostAvailable, (t) => {
    // Same length, different content: the size check cannot catch this, so only the hash can.
    const payload = stagePayload(t, powershell, {
      tamper: (archive) => {
        const bytes = readFileSync(archive);
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(archive, bytes);
      },
    });

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-archive-checksum-mismatch/);
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });

  test(`refuses an archive whose size does not match the pin from the ${label}`, hostAvailable, (t) => {
    const payload = stagePayload(t, powershell, { manifest: { sizeBytes: 4 } });

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-archive-size-mismatch/);
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });

  test(`refuses to install when the pinned manifest is absent from the ${label}`, hostAvailable, (t) => {
    const payload = stagePayload(t, powershell);
    rmSync(join(payload.root, "relay-release.json"), { force: true });

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-manifest-missing/);
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });

  test(`refuses a manifest without a usable pin from the ${label}`, hostAvailable, (t) => {
    // A syntactically valid manifest carrying no digest must fail closed rather than skip the check.
    const payload = stagePayload(t, powershell, { manifest: { sha256: "not-a-digest" } });

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-manifest-invalid/);
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });

  test(`refuses an archive entry that escapes the staging directory from the ${label}`, hostAvailable, (t) => {
    const payload = stageTraversalPayload(t, powershell, "../escaped-by-traversal.txt");
    // Where the entry would land if the extractor honoured it.
    const escapedPath = join(payload.staging, "..", "escaped-by-traversal.txt");
    t.after(() => rmSync(escapedPath, { force: true }));

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-archive-entry-escapes-staging/);
    assert.equal(existsSync(escapedPath), false, "the traversal entry must not have been written");
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });

  test(`refuses a traversal entry before writing any part of the archive from the ${label}`, hostAvailable, (t) => {
    // Paths are validated for the whole archive before extraction starts, so a rejected archive
    // leaves nothing behind -- including the benign entries listed ahead of the hostile one.
    const payload = stageTraversalPayload(t, powershell, "../escaped-partial.txt");
    const escapedPath = join(payload.staging, "..", "escaped-partial.txt");
    t.after(() => rmSync(escapedPath, { force: true }));

    expectRejection(powershell, payload);

    assert.equal(
      existsSync(join(payload.staging, "install-relay.ps1")),
      false,
      "no entry should have been extracted from a rejected archive",
    );
  });

  test(`refuses a manifest that is not readable JSON from the ${label}`, hostAvailable, (t) => {
    const payload = stagePayload(t, powershell);
    writeFileSync(join(payload.root, "relay-release.json"), "{ truncated", "utf8");

    const diagnostics = expectRejection(powershell, payload);

    assert.match(diagnostics, /relay-manifest-invalid/);
    assert.equal(existsSync(payload.markerPath), false, "install-relay.ps1 must not have run");
  });
}
