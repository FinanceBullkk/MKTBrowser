const { createHash } = require("node:crypto");
const { createReadStream, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

async function emitWindowsCompatibilityEvidence(options) {
  const { desktopRoot, outputDirectory, engineReleasePath } = options;
  if (!engineReleasePath) {
    throw new Error(
      "MKT_BROWSER_ENGINE_RELEASE_FILE is required so Windows packaging cannot resolve an engine latest.",
    );
  }
  const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
  const typesSource = readFileSync(
    path.resolve(desktopRoot, "..", "..", "packages", "types", "src", "index.ts"),
    "utf8",
  );
  const engine = readEngineRelease(engineReleasePath);
  const contract = {
    schemaVersion: 1,
    type: "mktbrowser.windows-control-contract",
    appVersion: packageJson.version,
    contractVersion: readIntegerConstant(typesSource, "MKT_BROWSER_CONTRACT_VERSION"),
    profileSchemaVersion: readIntegerConstant(typesSource, "MKT_BROWSER_PROFILE_SCHEMA_VERSION"),
  };
  const contractPath = path.join(outputDirectory, "windows-control-contract.json");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

  const installerPath = path.join(outputDirectory, "MKTBrowser-win-x64.exe");
  const browserPayloadPath = path.join(outputDirectory, "win-unpacked", "resources", "app.asar");
  const relayPath = path.join(
    outputDirectory,
    "win-unpacked",
    "resources",
    "relay",
    "MKTTool-Relay.zip",
  );
  const relayMetadata = JSON.parse(
    readFileSync(
      path.join(outputDirectory, "win-unpacked", "resources", "relay", "relay-release.json"),
      "utf8",
    ),
  );
  const evidence = {
    schemaVersion: 1,
    type: "mktbrowser.windows-packaging-evidence",
    platform: "windows-x64",
    browserVersion: packageJson.version,
    artifacts: {
      installer: await describeFile(installerPath),
      browser: await describeFile(browserPayloadPath),
      relay: { ...(await describeFile(relayPath)), version: String(relayMetadata.version) },
      controlContract: {
        ...(await describeFile(contractPath)),
        version: String(contract.contractVersion),
      },
      engine,
    },
  };
  writeFileSync(
    path.join(outputDirectory, "windows-compatibility-artifacts.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return evidence;
}

async function describeFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { fileName: path.basename(filePath), sizeBytes: statSync(filePath).size, sha256: hash.digest("hex") };
}

function readEngineRelease(filePath) {
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  const identityIsSound =
    value.engineKind === "cloakbrowser" &&
    typeof value.version === "string" &&
    value.version &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256);
  if (!identityIsSound) {
    throw new Error("The pinned Windows engine release file is invalid.");
  }

  // A licensed engine is identified, not located. Its archive URL is presigned
  // and expires, so signing one into a durable artifact would record something
  // untrue by the time anyone read it — and it would buy nothing anyway,
  // because the binary enforces its own licence at launch, so no URL lets a
  // machine without a key use the engine. The digest is what carries weight.
  if (value.source === "licensed-channel") {
    if (value.engineKind !== "cloakbrowser") {
      throw new Error("Only a CloakBrowser engine release may come from the licensed channel.");
    }
    if (value.url !== undefined) {
      throw new Error(
        "A licensed engine release must not carry a URL: presigned links expire and cannot be signed over.",
      );
    }
    return value;
  }

  // Everything else is publicly fetchable and must say where from, so the
  // record stays enough on its own to re-obtain and re-verify the archive.
  if (typeof value.url !== "string" || new URL(value.url).protocol !== "https:") {
    throw new Error("The pinned Windows engine release file is invalid.");
  }
  return value;
}

function readIntegerConstant(source, name) {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  if (!match) throw new Error(`Cannot read ${name} from the runtime contract.`);
  return Number(match[1]);
}

module.exports = { emitWindowsCompatibilityEvidence, readEngineRelease, readIntegerConstant };
