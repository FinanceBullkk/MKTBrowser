export const LICENSE_LEASE_STATES = [
  "reserved",
  "starting",
  "active",
  "ending",
  "pending-recovery",
  "cooling",
  "confirmed-released",
  "terminal-refused",
] as const;

export type LicenseLeaseState = (typeof LICENSE_LEASE_STATES)[number];

export interface LicenseLeaseRecord {
  id: string;
  profileId: string;
  keyFingerprint: string;
  keyTail: string;
  state: LicenseLeaseState;
  childPid: number | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LicenseLeaseJournalData {
  schemaVersion: 1;
  records: LicenseLeaseRecord[];
}

export const ALLOWED_LICENSE_LEASE_TRANSITIONS: Record<
  LicenseLeaseState,
  readonly LicenseLeaseState[]
> = {
  reserved: ["starting", "pending-recovery", "terminal-refused"],
  starting: ["active", "pending-recovery", "terminal-refused"],
  active: ["ending", "pending-recovery"],
  ending: ["confirmed-released", "pending-recovery", "cooling"],
  "pending-recovery": ["ending", "cooling"],
  cooling: ["ending", "pending-recovery"],
  "confirmed-released": [],
  "terminal-refused": ["cooling", "pending-recovery"],
};

export function parseLicenseLeaseJournal(contents: string): LicenseLeaseJournalData {
  const parsed = JSON.parse(contents) as Partial<LicenseLeaseJournalData>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
    throw new Error("The license lease journal has an unsupported schema.");
  }

  const ids = new Set<string>();
  const profileIds = new Set<string>();
  const blockingKeyFingerprints = new Set<string>();
  for (const record of parsed.records) {
    assertRecord(record);
    if (ids.has(record.id) || profileIds.has(record.profileId)) {
      throw new Error("The license lease journal contains a duplicate profile record.");
    }
    if (
      record.state !== "confirmed-released" &&
      blockingKeyFingerprints.has(record.keyFingerprint)
    ) {
      throw new Error("The license lease journal cross-wires one key to multiple profiles.");
    }
    ids.add(record.id);
    profileIds.add(record.profileId);
    if (record.state !== "confirmed-released") {
      blockingKeyFingerprints.add(record.keyFingerprint);
    }
  }
  return parsed as LicenseLeaseJournalData;
}

function assertRecord(record: LicenseLeaseRecord): void {
  const validChildPid =
    record?.childPid === null ||
    (Number.isSafeInteger(record?.childPid) && Number(record.childPid) > 0);
  if (
    !record ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.profileId !== "string" ||
    record.profileId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(record.keyFingerprint) ||
    typeof record.keyTail !== "string" ||
    record.keyTail.length > 6 ||
    !LICENSE_LEASE_STATES.includes(record.state) ||
    !validChildPid ||
    (record.lastErrorCode !== null && !isStableErrorCode(record.lastErrorCode)) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt)
  ) {
    throw new Error("The license lease journal contains an invalid record.");
  }
}

export function isStableErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}
