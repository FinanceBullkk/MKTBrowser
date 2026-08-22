import { createWriteStream, existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { open, type Entry, type ZipFile } from "yauzl";

import { collectArchiveEntries } from "./safe-archive-entry-validation.ts";
import {
  archiveFailure,
  archivePathKey,
  isFileSystemError,
  normalizeArchiveError,
  normalizeZipParserError,
  type PreparedArchiveEntry,
  type SafeArchiveExtractionInput,
  type SafeArchivePolicy,
} from "./safe-archive-extraction-types.ts";

export { SafeArchiveExtractionError } from "./safe-archive-extraction-types.ts";
export type {
  SafeArchiveErrorCode,
  SafeArchiveExtractionInput,
  SafeArchivePolicy,
} from "./safe-archive-extraction-types.ts";

/** Extract a ZIP into a new owned directory after every entry passes preflight. */
export async function extractArchiveSafely(input: SafeArchiveExtractionInput): Promise<void> {
  const { archivePath, destinationPath, policy } = input;
  validateInput(archivePath, destinationPath, policy);

  let createdDestination = false;
  let zipFile: ZipFile | null = null;
  try {
    const archiveInfo = await stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size > policy.maxCompressedBytes) {
      archiveFailure("ARCHIVE_LIMIT_EXCEEDED", policy);
    }
    zipFile = await openZipFile(archivePath, policy);
    const prepared = await collectArchiveEntries(zipFile, policy, archiveInfo.size);

    await mkdir(destinationPath);
    createdDestination = true;
    await extractPreparedEntries(zipFile, destinationPath, prepared, policy);
    await verifyExtractedTree(destinationPath, prepared, policy);
    await applyDirectoryModes(destinationPath, prepared);
  } catch (error) {
    if (createdDestination) {
      await rm(destinationPath, { recursive: true, force: true }).catch(() => {});
    }
    throw normalizeArchiveError(error, policy);
  } finally {
    if (zipFile?.isOpen) zipFile.close();
  }
}

function validateInput(
  archivePath: string,
  destinationPath: string,
  policy: SafeArchivePolicy,
): void {
  if (!isAbsolute(archivePath) || !isAbsolute(destinationPath)) {
    archiveFailure("ARCHIVE_INVALID_PATH", policy);
  }
  if (existsSync(destinationPath)) archiveFailure("ARCHIVE_DESTINATION_EXISTS", policy);
  for (const limit of [
    policy.maxCompressedBytes,
    policy.maxUncompressedBytes,
    policy.maxEntries,
    policy.maxFileBytes,
    policy.maxCompressionRatio,
    policy.maxPathLength,
  ]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      archiveFailure("ARCHIVE_LIMIT_EXCEEDED", policy);
    }
  }
}

function openZipFile(archivePath: string, policy: SafeArchivePolicy): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    open(
      archivePath,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error || !zipFile) rejectPromise(normalizeZipParserError(error, policy));
        else resolvePromise(zipFile);
      },
    );
  });
}

async function extractPreparedEntries(
  zipFile: ZipFile,
  destinationPath: string,
  entries: PreparedArchiveEntry[],
  policy: SafeArchivePolicy,
): Promise<void> {
  for (const prepared of entries) {
    const outputPath = containedOutputPath(destinationPath, prepared.relativePath, policy);
    if (prepared.kind === "directory") {
      await mkdir(outputPath, { recursive: true });
      continue;
    }
    await mkdir(dirname(outputPath), { recursive: true });
    try {
      const readStream = await openEntryStream(zipFile, prepared.entry);
      await pipeline(
        readStream,
        new EntryIntegrityTransform(prepared.entry.uncompressedSize, prepared.entry.crc32),
        createWriteStream(outputPath, { flags: "wx", mode: prepared.mode }),
      );
    } catch (error) {
      archiveFailure(
        isFileSystemError(error) ? "ARCHIVE_IO_ERROR" : "ARCHIVE_INTEGRITY_FAILED",
        policy,
      );
    }
  }
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) rejectPromise(error ?? new Error("Missing ZIP entry stream."));
      else resolvePromise(stream);
    });
  });
}

class EntryIntegrityTransform extends Transform {
  private bytes = 0;
  private checksum = 0;
  private readonly expectedBytes: number;
  private readonly expectedChecksum: number;

  constructor(expectedBytes: number, expectedChecksum: number) {
    super();
    this.expectedBytes = expectedBytes;
    this.expectedChecksum = expectedChecksum;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    this.checksum = crc32(chunk, this.checksum) >>> 0;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.bytes !== this.expectedBytes || this.checksum !== (this.expectedChecksum >>> 0)) {
      callback(new Error("ZIP entry integrity check failed."));
    } else callback();
  }
}

async function verifyExtractedTree(
  destinationPath: string,
  entries: PreparedArchiveEntry[],
  policy: SafeArchivePolicy,
): Promise<void> {
  const rootRealPath = await realpath(destinationPath);
  const expectedFiles = new Map(
    entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => [entry.key, entry.entry.uncompressedSize]),
  );
  const seenFiles = new Set<string>();
  let totalBytes = 0;
  const pending = [{ absolutePath: destinationPath, relativePath: "" }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of await readdir(current.absolutePath)) {
      const absolutePath = join(current.absolutePath, name);
      const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) archiveFailure("ARCHIVE_LINK_NOT_ALLOWED", policy);
      assertRealPathContained(rootRealPath, await realpath(absolutePath), policy);
      if (info.isDirectory()) pending.push({ absolutePath, relativePath });
      else if (info.isFile()) {
        const key = archivePathKey(relativePath);
        if (expectedFiles.get(key) !== info.size) archiveFailure("ARCHIVE_INTEGRITY_FAILED", policy);
        seenFiles.add(key);
        totalBytes += info.size;
      } else archiveFailure("ARCHIVE_UNSUPPORTED_ENTRY", policy);
    }
  }
  if (seenFiles.size !== expectedFiles.size || totalBytes > policy.maxUncompressedBytes) {
    archiveFailure("ARCHIVE_INTEGRITY_FAILED", policy);
  }
}

async function applyDirectoryModes(
  destinationPath: string,
  entries: PreparedArchiveEntry[],
): Promise<void> {
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => right.relativePath.split("/").length - left.relativePath.split("/").length);
  for (const directory of directories) {
    await chmod(join(destinationPath, ...directory.relativePath.split("/")), directory.mode);
  }
}

function containedOutputPath(
  destinationPath: string,
  relativePath: string,
  policy: SafeArchivePolicy,
): string {
  const base = resolve(destinationPath);
  const candidate = resolve(base, ...relativePath.split("/"));
  const rel = relative(base, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    archiveFailure("ARCHIVE_INVALID_PATH", policy);
  }
  return candidate;
}

function assertRealPathContained(
  rootRealPath: string,
  candidateRealPath: string,
  policy: SafeArchivePolicy,
): void {
  const rel = relative(rootRealPath, candidateRealPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    archiveFailure("ARCHIVE_INVALID_PATH", policy);
  }
}
