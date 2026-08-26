import type { LicenseKeyPool } from "./license-key-pool.ts";
import type { LicenseLeaseJournal } from "./license-lease-journal.ts";
import type { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import type { OrphanSweepOutcome } from "./startup-orphan-sweep.ts";

export interface StartupLeaseReconciliationSummary {
  confirmed: number;
  cooling: number;
  pending: number;
  skipped: number;
}

export interface StartupLeaseReconciliationDeps {
  journal: Pick<LicenseLeaseJournal, "get">;
  pool: Pick<LicenseKeyPool, "reconcilePersistedLease">;
  recorder: Pick<LicenseLeaseRecorder, "released">;
  log?: (message: string) => void;
}

/** Bind an exact startup orphan verdict back to the durable lease that owned its profile. */
export async function reconcileStartupOrphanLeases(
  outcome: OrphanSweepOutcome,
  deps: StartupLeaseReconciliationDeps,
): Promise<StartupLeaseReconciliationSummary> {
  const summary: StartupLeaseReconciliationSummary = {
    confirmed: 0,
    cooling: 0,
    pending: 0,
    skipped: 0,
  };

  for (const recovery of outcome.recoveries) {
    const record = deps.journal.get(recovery.profileId);
    if (!record || ["confirmed-released", "cooling", "terminal-refused", "expired"].includes(record.state)) {
      summary.skipped += 1;
      continue;
    }

    try {
      const seatReleased = await deps.recorder.released(
        recovery.profileId,
        recovery.seatReleased,
      );
      deps.pool.reconcilePersistedLease(record.keyFingerprint, seatReleased);
      if (seatReleased) summary.confirmed += 1;
      else summary.cooling += 1;
    } catch (error) {
      summary.pending += 1;
      deps.log?.(
        `[mkt-browser] startup lease reconciliation failed for profile=${recovery.profileId}: ${String(error)}`,
      );
    }
  }

  return summary;
}
