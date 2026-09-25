const assert = require("node:assert/strict");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

const MKTTOOL_FILES = [
  "src/lib/setup/windows-installer-release.ts",
  "src/lib/setup/windows-installer-release-metadata.ts",
  "src/lib/setup/windows-installer-candidate.ts",
];

/**
 * Resolve the sibling MKTTool checkout used by the cross-repository contract.
 *
 * CI checks out MKTTool into an explicit `MKTTOOL_ROOT` path.  Local runs historically relied on a
 * case-sensitive `../MKTTool` sibling, while a number of runners use a nested `mkttool` checkout.
 * An explicitly supplied root is authoritative and is never silently replaced with another tree.
 */
function resolveMktToolRoot(environment = process.env) {
  const explicit =
    typeof environment.MKTTOOL_ROOT === "string" ? environment.MKTTOOL_ROOT.trim() : "";
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.resolve(repoRoot, "..", "MKTTool"),
        path.resolve(repoRoot, "..", "mkttool"),
        environment.GITHUB_WORKSPACE ? path.resolve(environment.GITHUB_WORKSPACE, "mkttool") : null,
        path.resolve(repoRoot, "mkttool"),
      ].filter(Boolean);
  for (const candidate of candidates) {
    if (MKTTOOL_FILES.every((relativePath) => existsSync(path.join(candidate, relativePath)))) {
      return candidate;
    }
  }
  throw new Error(
    `MKTTool checkout not found. Set MKTTOOL_ROOT to a checkout containing ${MKTTOOL_FILES.join(
      " and ",
    )}. Tried: ${candidates.join(", ")}`,
  );
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

/** Dựng regex từ một hằng viết tay: dấu chấm trong "0.3.24" phải là dấu chấm, không phải ký tự bất kỳ. */
function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCandidateEngine(candidate, engine) {
  for (const [field, expected] of Object.entries({
    engineKind: engine.engineKind, engineChannel: engine.source, engineVersion: engine.version,
    engineSha256: engine.sha256, engineSizeBytes: engine.sizeBytes,
  })) {
    const match = new RegExp(`^\\s*${field}:\\s*("[^"]*"|[0-9]+),\\s*$`, "m").exec(candidate);
    assert.ok(match, `Missing exact candidate field ${field}`);
    assert.equal(JSON.parse(match[1]), expected, `Candidate field ${field} differs from Browser pin`);
  }
}

function assertCandidateRelay(candidate, relay) {
  for (const [field, expected] of Object.entries({
    relayVersion: relay.version,
    relaySha256: relay.sha256,
    relaySizeBytes: relay.sizeBytes,
  })) {
    const match = new RegExp(`^\\s*${field}:\\s*("[^"]*"|[0-9]+),\\s*$`, "m").exec(candidate);
    assert.ok(match, `Missing exact candidate field ${field}`);
    assert.equal(JSON.parse(match[1]), expected, `Candidate field ${field} differs from Browser Relay pin`);
  }
}

test("keeps the Windows candidate version and pinned Relay coherent", () => {
  const root = readJson("package.json");
  const desktop = readJson("apps/desktop/package.json");
  const relay = readJson("apps/desktop/relay-release.json");
  // Hai mỏ neo của bộ tuple, và chúng CỐ Ý viết tay. Đọc phiên bản ra từ `package.json` sẽ biến
  // phép kiểm này thành phép tự soi gương: nâng `package.json` một mình là đủ để nó xanh, trong
  // khi thứ nó canh chính là "không ai được nâng phiên bản ở đúng một chỗ". Nâng bộ tuple nghĩa
  // là sửa hai dòng ngay dưới đây, chạy lại, rồi để từng assert chỉ ra chỗ nào chưa theo kịp.
  const expectedVersion = "0.3.27";
  const expectedRelayVersion = "20";
  const expectedCandidateId = "20260925-browser-0.3.27-relay-20-cold-start-tls-profiles-cft";

  // Mỏ neo phải tự nhất quán trước khi có tư cách phán xử chỗ khác.
  assert.ok(
    expectedCandidateId.includes(expectedVersion),
    `Candidate ID ${expectedCandidateId} does not carry version ${expectedVersion}: the tuple was bumped in one place only.`,
  );

  assert.equal(root.version, expectedVersion, "root package version drifted");
  assert.equal(desktop.version, expectedVersion, "desktop package version drifted");
  assert.equal(String(relay.version), expectedRelayVersion, "the candidate Relay version drifted");
  assert.equal(relay.sizeBytes, 35123197);
  assert.equal(relay.sha256, "e749be841cac37916d0d9a3de37a652ed4e4c83db3bfbcb9e98d6cf8827439ff");
  assert.match(relay.url, new RegExp(`/api/relay/download/v${expectedRelayVersion}$`));

  const proxyGeo = readFileSync(path.join(repoRoot, "apps/desktop/src/main/proxyGeo.ts"), "utf8");
  assert.match(
    proxyGeo,
    new RegExp(`MKTBrowser/${escapeForRegExp(expectedVersion)}`),
    `apps/desktop/src/main/proxyGeo.ts does not announce MKTBrowser/${expectedVersion}.`,
  );

  const mktToolRoot = resolveMktToolRoot();
  const mktToolReader = readFileSync(path.join(mktToolRoot, MKTTOOL_FILES[0]), "utf8");
  const staleSibling =
    `Checked MKTTool at ${mktToolRoot}. Either MKTTool changed shape, or this checkout is not ` +
    `the one Browser ${expectedVersion} was frozen against - a stale side, not a typo.`;
  assert.match(
    mktToolReader,
    /EXPECTED_WINDOWS_INSTALLER_VERSION = WINDOWS_INSTALLER_CANDIDATE\.browserVersion/,
    `${MKTTOOL_FILES[0]} no longer derives the installer version from the candidate. ${staleSibling}`,
  );
  assert.match(
    mktToolReader,
    /EXPECTED_WINDOWS_INSTALLER_CANDIDATE_ID = WINDOWS_INSTALLER_CANDIDATE\.id/,
    `${MKTTOOL_FILES[0]} no longer derives the candidate ID from the candidate. ${staleSibling}`,
  );
  const candidate = readFileSync(path.join(mktToolRoot, MKTTOOL_FILES[2]), "utf8");
  assert.match(
    candidate,
    new RegExp(`id: "${escapeForRegExp(expectedCandidateId)}"`),
    `MKTTool does not name candidate ${expectedCandidateId}. ${staleSibling}`,
  );
  assert.match(
    candidate,
    new RegExp(`browserVersion: "${escapeForRegExp(expectedVersion)}"`),
    `MKTTool does not name browser version ${expectedVersion}. ${staleSibling}`,
  );
  assertCandidateRelay(candidate, relay);
  const engine = readJson("apps/desktop/windows-engine-release.json");
  assertCandidateEngine(candidate, engine);
  const mktToolMetadata = readFileSync(path.join(mktToolRoot, MKTTOOL_FILES[1]), "utf8");
  assert.match(mktToolMetadata, /payloadManifestSha256/);
  assert.match(mktToolMetadata, /payloadFileCount/);
  const typesSource = readFileSync(
    path.join(repoRoot, "packages", "types", "src", "index.ts"),
    "utf8",
  );
  assert.match(typesSource, /MKT_BROWSER_MCP_PROTOCOL_VERSION/);
  assert.match(typesSource, /MKT_BROWSER_MCP_SERVER_VERSION = MKT_BROWSER_MCP_PROTOCOL_VERSION/);

  // The generated evidence is intentionally checked when present. A stale ignored output is
  // contamination, not a harmless cache: it must be rebuilt or quarantined before promotion.
  const evidencePath = path.join(
    repoRoot,
    "apps/desktop/release/installer/windows-compatibility-artifacts.json",
  );
  if (existsSync(evidencePath)) {
    const evidence = readJson(
      "apps/desktop/release/installer/windows-compatibility-artifacts.json",
    );
    assert.equal(evidence.browserVersion, expectedVersion, "generated installer evidence is stale");
    assert.equal(evidence.artifacts.relay.version, expectedRelayVersion, "generated Relay evidence is stale");
  }
});

