#!/usr/bin/env node

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} = require("node:fs");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(desktopRoot, "relay-release.json");
const payloadDir = path.join(desktopRoot, ".relay-payload");

function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Number.isSafeInteger(manifest.version) || manifest.version <= 0) {
    throw new Error("relay-release.json must contain a positive integer version.");
  }
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
    throw new Error("relay-release.json must contain a positive integer sizeBytes.");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error("relay-release.json must contain a lowercase SHA-256 digest.");
  }
  const url = new URL(manifest.url);
  if (url.protocol !== "https:" || !url.pathname.endsWith(`/v${manifest.version}`)) {
    throw new Error("Pinned Relay URL must be HTTPS and end with its immutable version.");
  }
  return { ...manifest, url: url.href };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

async function fetchPinnedRelay(options = {}) {
  const manifest = readManifest();
  mkdirSync(payloadDir, { recursive: true });
  const finalPath = path.join(payloadDir, `MKTTool-Relay-v${manifest.version}.zip`);
  const partialPath = `${finalPath}.partial`;
  const localArchive = process.env.MKTTOOL_RELAY_ARCHIVE?.trim();

  if (localArchive) {
    if (!existsSync(localArchive)) throw new Error(`Local pinned Relay archive not found: ${localArchive}`);
    if (statSync(localArchive).size !== manifest.sizeBytes) {
      throw new Error(`Pinned Relay size mismatch: expected ${manifest.sizeBytes} bytes.`);
    }
    const actual = await sha256(localArchive);
    if (actual !== manifest.sha256) {
      throw new Error(`Pinned Relay checksum mismatch: expected ${manifest.sha256}, received ${actual}.`);
    }
    // Stage local inputs exactly like the network path: never expose a partially copied archive at
    // the final name, and hash the copied bytes (not only the source) before the atomic rename.
    rmSync(partialPath, { force: true });
    try {
      copyFileSync(localArchive, partialPath);
      const copiedSize = statSync(partialPath).size;
      const copiedSha256 = await sha256(partialPath);
      if (copiedSize !== manifest.sizeBytes || copiedSha256 !== manifest.sha256) {
        throw new Error(`Copied pinned Relay bytes changed during staging (size ${copiedSize}, SHA-256 ${copiedSha256}).`);
      }
      rmSync(finalPath, { force: true });
      renameSync(partialPath, finalPath);
    } catch (error) {
      rmSync(partialPath, { force: true });
      throw error;
    }
    return { manifest, archivePath: finalPath };
  }

  if (existsSync(finalPath)) {
    if (statSync(finalPath).size === manifest.sizeBytes && (await sha256(finalPath)) === manifest.sha256) {
      return { manifest, archivePath: finalPath };
    }
    rmSync(finalPath, { force: true });
  }

  const start = existsSync(partialPath) ? statSync(partialPath).size : 0;
  const headers = { ...(options.headers ?? {}) };
  // A token scoped to this one route, not a human's session cookie. A cookie unlocks the whole
  // app including the identity vault, expires mid-build, and dies when that person leaves the
  // team. See MKTTool/src/lib/relay/release-download-token.ts for the server side.
  const releaseToken = process.env.MKTTOOL_RELEASE_TOKEN?.trim();
  if (releaseToken) headers.Authorization = `Bearer ${releaseToken}`;
  if (start > 0) headers.Range = `bytes=${start}-`;
  const response = await (options.fetchImpl ?? fetch)(manifest.url, { headers, redirect: "error" });
  if (!(response.status === 200 || (start > 0 && response.status === 206)) || !response.body) {
    throw new Error(`Pinned Relay download failed closed with HTTP ${response.status}.`);
  }
  if (start > 0 && response.status !== 206) {
    throw new Error("Pinned Relay server ignored the resume Range request.");
  }

  await pipeline(response.body, createWriteStream(partialPath, { flags: start > 0 ? "a" : "w" }));
  const downloadedSize = statSync(partialPath).size;
  if (downloadedSize !== manifest.sizeBytes) {
    rmSync(partialPath, { force: true });
    throw new Error(`Pinned Relay size mismatch: expected ${manifest.sizeBytes} bytes, received ${downloadedSize}.`);
  }
  const actual = await sha256(partialPath);
  if (actual !== manifest.sha256) {
    rmSync(partialPath, { force: true });
    throw new Error(`Pinned Relay checksum mismatch: expected ${manifest.sha256}, received ${actual}.`);
  }
  renameSync(partialPath, finalPath);
  return { manifest, archivePath: finalPath };
}

if (require.main === module) {
  fetchPinnedRelay()
    .then(({ manifest, archivePath }) => process.stdout.write(`Verified Relay v${manifest.version}: ${archivePath}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { fetchPinnedRelay, readManifest };
