import { createHash, randomUUID } from "node:crypto";
import {
  ALLOWED_LICENSE_LEASE_TRANSITIONS,
  isStableErrorCode,
  type LicenseLeaseRecord,
  type LicenseLeaseState,
} from "./license-lease-journal-schema.ts";
import {
  loadLicenseLeaseRecords,
  persistLicenseLeaseRecords,
} from "./license-lease-journal-storage.ts";

export {
  LICENSE_LEASE_STATES,
  type LicenseLeaseRecord,
  type LicenseLeaseState,
} from "./license-lease-journal-schema.ts";

export interface LicenseLeaseJournalOptions {
  now?: () => number;
  idFactory?: () => string;
}

export function fingerprintLicenseKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

export class LicenseLeaseJournal {
  private readonly records = new Map<string, LicenseLeaseRecord>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    filePath: string,
    records: LicenseLeaseRecord[],
    options: LicenseLeaseJournalOptions,
  ) {
    this.filePath = filePath;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    for (const record of records) this.records.set(record.id, record);
  }

  static async open(
    filePath: string,
    options: LicenseLeaseJournalOptions = {},
  ): Promise<LicenseLeaseJournal> {
    return new LicenseLeaseJournal(filePath, await loadLicenseLeaseRecords(filePath), options);
  }

  get(profileId: string): LicenseLeaseRecord | null {
    const record = this.currentRecord(profileId);
    return record ? { ...record } : null;
  }

  snapshot(): LicenseLeaseRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async reserve(input: {
    profileId: string;
    key: string;
    staleLeaseExpired?: boolean;
  }): Promise<LicenseLeaseRecord> {
    const profileId = input.profileId.trim();
    const key = input.key.trim();
    if (!profileId) throw new Error("A lease reservation requires a profile ID.");
    if (!key) throw new Error("A lease reservation requires a license key.");

    const keyFingerprint = fingerprintLicenseKey(key);
    return this.enqueueMutation(async () => {
      const existing = this.currentRecord(profileId);
      if (existing?.state === "reserved" && existing.keyFingerprint === keyFingerprint) {
        return { ...existing };
      }
      if (existing && !isHistoricalState(existing.state)) {
        if (existing.keyFingerprint !== keyFingerprint) {
          throw new Error("This profile already has a lease reserved with a different license key.");
        }
        throw new Error(`This profile already has a ${existing.state} license lease.`);
      }
      const keyOwner = [...this.records.values()].find(
        (record) =>
          record.state !== "confirmed-released" &&
          record.state !== "expired" &&
          record.keyFingerprint === keyFingerprint,
      );
      const canRetireKeyOwner =
        input.staleLeaseExpired === true &&
        (keyOwner?.state === "cooling" || keyOwner?.state === "terminal-refused");
      if (keyOwner && !canRetireKeyOwner) {
        throw new Error("This license key already has a lease reserved for another profile.");
      }

      const timestamp = new Date(this.now()).toISOString();
      const record: LicenseLeaseRecord = {
        id: this.idFactory(),
        profileId,
        keyFingerprint,
        keyTail: key.length <= 6 ? "*".repeat(key.length) : key.slice(-6),
        state: "reserved",
        childPid: null,
        lastErrorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const records = new Map(this.records);
      if (keyOwner && canRetireKeyOwner) {
        records.set(keyOwner.id, {
          ...keyOwner,
          state: "expired",
          childPid: null,
          updatedAt: timestamp,
        });
      }
      if (records.has(record.id)) throw new Error("A license lease record ID was reused.");
      records.set(record.id, record);
      await persistLicenseLeaseRecords(this.filePath, [...records.values()]);
      this.records.clear();
      for (const [id, next] of records) this.records.set(id, next);
      return { ...record };
    });
  }

  async transition(
    profileId: string,
    nextState: LicenseLeaseState,
    updates: { childPid?: number | null; lastErrorCode?: string | null } = {},
  ): Promise<LicenseLeaseRecord> {
    if (
      updates.childPid !== undefined &&
      updates.childPid !== null &&
      (!Number.isInteger(updates.childPid) || updates.childPid < 1)
    ) {
      throw new Error("A license lease child PID must be a positive integer.");
    }
    if (updates.lastErrorCode !== undefined && updates.lastErrorCode !== null) {
      assertStableErrorCode(updates.lastErrorCode);
    }

    return this.enqueueMutation(async () => {
      const current = this.currentRecord(profileId);
      if (!current) throw new Error(`No license lease exists for profile ${profileId}.`);
      if (!ALLOWED_LICENSE_LEASE_TRANSITIONS[current.state].includes(nextState)) {
        throw new Error(
          `A license lease cannot transition from ${current.state} to ${nextState}.`,
        );
      }

      const next: LicenseLeaseRecord = {
        ...current,
        state: nextState,
        childPid: updates.childPid === undefined ? current.childPid : updates.childPid,
        lastErrorCode:
          updates.lastErrorCode === undefined ? current.lastErrorCode : updates.lastErrorCode,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.persistRecord(current.id, next);
      this.records.set(current.id, next);
      return { ...next };
    });
  }

  async markPendingRecovery(
    profileId: string,
    lastErrorCode: string,
  ): Promise<LicenseLeaseRecord> {
    assertStableErrorCode(lastErrorCode);
    return this.enqueueMutation(async () => {
      const current = this.currentRecord(profileId);
      if (!current) throw new Error(`No license lease exists for profile ${profileId}.`);
      if (
        current.state !== "pending-recovery" &&
        !ALLOWED_LICENSE_LEASE_TRANSITIONS[current.state].includes("pending-recovery")
      ) {
        throw new Error(`A license lease in ${current.state} cannot enter pending recovery.`);
      }
      const next: LicenseLeaseRecord = {
        ...current,
        state: "pending-recovery",
        lastErrorCode,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.persistRecord(current.id, next);
      this.records.set(current.id, next);
      return { ...next };
    });
  }

  async releaseUnstartedReservation(profileId: string): Promise<LicenseLeaseRecord> {
    return this.enqueueMutation(async () => {
      const current = this.currentRecord(profileId);
      if (!current) throw new Error(`No license lease exists for profile ${profileId}.`);
      if (current.state !== "reserved") {
        throw new Error(`Only an unstarted reservation can be released locally.`);
      }
      const next: LicenseLeaseRecord = {
        ...current,
        state: "confirmed-released",
        childPid: null,
        lastErrorCode: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.persistRecord(current.id, next);
      this.records.set(current.id, next);
      return { ...next };
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private currentRecord(profileId: string): LicenseLeaseRecord | undefined {
    let historical: LicenseLeaseRecord | undefined;
    for (const record of this.records.values()) {
      if (record.profileId !== profileId) continue;
      if (!isHistoricalState(record.state)) return record;
      historical = record;
    }
    return historical;
  }

  private async persistRecord(recordId: string, record: LicenseLeaseRecord): Promise<void> {
    const records = new Map(this.records);
    records.set(recordId, record);
    await persistLicenseLeaseRecords(this.filePath, [...records.values()]);
  }
}

function isHistoricalState(state: LicenseLeaseState): boolean {
  return ["cooling", "confirmed-released", "terminal-refused", "expired"].includes(state);
}

function assertStableErrorCode(value: string): void {
  if (!isStableErrorCode(value)) {
    throw new Error("A license lease requires a stable error code before entering recovery.");
  }
}
