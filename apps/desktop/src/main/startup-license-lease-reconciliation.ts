import { LICENSE_SEAT_COOLDOWN_MS, LICENSE_SEAT_REFUSAL_COOLDOWN_MS, type LicenseKeyPool } from "./license-key-pool.ts";
import type { LicenseLeaseJournal } from "./license-lease-journal.ts";
import type { LicenseLeaseRecorder } from "./license-lease-recorder.ts";
import type { OrphanSweepOutcome } from "./startup-orphan-sweep.ts";

export interface StartupLeaseReconciliationSummary {
  confirmed: number;
  cooling: number;
  /** Leases whose rest had already run out by the time this start looked at them. */
  expired: number;
  pending: number;
  skipped: number;
}

export interface StartupLeaseReconciliationDeps {
  journal: Pick<LicenseLeaseJournal, "get" | "snapshot" | "transition">;
  pool: Pick<LicenseKeyPool, "reconcilePersistedLease">;
  recorder: Pick<LicenseLeaseRecorder, "released">;
  log?: (message: string) => void;
  /**
   * When this machine last booted, as `Date.now() - os.uptime() * 1000`.
   *
   * The proof that settles a lease no sweep can reach. Nothing crosses a restart, so a boot later
   * than the record means that browser stopped heartbeating at the boot at the latest and the
   * local retry cooldown can be counted from that boot instead of from every app restart.
   */
  bootedAtMs?: number;
  now?: () => number;
  /** How long a seat rests once it is known to be resting. Defaults to the pool's own cooldown. */
  cooldownMs?: number;
  refusalCooldownMs?: number;
}

/** States in which the vendor may still be counting a seat, so a verdict is owed. */
const UNSETTLED = ["reserved", "starting", "active", "ending", "pending-recovery"];

/**
 * Settle every licence lease an earlier run left mid-flight, so no key is held back for ever.
 *
 * The pool deliberately refuses to free such a lease on a timestamp: the browser it names may have
 * outlived the app and may still be heartbeating, and handing that key out would buy a refusal the
 * operator cannot explain. It waits for a verdict instead — which makes producing one, on every
 * start and for every lease, this module's whole job.
 *
 * Three things can produce it. The startup sweep reports the browsers it found and how each ended.
 * Its silence counts too, once it has actually read the process table: nothing is running for that
 * lease, so no browser is left to close and none ever will be. And a boot later than the record
 * settles the case no sweep can reach, because no process survives a restart.
 *
 * Only the recoveries half existed before, so a lease interrupted by a reboot was answered by
 * nobody: the record stayed `active`, the pool went on waiting for a recovery that could not
 * arrive, and on a one-key install the operator never got another launch — no deadline, no
 * remedy, and no wait that could end.
 */
export async function reconcileStartupOrphanLeases(
  outcome: OrphanSweepOutcome,
  deps: StartupLeaseReconciliationDeps,
): Promise<StartupLeaseReconciliationSummary> {
  const summary: StartupLeaseReconciliationSummary = {
    confirmed: 0,
    cooling: 0,
    expired: 0,
    pending: 0,
    skipped: 0,
  };

  for (const recovery of outcome.recoveries) {
    await settle(recovery.profileId, recovery.seatReleased, undefined, deps, summary);
  }

  const found = new Set(outcome.recoveries.map((recovery) => recovery.profileId));
  const now = deps.now?.() ?? Date.now();
  for (const record of deps.journal.snapshot()) {
    if (found.has(record.profileId) || !UNSETTLED.includes(record.state)) continue;

    // Two independent ways to know no browser is left for this lease: a restart since the record
    // was written, or a sweep that did read the process table and did not find it. With neither,
    // that browser may still be out there holding the seat, and the key stays held back.
    const movedAtMs = Date.parse(record.updatedAt);
    const killedByReboot =
      deps.bootedAtMs !== undefined && !Number.isNaN(movedAtMs) && deps.bootedAtMs > movedAtMs;
    if (!killedByReboot && !outcome.enumerated) continue;

    // Vendor release is unconfirmed, so the seat rests locally from the boot that
    // killed it, or from now, because within one boot session the death could have been a moment
    // ago and nothing here can date it.
    await settle(record.profileId, false, killedByReboot ? deps.bootedAtMs : now, deps, summary);
  }

  return summary;
}

/** Write one lease's outcome to the journal, then teach the pool what its key may now do. */
async function settle(
  profileId: string,
  seatReleased: boolean,
  restingSinceMs: number | undefined,
  deps: StartupLeaseReconciliationDeps,
  summary: StartupLeaseReconciliationSummary,
): Promise<void> {
  const record = deps.journal.get(profileId);
  if (!record || !UNSETTLED.includes(record.state)) {
    summary.skipped += 1;
    return;
  }

  try {
    // An interrupted start may have lost both refusal writes. Preserve the longer wait durably.
    const uncertainRelease = record.state === "starting" || record.lastErrorCode === "LICENCE_RELEASE_UNCONFIRMED";
    const released = await deps.recorder.released(profileId, seatReleased, uncertainRelease);
    deps.pool.reconcilePersistedLease(record.keyFingerprint, released, restingSinceMs, uncertainRelease);
    if (released) {
      summary.confirmed += 1;
      return;
    }
    if (await retireIfRestOver(profileId, restingSinceMs, deps, uncertainRelease)) summary.expired += 1;
    else summary.cooling += 1;
  } catch (error) {
    summary.pending += 1;
    deps.log?.(
      `[mkt-browser] startup lease reconciliation failed for profile=${profileId}: ${String(error)}`,
    );
  }
}

/**
 * Retire a lease whose rest is already over instead of leaving it `cooling` as of right now.
 *
 * A rest counted from a boot hours ago ran out long ago, but the record carrying it is stamped with
 * the moment it was written — so the next start would read that stamp as the start of the rest and
 * hold the key back all over again. An operator who merely reopened the app would be locked out for
 * another cooldown, once per restart. `expired` records that the local retry wait has elapsed;
 * it does not confirm vendor release.
 */
async function retireIfRestOver(
  profileId: string,
  restingSinceMs: number | undefined,
  deps: StartupLeaseReconciliationDeps,
  uncertainRelease: boolean,
): Promise<boolean> {
  const cooldownMs = uncertainRelease
    ? Math.max(deps.cooldownMs ?? LICENSE_SEAT_COOLDOWN_MS, deps.refusalCooldownMs ?? LICENSE_SEAT_REFUSAL_COOLDOWN_MS)
    : deps.cooldownMs ?? LICENSE_SEAT_COOLDOWN_MS;
  const now = deps.now?.() ?? Date.now();
  if (restingSinceMs === undefined || restingSinceMs + cooldownMs > now) return false;
  await deps.journal.transition(profileId, "expired", { childPid: null });
  return true;
}
