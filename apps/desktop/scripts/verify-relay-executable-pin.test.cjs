const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { verifyRelayExecutablePin } = require("./verify-relay-executable-pin.cjs");

// Tiny stored ZIPs keep verification tests independent of machine archivers and installed Relay.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes);
    centrals.push(central, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test("stream-verifies exact executable pin and rejects wrong bytes, duplicate, missing and invalid metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mkt-relay-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, "fixture.zip");
  const bytes = Buffer.from("synthetic executable bytes, never launched");
  const manifest = { executableSizeBytes: bytes.length,
    executableSha256: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(archive, zip([["MKTTool-Relay.exe", bytes], ["setup.bat", Buffer.from("fixture")]]));
  await verifyRelayExecutablePin(archive, manifest);
  await assert.rejects(verifyRelayExecutablePin(archive, { ...manifest, executableSha256: "0".repeat(64) }), /checksum mismatch/);
  await assert.rejects(verifyRelayExecutablePin(archive, { ...manifest, executableSizeBytes: bytes.length + 1 }), /invalid size/);
  await assert.rejects(verifyRelayExecutablePin(archive, { ...manifest, executableSizeBytes: 0 }), /metadata is invalid/);
  for (const entries of [
    [["MKTTool-Relay.exe", bytes], ["MKTTool-Relay.exe", bytes]],
    [["mkttool-relay.exe", bytes]],
    [["other.exe", bytes]],
  ]) {
    writeFileSync(archive, zip(entries));
    await assert.rejects(verifyRelayExecutablePin(archive, manifest), /ambiguous|missing/);
  }
});