test("engine coherence is field-bound even when the candidate ID still contains cft", () => {
  const candidate = readFileSync(path.join(resolveMktToolRoot(), MKTTOOL_FILES[2]), "utf8");
  const engine = readJson("apps/desktop/windows-engine-release.json");
  const changed = candidate.replace('engineKind: "cft"', 'engineKind: "cloakbrowser"');
  assert.notEqual(changed, candidate);
  assert.ok(changed.includes("cft"));
  assert.throws(() => assertCandidateEngine(changed, engine), /engineKind differs/);
});

test("Relay coherence is field-bound for every candidate artifact field", () => {
  const candidate = readFileSync(path.join(resolveMktToolRoot(), MKTTOOL_FILES[2]), "utf8");
  const relay = readJson("apps/desktop/relay-release.json");
  const mutations = {
    relayVersion: relay.version + 1,
    relaySha256: relay.sha256 === "0".repeat(64) ? `1${"0".repeat(63)}` : "0".repeat(64),
    relaySizeBytes: relay.sizeBytes + 1,
  };

  for (const [field, replacement] of Object.entries(mutations)) {
    const expression = new RegExp(`^(\\s*${field}:\\s*)("[^"]*"|[0-9]+)(,\\s*)$`, "m");
    const changed = candidate.replace(expression, `$1${JSON.stringify(replacement)}$3`);
    assert.notEqual(changed, candidate, `fixture did not mutate ${field}`);
    assert.throws(
      () => assertCandidateRelay(changed, relay),
      new RegExp(`${field} differs from Browser Relay pin`),
    );
  }
});

test("honours an explicit MKTTOOL_ROOT and rejects a missing checkout", () => {
  // Keep this unit test independent from the host checkout layout.  CI places the sibling
  // repository under `mkttool`, while local runs may use `MKTTool`; neither should be required
  // merely to prove that an explicit root is authoritative.
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mktbrowser-mkttool-contract-"));
  try {
    for (const relativePath of MKTTOOL_FILES) {
      const fixturePath = path.join(fixtureRoot, relativePath);
      mkdirSync(path.dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, "// contract fixture\n");
    }
    assert.equal(
      resolveMktToolRoot({ MKTTOOL_ROOT: fixtureRoot }),
      path.resolve(fixtureRoot),
    );
    assert.throws(
      () => resolveMktToolRoot({ MKTTOOL_ROOT: path.join(fixtureRoot, "does-not-exist") }),
      /MKTTool checkout not found.*MKTTOOL_ROOT/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("packaging derives the control contract version from the package metadata", () => {
  const source = readFileSync(
    path.join(repoRoot, "apps/desktop/scripts/emit-windows-compatibility-evidence.cjs"),
    "utf8",
  );
  assert.match(source, /appVersion: packageJson\.version/);
  assert.match(source, /browserVersion: packageJson\.version/);
});

test("attestation workflow requires and forwards the immutable candidate ID", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  assert.match(workflow, /candidate_id:/);
  assert.match(workflow, /MKT_RELEASE_CANDIDATE_ID: \$\{\{ inputs\.candidate_id \}\}/);
  assert.match(workflow, /--candidate-id "\$MKT_RELEASE_CANDIDATE_ID"/);
  assert.match(workflow, /--engine-release/);
});

module.exports = { resolveMktToolRoot };
