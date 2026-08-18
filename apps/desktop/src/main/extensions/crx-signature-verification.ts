import { createHash, randomUUID, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VerifiedCrxUnwrapResult {
  /** Path to the verified inner ZIP, or the original source when it is a plain ZIP. */
  zipPath: string;
  /** Publisher key from a verified CRX2/CRX3 signature. */
  publicKey?: Buffer;
  isCrx: boolean;
}

/** Verify a CRX2/CRX3 publisher signature and write its inner ZIP into `outDir`. */
export async function unwrapVerifiedCrx(
  sourcePath: string,
  outDir: string,
): Promise<VerifiedCrxUnwrapResult> {
  const buf = await readFile(sourcePath);
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") {
    return { zipPath: sourcePath, isCrx: false };
  }

  const version = buf.readUInt32LE(4);
  let zipStart: number;
  let publicKey: Buffer;
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
    if (headerLen === 0 || zipStart >= buf.length) {
      throw new Error("Corrupt CRX3: invalid header or ZIP offset.");
    }
    publicKey = verifyCrx3Header(buf.subarray(12, zipStart), buf.subarray(zipStart));
  } else if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
    if (pubKeyLen === 0 || sigLen === 0 || zipStart >= buf.length) {
      throw new Error("Corrupt CRX2: invalid key, signature, or ZIP offset.");
    }
    publicKey = Buffer.from(buf.subarray(16, 16 + pubKeyLen));
    const signature = buf.subarray(16 + pubKeyLen, zipStart);
    if (!verifySignature("RSA-SHA1", buf.subarray(zipStart), publicKey, signature)) {
      throw new Error("Invalid CRX2 publisher signature.");
    }
  } else {
    throw new Error(`Unsupported CRX version ${version}.`);
  }

  const zipPath = join(outDir, `${randomUUID()}.zip`);
  await writeFile(zipPath, buf.subarray(zipStart));
  return { zipPath, publicKey, isCrx: true };
}

function verifyCrx3Header(header: Buffer, zip: Buffer): Buffer {
  const signedHeader = firstField(header, 10000);
  const crxId = signedHeader ? firstField(signedHeader, 1) : undefined;
  if (!signedHeader || !crxId || crxId.length !== 16) {
    throw new Error("Invalid CRX3 signature metadata.");
  }

  const signedSize = Buffer.alloc(4);
  signedSize.writeUInt32LE(signedHeader.length);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "ascii"),
    signedSize,
    signedHeader,
    zip,
  ]);

  for (const field of [2, 3]) {
    for (const proof of collectFields(header, field)) {
      const publicKey = firstField(proof, 1);
      const signature = firstField(proof, 2);
      if (!publicKey?.length || !signature?.length) continue;
      const proofId = createHash("sha256").update(publicKey).digest().subarray(0, 16);
      if (!proofId.equals(crxId)) continue;
      if (verifySignature("sha256", signedPayload, publicKey, signature)) {
        return Buffer.from(publicKey);
      }
    }
  }
  throw new Error("Invalid CRX3 publisher signature.");
}

function verifySignature(
  algorithm: string,
  data: Buffer,
  publicKey: Buffer,
  signature: Buffer,
): boolean {
  try {
    return verify(algorithm, data, { key: publicKey, format: "der", type: "spki" }, signature);
  } catch {
    return false;
  }
}

/** All length-delimited (wire type 2) sub-messages for `field` in `msg`. */
function collectFields(msg: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < msg.length) {
    const [tag, tagEnd] = readVarint(msg, i);
    i = tagEnd;
    const actualField = tag >>> 3;
    const wire = tag & 0x7;
    if (wire !== 2) {
      i = skipField(msg, i, wire);
      continue;
    }
    const [len, valueStart] = readVarint(msg, i);
    const valueEnd = valueStart + len;
    if (valueEnd > msg.length) throw new Error("protobuf field overrun");
    if (actualField === field) out.push(msg.subarray(valueStart, valueEnd));
    i = valueEnd;
  }
  return out;
}

function firstField(msg: Buffer, field: number): Buffer | undefined {
  return collectFields(msg, field)[0];
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error("varint overrun");
    const byte = buf[i] ?? 0;
    result += (byte & 0x7f) * Math.pow(2, shift);
    i++;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 49) throw new Error("varint too long");
  }
}

function skipField(buf: Buffer, pos: number, wire: number): number {
  if (wire === 0) return readVarint(buf, pos)[1];
  if (wire === 5) return pos + 4;
  if (wire === 1) return pos + 8;
  throw new Error(`unsupported wire type ${wire}`);
}
