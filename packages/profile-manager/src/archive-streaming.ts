import { createReadStream } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import type { FileMeta } from "./archive-validation.js";
import { ARCHIVE_LIMITS } from "./archive-limits.js";

const scrypt = promisify(scryptCb);

export const ARCHIVE_MAGIC = "MZAR";
export const ARCHIVE_VERSION = 2;
export const ARCHIVE_SUPPORTED_VERSIONS = new Set([1, 2]);

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 6 + SALT_LEN + IV_LEN;
const MIN_ARCHIVE_LEN = HEADER_LEN + TAG_LEN + 4;

export interface ArchiveSourceFile extends FileMeta {
  absPath: string;
}

export class ArchiveAuthenticationError extends Error {
  constructor(cause?: unknown) {
    super("Archive authentication failed.", { cause });
    this.name = "ArchiveAuthenticationError";
  }
}

export async function writeEncryptedArchive(input: {
  outPath: string;
  passphrase: string;
  version: number;
  manifestJson: Buffer;
  files: ArchiveSourceFile[];
}): Promise<void> {
  const { outPath, passphrase, version, manifestJson, files } = input;
  if (manifestJson.length > ARCHIVE_LIMITS.maxManifestBytes) {
    throw new Error("Archive manifest exceeds the allowed size.");
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = (await scrypt(passphrase, salt, KEY_LEN)) as Buffer;
  const cipher = createCipheriv(ALGO, key, iv);
  const header = Buffer.alloc(6);
  header.write(ARCHIVE_MAGIC, 0, 4, "ascii");
  header.writeUInt16BE(version, 4);
  const manifestLength = uint32(manifestJson.length);

  let handle: FileHandle | undefined;
  const position = { value: 0 };
  try {
    handle = await open(outPath, "w");
    await writeAll(handle, Buffer.concat([header, salt, iv]), position);

    const encryptAndWrite = async (plaintext: Buffer): Promise<void> => {
      if (plaintext.length === 0) return;
      await writeAll(handle!, cipher.update(plaintext), position);
    };
    await encryptAndWrite(manifestLength);
    await encryptAndWrite(manifestJson);

    for (const file of files) {
      await encryptAndWrite(uint32(file.size));
      const hash = createHash("sha256");
      let bytesRead = 0;
      for await (const value of createReadStream(file.absPath)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytesRead += chunk.length;
        if (bytesRead > file.size) throw sourceChanged(file);
        hash.update(chunk);
        await encryptAndWrite(chunk);
      }
      if (bytesRead !== file.size || hash.digest("hex") !== file.sha256) {
        throw sourceChanged(file);
      }
    }

    await writeAll(handle, cipher.final(), position);
    await writeAll(handle, cipher.getAuthTag(), position);
    await handle.close();
    handle = undefined;
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      await rm(outPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function openArchivePlaintext(
  archivePath: string,
  passphrase: string,
): Promise<{ version: number; reader: ArchivePlaintextReader }> {
  const archiveStat = await stat(archivePath);
  if (archiveStat.size < MIN_ARCHIVE_LEN) throw new Error("Not an MKT Browser archive");
  if (archiveStat.size > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error("Archive exceeds the allowed size.");
  }

  const handle = await open(archivePath, "r");
  let header: Buffer;
  let tag: Buffer;
  try {
    header = await readExactlyAt(handle, HEADER_LEN, 0);
    tag = await readExactlyAt(handle, TAG_LEN, archiveStat.size - TAG_LEN);
  } finally {
    await handle.close();
  }

  if (header.subarray(0, 4).toString("ascii") !== ARCHIVE_MAGIC) {
    throw new Error("Not an MKT Browser archive");
  }
  const version = header.readUInt16BE(4);
  if (!ARCHIVE_SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`Unsupported archive version: ${version}`);
  }

  const salt = header.subarray(6, 6 + SALT_LEN);
  const iv = header.subarray(6 + SALT_LEN, HEADER_LEN);
  const key = (await scrypt(passphrase, salt, KEY_LEN)) as Buffer;
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const ciphertext = createReadStream(archivePath, {
    start: HEADER_LEN,
    end: archiveStat.size - TAG_LEN - 1,
  });
  ciphertext.on("error", (error) => decipher.destroy(error));
  ciphertext.pipe(decipher);
  return { version, reader: new ArchivePlaintextReader(decipher) };
}

export class ArchivePlaintextReader {
  private readonly iterator: AsyncIterator<unknown>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readUInt32(truncatedMessage: string): Promise<number> {
    return (await this.readBuffer(4, truncatedMessage)).readUInt32BE(0);
  }

  async readBuffer(length: number, truncatedMessage: string): Promise<Buffer> {
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = await this.take(length - written);
      if (!chunk) throw new Error(truncatedMessage);
      chunk.copy(output, written);
      written += chunk.length;
    }
    return output;
  }

  async consumeFrame(meta: FileMeta, destination?: string): Promise<void> {
    const length = await this.readUInt32("Truncated archive frame.");
    if (length !== meta.size || length > ARCHIVE_LIMITS.maxFrameBytes) {
      throw new Error("Invalid archive frame size.");
    }

    let handle: FileHandle | undefined;
    const position = { value: 0 };
    if (destination) {
      await mkdir(dirname(destination), { recursive: true });
      handle = await open(destination, "wx");
    }

    const hash = createHash("sha256");
    let remaining = length;
    try {
      while (remaining > 0) {
        const chunk = await this.take(Math.min(remaining, 64 * 1024));
        if (!chunk) throw new Error("Truncated archive frame.");
        remaining -= chunk.length;
        hash.update(chunk);
        if (handle) await writeAll(handle, chunk, position);
      }
    } finally {
      await handle?.close();
    }

    if (hash.digest("hex") !== meta.sha256) {
      throw new Error(`Checksum mismatch for ${meta.path}`);
    }
  }

  async ensureNoTrailingData(): Promise<void> {
    if (await this.take(1)) throw new Error("Unexpected trailing archive data.");
  }

  async drain(): Promise<void> {
    this.offset = this.current.length;
    while (!this.ended) {
      await this.pull();
      this.offset = this.current.length;
    }
  }

  private async take(maxLength: number): Promise<Buffer | null> {
    while (this.offset >= this.current.length) {
      if (this.ended) return null;
      await this.pull();
    }
    const end = Math.min(this.current.length, this.offset + maxLength);
    const result = this.current.subarray(this.offset, end);
    this.offset = end;
    return result;
  }

  private async pull(): Promise<void> {
    try {
      const next = await this.iterator.next();
      if (next.done) {
        this.current = Buffer.alloc(0);
        this.offset = 0;
        this.ended = true;
        return;
      }
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      this.offset = 0;
    } catch (error) {
      throw new ArchiveAuthenticationError(error);
    }
  }
}

function uint32(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Archive frame exceeds the format limit.");
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value, 0);
  return result;
}

async function readExactlyAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(output, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Not an MKT Browser archive");
    offset += bytesRead;
  }
  return output;
}

async function writeAll(
  handle: FileHandle,
  content: Buffer,
  position: { value: number },
): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      position.value,
    );
    if (bytesWritten === 0) throw new Error("Archive write made no progress.");
    offset += bytesWritten;
    position.value += bytesWritten;
  }
}

function sourceChanged(file: ArchiveSourceFile): Error {
  return new Error(`Source file changed while exporting: ${file.path}`);
}
