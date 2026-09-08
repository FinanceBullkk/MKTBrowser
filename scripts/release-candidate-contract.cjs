#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const APPROVED_ENGINE = Object.freeze(require("../apps/desktop/windows-engine-release.json"));

const EXPECTED_RELAY = Object.freeze({
  version: 17,
  sizeBytes: 34289393,
  sha256: "d8bf25dcb446d779bd5461419ea7562044e280ac1d16592a71a52f156f6359cf",
  urlSuffix: "/api/relay/download/v17",
});
const FORBIDDEN_RELAY_HASHES = Object.freeze([
  "cfeefc7f1284492a64f5cf8b29603b3e9a36e5d488ac676d2d109b2c4364b261",
  "eb37eb544ef87b772185272aa2de4cf23000f2e2fbd92f6bde99a20e47b210d1",
]);
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertEnginePin(engine) {
  const fields = ["engineKind", "source", "version", "url", "sha256", "sizeBytes"];
  if (!engine || fields.some((field) => engine[field] !== APPROVED_ENGINE[field])) {
    throw new Error("The engine does not match the reviewed CFT profile-manager release tuple.");
  }
}

function assertRelayPin(repoRoot) {
  const filePath = path.join(repoRoot, "apps", "desktop", "relay-release.json");
  if (!existsSync(filePath)) throw new Error(`Relay release metadata is missing: ${filePath}`);
  const relay = readJson(filePath);
  if (relay.version !== EXPECTED_RELAY.version) {
    throw new Error(
      `Release candidate must pin Relay v${EXPECTED_RELAY.version}; found ${relay.version}.`,
    );
  }
  if (relay.sizeBytes !== EXPECTED_RELAY.sizeBytes || relay.sha256 !== EXPECTED_RELAY.sha256) {
    throw new Error(`Relay v${EXPECTED_RELAY.version} size/SHA does not match the immutable approved payload.`);
  }
  if (typeof relay.url !== "string" || !relay.url.endsWith(EXPECTED_RELAY.urlSuffix)) {
    throw new Error(
      `Relay release URL must resolve to the immutable ${EXPECTED_RELAY.urlSuffix} object.`,
    );
  }
  if (FORBIDDEN_RELAY_HASHES.includes(String(relay.sha256).toLowerCase())) {
    throw new Error("Known-bad Relay v15 payload hash is present in the candidate.");
  }
  return relay;
}

function candidateFiles(repoRoot) {
  const files = [
    "package.json",
    path.join("apps", "desktop", "package.json"),
    path.join("apps", "desktop", "relay-release.json"),
    path.join("apps", "desktop", "release", "installer", "windows-compatibility-artifacts.json"),
    path.join("apps", "desktop", "release", "installer", "windows-control-contract.json"),
    "release-provenance.json",
  ].map((relativePath) => path.join(repoRoot, relativePath));
  const installerRoot = path.join(repoRoot, "apps", "desktop", "release", "installer");
  if (existsSync(installerRoot)) {
    files.push(
      ...walkFiles(installerRoot).filter((filePath) =>
        /[.](?:json|manifest|yml|yaml|txt)$/i.test(filePath),
      ),
    );
  }
  return [...new Set(files)];
}

function assertNoBadTuple(repoRoot, extraPaths = []) {
  const files = [...candidateFiles(repoRoot), ...extraPaths].filter((filePath) =>
    existsSync(filePath),
  );
  for (const filePath of files) {
    const text = readFileSync(filePath, "utf8");
    const badHash = FORBIDDEN_RELAY_HASHES.find((hash) => text.toLowerCase().includes(hash));
    if (badHash) throw new Error(`Known-bad Relay hash ${badHash} appears in ${filePath}.`);
    // Restrict the version check to structured candidate fields. Dependency versions such as
    // `@jridgewell/gen-mapping@^0.3.12` are unrelated and must not make the guard noisy.
    if (
      /(?:"(?:version|browserVersion|installerVersion)"\s*:\s*|installerVersion\s*[=:]\s*)["']?0\.3\.12\b/.test(
        text,
      )
    ) {
      throw new Error(`Quarantined installer version 0.3.12 appears in ${filePath}.`);
    }
  }
}

function walkFiles(root, files = []) {
  if (!existsSync(root)) return files;
  const stats = statSync(root);
  if (stats.isFile()) {
    files.push(root);
    return files;
  }
  for (const name of readdirSync(root)) walkFiles(path.join(root, name), files);
  return files;
}

