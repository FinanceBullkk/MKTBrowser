import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  content: Buffer | string;
  /** Unix mode stored in the ZIP central directory, including file type bits. */
  mode?: number;
  compress?: boolean;
}

interface CrxFixture {
  bytes: Buffer;
  id: string;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a deterministic, uncompressed ZIP without adding a test-only dependency. */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    const storedContent = entry.compress ? deflateRawSync(content) : content;
    const crc = crc32(content);
    const compressionMethod = entry.compress ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(storedContent.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, storedContent);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(storedContent.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + storedContent.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function extensionId(publicKey: Buffer): string {
  const digest = createHash("sha256").update(publicKey).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function rsaFixture(): {
  privateKey: KeyObject;
  publicKey: Buffer;
} {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }),
  };
}

export function createCrx2(zip: Buffer, validSignature = true): CrxFixture {
  const keys = rsaFixture();
  const signature = sign("RSA-SHA1", zip, keys.privateKey);
  if (!validSignature) signature[0] = (signature[0] ?? 0) ^ 0xff;

  const header = Buffer.alloc(16);
  header.write("Cr24", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(keys.publicKey.length, 8);
  header.writeUInt32LE(signature.length, 12);
  return {
    bytes: Buffer.concat([header, keys.publicKey, signature, zip]),
    id: extensionId(keys.publicKey),
  };
}

export function createCrx3(zip: Buffer, validSignature = true): CrxFixture {
  const keys = rsaFixture();
  const crxId = createHash("sha256").update(keys.publicKey).digest().subarray(0, 16);
  const signedHeader = bytesField(1, crxId);
  const signedSize = Buffer.alloc(4);
  signedSize.writeUInt32LE(signedHeader.length);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "ascii"),
    signedSize,
    signedHeader,
    zip,
  ]);
  const signature = sign("RSA-SHA256", signedPayload, keys.privateKey);
  if (!validSignature) signature[0] = (signature[0] ?? 0) ^ 0xff;

  const proof = Buffer.concat([bytesField(1, keys.publicKey), bytesField(2, signature)]);
  const crxHeader = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(crxHeader.length, 8);
  return {
    bytes: Buffer.concat([prefix, crxHeader, zip]),
    id: extensionId(keys.publicKey),
  };
}
