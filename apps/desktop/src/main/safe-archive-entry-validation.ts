import type { Entry, ZipFile } from "yauzl";

import {
  SafeArchiveExtractionError,
  archiveFailure,
  archivePathKey,
  normalizeArchiveError,
  normalizeZipParserError,
  type PreparedArchiveEntry,
  type SafeArchivePolicy,
} from "./safe-archive-extraction-types.ts";

interface EntryState {
  entries: PreparedArchiveEntry[];
  explicitKeys: Set<string>;
  implicitDirectoryKeys: Set<string>;
  fileKeys: Set<string>;
  pathSpellings: Map<string, string>;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
}

const UNIX_HOST = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_SYMLINK = 0o120000;
const WINDOWS_INVALID_COMPONENT = /[<>:"|?*]/;
const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com(?:[1-9]|\u00b9|\u00b2|\u00b3)|lpt(?:[1-9]|\u00b9|\u00b2|\u00b3))(?:\.|$)/i;

export function collectArchiveEntries(
  zipFile: ZipFile,
  policy: SafeArchivePolicy,
  archiveBytes: number,
): Promise<PreparedArchiveEntry[]> {
  if (zipFile.entryCount > policy.maxEntries) archiveFailure("ARCHIVE_LIMIT_EXCEEDED", policy);
  const state: EntryState = {
    entries: [],
    explicitKeys: new Set(),
    implicitDirectoryKeys: new Set(),
    fileKeys: new Set(),
    pathSpellings: new Map(),
    totalCompressedBytes: 0,
    totalUncompressedBytes: 0,
  };

  return new Promise<PreparedArchiveEntry[]>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      zipFile.off("error", onError);
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      if (error) rejectPromise(error);
      else resolvePromise(state.entries);
    };
    const onError = (error: Error): void => finish(normalizeZipParserError(error, policy));
    const onEnd = (): void => {
      const ratio = state.totalUncompressedBytes / Math.max(archiveBytes, 1);
      finish(
        ratio > policy.maxCompressionRatio
          ? new SafeArchiveExtractionError("ARCHIVE_LIMIT_EXCEEDED", policy.archiveType)
          : null,
      );
    };
    const onEntry = (entry: Entry): void => {
      try {
        state.entries.push(prepareEntry(entry, state, policy));
        zipFile.readEntry();
      } catch (error) {
        finish(normalizeArchiveError(error, policy));
      }
    };

    zipFile.on("error", onError);
    zipFile.on("entry", onEntry);
    zipFile.on("end", onEnd);
    zipFile.readEntry();
  });
}

function prepareEntry(
  entry: Entry,
  state: EntryState,
  policy: SafeArchivePolicy,
): PreparedArchiveEntry {
  const relativePath = normalizeEntryPath(entry.fileName, policy);
  const key = archivePathKey(relativePath);
  const host = (entry.versionMadeBy >>> 8) & 0xff;
  const unixMode = host === UNIX_HOST ? (entry.externalFileAttributes >>> 16) & 0xffff : 0;
  const unixType = unixMode & UNIX_TYPE_MASK;
  if (unixType === UNIX_SYMLINK) archiveFailure("ARCHIVE_LINK_NOT_ALLOWED", policy);
  if (unixType !== 0 && unixType !== UNIX_DIRECTORY && unixType !== UNIX_REGULAR_FILE) {
    archiveFailure("ARCHIVE_UNSUPPORTED_ENTRY", policy);
  }

  const directoryByName = entry.fileName.endsWith("/");
  if (unixType === UNIX_REGULAR_FILE && directoryByName) {
    archiveFailure("ARCHIVE_UNSUPPORTED_ENTRY", policy);
  }
  const kind = unixType === UNIX_DIRECTORY || directoryByName ? "directory" : "file";
  registerEntryKey(relativePath, key, kind, state, policy);
  validateEntryLimits(entry, kind, state, policy);
  return {
    entry,
    relativePath,
    key,
    kind,
    mode: (unixMode & 0o777) || (kind === "directory" ? 0o755 : 0o644),
  };
}

function validateEntryLimits(
  entry: Entry,
  kind: PreparedArchiveEntry["kind"],
  state: EntryState,
  policy: SafeArchivePolicy,
): void {
  if (entry.isEncrypted() || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
    archiveFailure("ARCHIVE_UNSUPPORTED_ENTRY", policy);
  }
  if (kind === "directory" && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) {
    archiveFailure("ARCHIVE_UNSUPPORTED_ENTRY", policy);
  }
  if (kind === "file") {
    const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
    if (entry.uncompressedSize > policy.maxFileBytes || ratio > policy.maxCompressionRatio) {
      archiveFailure("ARCHIVE_LIMIT_EXCEEDED", policy);
    }
  }
  state.totalCompressedBytes += entry.compressedSize;
  state.totalUncompressedBytes += entry.uncompressedSize;
  if (
    state.entries.length + 1 > policy.maxEntries ||
    state.totalCompressedBytes > policy.maxCompressedBytes ||
    state.totalUncompressedBytes > policy.maxUncompressedBytes
  ) {
    archiveFailure("ARCHIVE_LIMIT_EXCEEDED", policy);
  }
}

function normalizeEntryPath(fileName: string, policy: SafeArchivePolicy): string {
  if (!fileName || fileName.length > policy.maxPathLength || fileName.includes("\0")) {
    archiveFailure("ARCHIVE_INVALID_PATH", policy);
  }
  const normalized = fileName.endsWith("/") ? fileName.slice(0, -1) : fileName;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("//")
  ) {
    archiveFailure("ARCHIVE_INVALID_PATH", policy);
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part.length > 255 ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      WINDOWS_INVALID_COMPONENT.test(part) ||
      Array.from(part).some((character) => character.charCodeAt(0) <= 0x1f) ||
      WINDOWS_RESERVED_COMPONENT.test(part)
    ) {
      archiveFailure("ARCHIVE_INVALID_PATH", policy);
    }
  }
  return parts.join("/");
}

function registerEntryKey(
  relativePath: string,
  key: string,
  kind: PreparedArchiveEntry["kind"],
  state: EntryState,
  policy: SafeArchivePolicy,
): void {
  const existingSpelling = state.pathSpellings.get(key);
  if (existingSpelling !== undefined && existingSpelling !== relativePath) {
    archiveFailure("ARCHIVE_DUPLICATE_ENTRY", policy);
  }
  if (state.explicitKeys.has(key) || (kind === "file" && state.implicitDirectoryKeys.has(key))) {
    archiveFailure("ARCHIVE_DUPLICATE_ENTRY", policy);
  }
  const pathParts = relativePath.split("/");
  const keyParts = key.split("/");
  for (let index = 1; index < keyParts.length; index++) {
    const ancestorKey = keyParts.slice(0, index).join("/");
    const ancestorPath = pathParts.slice(0, index).join("/");
    const ancestorSpelling = state.pathSpellings.get(ancestorKey);
    if (
      state.fileKeys.has(ancestorKey) ||
      (ancestorSpelling !== undefined && ancestorSpelling !== ancestorPath)
    ) {
      archiveFailure("ARCHIVE_DUPLICATE_ENTRY", policy);
    }
    state.pathSpellings.set(ancestorKey, ancestorPath);
    state.implicitDirectoryKeys.add(ancestorKey);
  }
  state.pathSpellings.set(key, relativePath);
  state.explicitKeys.add(key);
  if (kind === "file") state.fileKeys.add(key);
}
