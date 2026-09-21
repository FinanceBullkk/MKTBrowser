const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream, existsSync } = require("node:fs");
const { copyFile, mkdir, readdir, readFile, writeFile } = require("node:fs/promises");
const { once } = require("node:events");
const path = require("node:path");

const RUNTIME_FILES = new Set([
  ".mkt-runtime.json",
  "151.0.7922.108.manifest",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "chrome_elf.dll",
  "chrome_proxy.exe",
  "chrome_pwa_launcher.exe",
  "chrome_wer.dll",
  "chrome.dll",
  "chrome.exe",
  "chromedriver.exe",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "elevation_service.exe",
  "First Run",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "locales",
  "notification_helper.exe",
  "resources.pak",
  "setup.exe",
  "v8_context_snapshot.bin",
  "vk_swiftshader_icd.json",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
]);

async function seedVerifiedStableEngineCache({
  userData,
  expectedVersion,
  expectedArchiveSha256,
  sourceRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "MKTTool",
    "MKTBrowser",
    "chromium",
    "cloakbrowser",
  ),
}) {
  const metadata = JSON.parse(await readFile(path.join(sourceRoot, "current.json"), "utf8"));
  assert.equal(metadata.version, expectedVersion, "Installed engine cache does not match the requested pin.");
  assert.equal(
    metadata.sha256,
    expectedArchiveSha256,
    "Installed engine cache does not match the expected archive hash.",
  );
  assert.match(metadata.binaryRelative, /^runtime[\\/]chrome\.exe$/i);
  const sourceBinary = path.resolve(sourceRoot, metadata.binaryRelative);
  assert.ok(existsSync(sourceBinary), "Installed pinned engine runtime is incomplete.");

  const sourceRuntime = path.resolve(sourceRoot, "runtime");
  const destinationRoot = path.join(userData, "chromium", "cloakbrowser");
  const destinationRuntime = path.join(destinationRoot, "runtime");
  await mkdir(destinationRuntime, { recursive: true });
  await copyRuntimePayload(sourceRuntime, destinationRuntime);
  await writeFile(
    path.join(destinationRoot, "current.json"),
    `${JSON.stringify({
      version: metadata.version,
      sha256: metadata.sha256,
      binaryRelative: metadata.binaryRelative,
    }, null, 2)}\n`,
    "utf8",
  );
  const destinationBinary = path.resolve(destinationRoot, metadata.binaryRelative);
  const [sourceRuntimeSha256, copiedRuntimeSha256] = await Promise.all([
    sha256File(sourceBinary),
    sha256File(destinationBinary),
  ]);
  assert.equal(copiedRuntimeSha256, sourceRuntimeSha256, "Copied pinned runtime changed bytes.");
  return {
    version: metadata.version,
    archiveSha256: metadata.sha256,
    runtimeSha256: copiedRuntimeSha256,
  };
}

async function copyRuntimePayload(sourceRuntime, destinationRuntime) {
  const entries = await readdir(sourceRuntime, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Stable .2 runtime contains an unexpected symbolic link: ${entry.name}`);
    }
    if (!RUNTIME_FILES.has(entry.name)) {
      if (entry.isDirectory() && entry.name.startsWith("ttk-profile-")) continue;
      throw new Error(`Stable .2 runtime contains an unexpected entry: ${entry.name}`);
    }
    const source = path.join(sourceRuntime, entry.name);
    const destination = path.join(destinationRuntime, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryNoLinks(source, destination);
    } else if (entry.isFile()) {
      await copyFile(source, destination);
    } else {
      throw new Error(`Stable .2 runtime contains an unsupported entry: ${entry.name}`);
    }
  }
}

async function copyDirectoryNoLinks(source, destination) {
  await mkdir(destination, { recursive: false });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Stable .2 runtime contains an unexpected symbolic link: ${entry.name}`);
    }
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryNoLinks(sourceEntry, destinationEntry);
    } else if (entry.isFile()) {
      await copyFile(sourceEntry, destinationEntry);
    } else {
      throw new Error(`Stable .2 runtime contains an unsupported entry: ${entry.name}`);
    }
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

module.exports = { seedVerifiedStableEngineCache };
