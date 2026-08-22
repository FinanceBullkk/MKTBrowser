import type { Entry } from "yauzl";

export type SafeArchiveErrorCode =
  | "ARCHIVE_CORRUPT"
  | "ARCHIVE_DESTINATION_EXISTS"
  | "ARCHIVE_DUPLICATE_ENTRY"
  | "ARCHIVE_INTEGRITY_FAILED"
  | "ARCHIVE_INVALID_PATH"
  | "ARCHIVE_IO_ERROR"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "ARCHIVE_LINK_NOT_ALLOWED"
  | "ARCHIVE_UNSUPPORTED_ENTRY";

export class SafeArchiveExtractionError extends Error {
  readonly code: SafeArchiveErrorCode;

  constructor(code: SafeArchiveErrorCode, archiveType: string) {
    super(`Safe ${archiveType} archive rejected: ${code}.`);
    this.name = "SafeArchiveExtractionError";
    this.code = code;
  }
}

export interface SafeArchivePolicy {
  archiveType: string;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxCompressionRatio: number;
  maxPathLength: number;
}

export interface SafeArchiveExtractionInput {
  archivePath: string;
  destinationPath: string;
  policy: SafeArchivePolicy;
}

export interface PreparedArchiveEntry {
  entry: Entry;
  relativePath: string;
  key: string;
  kind: "directory" | "file";
  mode: number;
}

export function archiveFailure(
  code: SafeArchiveErrorCode,
  policy: SafeArchivePolicy,
): never {
  throw new SafeArchiveExtractionError(code, policy.archiveType);
}

export function normalizeArchiveError(
  error: unknown,
  policy: SafeArchivePolicy,
): SafeArchiveExtractionError {
  if (error instanceof SafeArchiveExtractionError) return error;
  return new SafeArchiveExtractionError(
    isFileSystemError(error) ? "ARCHIVE_IO_ERROR" : "ARCHIVE_CORRUPT",
    policy.archiveType,
  );
}

export function normalizeZipParserError(
  error: unknown,
  policy: SafeArchivePolicy,
): SafeArchiveExtractionError {
  const message = error instanceof Error ? error.message : "";
  const invalidPath = /absolute path|invalid relative path|invalid characters in filename/i.test(
    message,
  );
  return new SafeArchiveExtractionError(
    invalidPath ? "ARCHIVE_INVALID_PATH" : "ARCHIVE_CORRUPT",
    policy.archiveType,
  );
}

export function isFileSystemError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z]+$/.test(error.code)
  );
}

export function archivePathKey(relativePath: string): string {
  return relativePath.normalize("NFC").toLowerCase();
}