function assertPackagedEnginePinned(repoRoot, packageDirectory) {
  const pinSource = readFileSync(
    path.join(repoRoot, "apps", "desktop", "src", "main", "compatibility-engine-pin.ts"),
    "utf8",
  );
  if (
    !/!options\.isPackaged\s*&&\s*options\.environmentEnabled\s*&&\s*options\.hasExplicitUserDataDir/.test(
      pinSource,
    )
  ) {
    throw new Error(
      "Unpinned engine allowance is not restricted to an explicit disposable development run.",
    );
  }

  if (!packageDirectory) return { checked: false };
  if (!existsSync(packageDirectory))
    throw new Error(`Packaged directory does not exist: ${packageDirectory}`);
  const files = walkFiles(packageDirectory);
  for (const filePath of files) {
    const basename = path.basename(filePath).toLowerCase();
    if (!/[.](?:asar|json|js|cjs|mjs|yml|yaml|txt|ini|cfg|env|ps1|cmd|bat)$/i.test(basename))
      continue;
    const text = readFileSync(filePath, "utf8");
    if (/MKT_BROWSER_ALLOW_UNPINNED_ENGINE["']?\s*(?:=|:|\?\s*:?)\s*["']?1\b/.test(text)) {
      throw new Error(`Packaged payload enables MKT_BROWSER_ALLOW_UNPINNED_ENGINE: ${filePath}`);
    }
    if (/MKT_BROWSER_SYSTEM_CHROME["']?\s*(?:=|:)/.test(text)) {
      throw new Error(`Packaged payload exposes the system Chrome verifier override: ${filePath}`);
    }
    if (/allowUnpinnedManifest\s*:\s*true/.test(text)) {
      throw new Error(`Packaged payload enables an unpinned engine manifest: ${filePath}`);
    }
    let markerAt = text.indexOf("MKT_BROWSER_ALLOW_UNPINNED_ENGINE");
    while (markerAt >= 0) {
      const context = text.slice(Math.max(0, markerAt - 800), markerAt + 500);
      if (!context.includes("isPackaged") || !context.includes("hasExplicitUserDataDir")) {
        throw new Error(`Packaged unpinned-engine reference is not development-only: ${filePath}`);
      }
      markerAt = text.indexOf("MKT_BROWSER_ALLOW_UNPINNED_ENGINE", markerAt + 1);
    }
    if (
      /CHROMIUM_SWITCH_TO_CFT|Switch to Chrome for Testing/.test(text) &&
      !/compatibility fallback/i.test(text)
    ) {
      throw new Error(`Packaged CFT fallback is not labelled as compatibility-only: ${filePath}`);
    }
  }

  const metadataCandidates = [
    path.join(packageDirectory, "windows-compatibility-artifacts.json"),
    path.join(path.dirname(packageDirectory), "windows-compatibility-artifacts.json"),
  ];
  const metadataPath = metadataCandidates.find((candidate) => existsSync(candidate));
  if (!metadataPath) throw new Error("Packaged compatibility artifact metadata is missing.");
  assertEnginePin(readJson(metadataPath).artifacts?.engine);

  const relayMetadataPath = path.join(packageDirectory, "resources", "relay", "relay-release.json");
  if (!existsSync(relayMetadataPath)) throw new Error("Packaged Relay metadata is missing.");
  if (existsSync(relayMetadataPath)) {
    const relay = readJson(relayMetadataPath);
    if (relay.version !== EXPECTED_RELAY.version || relay.sha256 !== EXPECTED_RELAY.sha256) {
      throw new Error(`Packaged Relay metadata does not match the approved v${EXPECTED_RELAY.version} tuple.`);
    }
    const archivePath = path.join(packageDirectory, "resources", "relay", "MKTTool-Relay.zip");
    if (!existsSync(archivePath)) throw new Error("Packaged Relay archive is missing.");
    if (existsSync(archivePath)) {
      const stats = statSync(archivePath);
      const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
      if (stats.size !== EXPECTED_RELAY.sizeBytes || sha256 !== EXPECTED_RELAY.sha256) {
        throw new Error(`Packaged Relay archive bytes do not match the approved v${EXPECTED_RELAY.version} tuple.`);
      }
    }
  }
  return { checked: true, files: files.length };
}

function verifyReleaseCandidate({
  repoRoot = path.resolve(__dirname, ".."),
  packageDirectory,
} = {}) {
  const relay = assertRelayPin(repoRoot);
  assertEnginePin(readJson(path.join(repoRoot, "apps", "desktop", "windows-engine-release.json")));
  assertNoBadTuple(repoRoot);
  const engine = assertPackagedEnginePinned(repoRoot, packageDirectory);
  return { relay, engine };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--package-dir") options.packageDirectory = argv[++index];
    else if (name === "--repo-root") options.repoRoot = argv[++index];
    else throw new Error(`Unknown option: ${name}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const result = verifyReleaseCandidate(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `Release candidate contracts passed: Relay v${result.relay.version}; ` +
        `packaged engine checked=${result.engine.checked}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVED_ENGINE,
  EXPECTED_RELAY,
  FORBIDDEN_RELAY_HASHES,
  assertNoBadTuple,
  assertEnginePin,
  assertPackagedEnginePinned,
  assertRelayPin,
  parseArguments,
  verifyReleaseCandidate,
};
