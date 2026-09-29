export {
  ProfileManager,
  IdempotentProfileCreateConflictError,
  ManagedProfileLockedError,
  ProfileDeletionPendingError,
  type IdempotentProfileCreateMetadata,
  type IdempotentProfileCreateResult,
} from "./ProfileManager.js";
export {
  ProfileDeletionIncompleteError,
  UnsafeProfileDeletionPathError,
} from "./permanent-profile-deletion.js";
export {
  defaultFingerprint,
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  reconcileDeviceFamilyToHost,
  hostPlatformFamily,
  deviceCatalog,
  localeCatalog,
  findLocaleIdByCountry,
  CHROME_VERSION_FULL,
  CHROME_VERSION_MAJOR,
  type DeviceCatalogEntry,
  type LocaleCatalogEntry,
} from "./fingerprint.js";
export { exportProfile, importProfile } from "./archive.js";
export { reclaimStaleArchiveStaging } from "./archive-staging.js";
export {
  copyLegacyMultiZenData,
  findLegacyMultiZenImport,
  type LegacyMultiZenImportCandidate,
  type LegacyMultiZenImportDiscovery,
  type LegacyMultiZenImportResult,
  type LegacyMultiZenImportUnreadable,
} from "./legacy-multizen-import.js";
