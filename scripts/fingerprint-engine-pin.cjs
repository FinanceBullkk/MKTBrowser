const { lstat, readFile } = require("node:fs/promises");
const path = require("node:path");

const HISTORICAL_ENGINE_VERSION = "151.0.7922.108.2";
const HISTORICAL_ENGINE_SHA256 = "7b16ae3070bfcbed9cd381d03d1a8d57a8baf8f4540650397d620eb8dbe89561";
const VERSION = /^\d+(?:\.\d+){2,4}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function requestedFingerprintEngine(args) {
  const explicitVersion = Object.hasOwn(args, "engine-version");
  const explicitSha256 = Object.hasOwn(args, "engine-sha256");
  if (explicitVersion !== explicitSha256) {
    throw new Error(
      "Pass --engine-version and --engine-sha256 together; partial engine overrides are refused.",
    );
  }
  const version = explicitVersion ? args["engine-version"] : HISTORICAL_ENGINE_VERSION;
  const sha256 = explicitSha256 ? args["engine-sha256"] : HISTORICAL_ENGINE_SHA256;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("--engine-version must be a numeric engine version.");
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new Error("--engine-sha256 must contain exactly 64 hexadecimal characters.");
  }
  return { version, sha256: sha256.toLowerCase(), explicit: explicitVersion };
}

function sanitizedPin(pin) {
  try {
    if (
      pin?.schemaVersion !== 1 ||
      !Number.isSafeInteger(pin.sequence) ||
      pin.sequence <= 0 ||
      pin.engineKind !== "cloakbrowser" ||
      typeof pin.version !== "string" ||
      !VERSION.test(pin.version) ||
      typeof pin.sha256 !== "string" ||
      !SHA256.test(pin.sha256) ||
      !Number.isSafeInteger(pin.sizeBytes) ||
      pin.sizeBytes <= 0 ||
      typeof pin.url !== "string"
    )
      throw new Error("Invalid shape");
    const url = new URL(pin.url);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return {
      schemaVersion: 1,
      sequence: pin.sequence,
      engineKind: pin.engineKind,
      version: pin.version,
      url: url.href,
      archive: path.posix.basename(url.pathname),
      sha256: pin.sha256.toLowerCase(),
      sizeBytes: pin.sizeBytes,
    };
  } catch {
    throw new Error(
      "active-engine.json is invalid; restore a verified compatibility activation before measurement.",
    );
  }
}

async function readLocalJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // JSON parser and filesystem errors can echo credentials or signed URLs from local metadata.
    throw new Error(
      `${label} is missing or unreadable; measurement stopped before any browser launch.`,
    );
  }
}

async function inspectFingerprintEnginePin(args, { localAppData = process.env.LOCALAPPDATA } = {}) {
  const expected = requestedFingerprintEngine(args);
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error(
      "LOCALAPPDATA must identify the local compatibility authority and engine cache.",
    );
  }
  const authority = sanitizedPin(
    await readLocalJson(
      path.join(localAppData, "MKTTool", "compatibility-updater", "active-engine.json"),
      "active-engine.json",
    ),
  );
  // sanitizedPin already fails closed on any engine other than CloakBrowser.
  if (authority.version !== expected.version || authority.sha256 !== expected.sha256) {
    throw new Error(
      `Fingerprint engine pin drift: ${expected.explicit ? "requested" : "historical default"} ` +
        `${expected.version} differs from active-engine.json (${authority.version}, sequence ${authority.sequence}). ` +
        `Review the local pin, then pass --engine-version ${authority.version} --engine-sha256 ${authority.sha256}.`,
    );
  }
  const sourceRoot = path.join(localAppData, "MKTTool", "MKTBrowser", "chromium", "cloakbrowser");
  const cache = await readLocalJson(
    path.join(sourceRoot, "current.json"),
    "Engine cache current.json",
  );
  if (
    cache?.version !== expected.version ||
    cache.sha256 !== expected.sha256 ||
    typeof cache.binaryRelative !== "string" ||
    !/^runtime[\\/]chrome\.exe$/i.test(cache.binaryRelative)
  ) {
    throw new Error(
      "Engine cache does not match the requested version and SHA-256 in active-engine.json.",
    );
  }
  const runtimeRoot = path.join(sourceRoot, "runtime");
  const runtime = await readLocalJson(
    path.join(runtimeRoot, ".mkt-runtime.json"),
    "Engine runtime metadata",
  );
  if (runtime?.version !== expected.version) {
    throw new Error("Engine runtime version does not match active-engine.json.");
  }
  const [directory, binary] = await Promise.all([
    lstat(runtimeRoot).catch(() => null),
    lstat(path.join(runtimeRoot, "chrome.exe")).catch(() => null),
  ]);
  if (
    !directory?.isDirectory() ||
    directory.isSymbolicLink() ||
    !binary?.isFile() ||
    binary.isSymbolicLink()
  ) {
    throw new Error(
      "Engine cache runtime is incomplete or linked; measurement stopped before any browser launch.",
    );
  }
  return {
    version: expected.version,
    archiveSha256: expected.sha256,
    sourceRoot,
    authority,
    verification:
      "Local pin and cache metadata agree; this check does not revalidate signatures or establish acceptance.",
  };
}

module.exports = { inspectFingerprintEnginePin, requestedFingerprintEngine };
