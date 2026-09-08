const { createHash } = require("node:crypto");
const yauzl = require("yauzl");

/** Stream the executable inside the already hash-verified archive; never extract or execute it. */
function verifyRelayExecutablePin(archivePath, manifest) {
  if (!/^[0-9a-f]{64}$/.test(manifest.executableSha256 ?? "") ||
      !Number.isSafeInteger(manifest.executableSizeBytes) || manifest.executableSizeBytes <= 0 ||
      manifest.executableSizeBytes > 256 * 1024 * 1024) {
    return Promise.reject(new Error("Pinned Relay executable metadata is invalid."));
  }
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let matched = false;
      let failed = false;
      const fail = (failure) => { failed = true; zip.close(); reject(failure); };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed && matched) resolve();
        else if (!failed) reject(new Error("Pinned Relay executable is missing from the archive."));
      });
      zip.on("entry", (entry) => {
        if (entry.fileName.toLowerCase() !== "mkttool-relay.exe") { zip.readEntry(); return; }
        if (matched || entry.fileName !== "MKTTool-Relay.exe" || entry.uncompressedSize !== manifest.executableSizeBytes) {
          fail(new Error("Pinned Relay executable entry is ambiguous or has an invalid size."));
          return;
        }
        matched = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail(streamError); return; }
          const hash = createHash("sha256");
          let bytes = 0;
          stream.on("error", fail);
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > manifest.executableSizeBytes) {
              stream.destroy(new Error("Pinned Relay executable exceeds its expected size."));
              return;
            }
            hash.update(chunk);
          });
          stream.on("end", () => {
            if (failed) return;
            if (bytes !== manifest.executableSizeBytes || hash.digest("hex") !== manifest.executableSha256) {
              fail(new Error("Pinned Relay executable checksum mismatch."));
              return;
            }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { verifyRelayExecutablePin };
