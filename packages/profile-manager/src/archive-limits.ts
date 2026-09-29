export const ARCHIVE_LIMITS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxFrameBytes: 2 * 1024 * 1024 * 1024,
  maxTotalContentBytes: 64 * 1024 * 1024 * 1024,
  maxFileCount: 100_000,
  maxExtensionBundles: 10_000,
  maxArchiveBytes: 64 * 1024 * 1024 * 1024 + 512 * 1024 * 1024,
});
