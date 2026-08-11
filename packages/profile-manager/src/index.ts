export { ProfileManager } from "./ProfileManager.js";
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
export {
  copyLegacyMultiZenData,
  findLegacyMultiZenImport,
  type LegacyMultiZenImportCandidate,
  type LegacyMultiZenImportDiscovery,
  type LegacyMultiZenImportResult,
  type LegacyMultiZenImportUnreadable,
} from "./legacy-multizen-import.js";
