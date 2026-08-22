import type {
  LicenseLeaseJournal,
  LicenseLeaseRecord,
} from "./license-lease-journal.ts";

export type RecoveryProfile<T> =
  | { status: "ready"; value: T }
  | { status: "missing" }
  | { status: "proxy-unavailable" };

export interface LicenseLeaseRecoveryDeps<TProfile> {
  resolveProfile: (profileId: string) => Promise<RecoveryProfile<TProfile>>;
  resolveKey: (keyFingerprint: string) => Promise<string | null>;
  release: (input: {
    record: LicenseLeaseRecord;
    key: string;
    profile: TProfile;
  }) => Promise<"confirmed" | "retry">;
}

export interface LicenseLeaseRecoverySummary {
  confirmed: number;
  pending: number;
  skipped: number;
}

export async function recoverLicenseLeases<TProfile>(
  journal: LicenseLeaseJournal,
  deps: LicenseLeaseRecoveryDeps<TProfile>,
): Promise<LicenseLeaseRecoverySummary> {
  const summary: LicenseLeaseRecoverySummary = { confirmed: 0, pending: 0, skipped: 0 };

  for (const snapshot of journal.snapshot()) {
    if (snapshot.state === "confirmed-released" || snapshot.state === "terminal-refused") {
      summary.skipped += 1;
      continue;
    }
    if (snapshot.state === "reserved") {
      await journal.releaseUnstartedReservation(snapshot.profileId);
      summary.confirmed += 1;
      continue;
    }
    if (snapshot.state === "cooling") {
      summary.skipped += 1;
      continue;
    }

    let record = snapshot;
    if (record.state !== "pending-recovery") {
      record = await journal.markPendingRecovery(record.profileId, "RECOVERY_REQUIRED");
    }
    const profile = await deps.resolveProfile(record.profileId);
    if (profile.status !== "ready") {
      await journal.markPendingRecovery(
        record.profileId,
        profile.status === "missing" ? "PROFILE_MISSING" : "PROXY_UNAVAILABLE",
      );
      summary.pending += 1;
      continue;
    }
    const key = await deps.resolveKey(record.keyFingerprint);
    if (!key) {
      await journal.markPendingRecovery(record.profileId, "KEY_MISSING");
      summary.pending += 1;
      continue;
    }

    record = await journal.transition(record.profileId, "ending");
    try {
      const outcome = await deps.release({ record, key, profile: profile.value });
      if (outcome === "confirmed") {
        await journal.transition(record.profileId, "confirmed-released", {
          childPid: null,
          lastErrorCode: null,
        });
        summary.confirmed += 1;
      } else {
        await journal.markPendingRecovery(record.profileId, "RELEASE_UNCONFIRMED");
        summary.pending += 1;
      }
    } catch {
      await journal.markPendingRecovery(record.profileId, "RELEASE_FAILED");
      summary.pending += 1;
    }
  }

  return summary;
}
