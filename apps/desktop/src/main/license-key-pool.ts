/**
 * Which licence key each running profile is using, and which keys are free.
 *
 * The engine binds a session to the key it was given at spawn and refuses a second one with exit
 * 76, so concurrency is per key when a verified multi-seat entitlement enables more than one key:
 * one key per profile. This pool is the bookkeeping for that capability — it hands out a key nobody
 * is using, remembers who has it, and takes it back on close. The default one-seat startup path
 * passes only the primary key, even when settings retain additional keys for a future entitlement.
 *
 * Two facts about the engine shape everything here.
 *
 * A key is not free the moment its profile closes. Even Browser.close and exit code 0 can leave
 * the vendor session alive. session/end requires lease_id and instance_id that are not available
 * to this app, so every unconfirmed release rests locally before another manual attempt.
 *
 * September measurements include refusals after 18.9 minutes. The waits below are conservative
 * local retry policies, not a promise that the vendor has released a seat at their deadlines.
 *
 * And the pool's view can be wrong. A seat can be held by something outside this app entirely — a
 * browser left by an earlier crash, another machine on the same key. So `markRefused` exists: when
 * a launch comes back with exit 76 the caller reports it and stops. Only a later operator request
 * may try again. The pool is local bookkeeping, never vendor authority.
 *
 * Every hold here therefore has to end on some clock, bar one. A lease rebuilt from the journal
 * that was still mid-flight when it was written describes a browser that may have outlived the app
 * and may still be heartbeating, so no timestamp settles it and the key is held back until someone
 * says what became of that browser. `reconcilePersistedLease` is that verdict, and it is owed on
 * every start — a hold with no clock and nobody to end it is permanent, and on a one-key install a
 * permanent hold is the whole product.
 */

import { fingerprintLicenseKey, type LicenseLeaseState } from "./license-lease-journal.ts";

export type LicenseKeyState = "idle" | "in-use" | "cooling";

export interface LicenseKeyStatus {
  /** Last 6 characters only. A full key in a log or an IPC payload is a credential leak. */
  keyTail: string;
  state: LicenseKeyState;
  profileId: string | null;
  cooldownEndsAt: string | null;
}

export interface LicenseKeyPoolSnapshot {
  total: number;
  idle: number;
  inUse: number;
  cooling: number;
  keys: LicenseKeyStatus[];
}

export interface LicenseCapacitySnapshot {
  total: number;
  free: number;
  active: number;
  pendingRecovery: number;
  cooling: number;
  /** Earliest local retry, not a vendor release guarantee. Absent when unknown or a key is free. */
  retryAt?: string;
}

export interface LicenseCapacityLeaseRecord {
  keyFingerprint: string;
  state: LicenseLeaseState;
  updatedAt?: string;
  lastErrorCode?: string | null;
}

/**
 * A persisted lease, used to rebuild seat state after a restart.
 *
 * `updatedAt` is when the lease last moved. The seat the vendor still counts expires a lease TTL
 * after that moment, not a TTL after this process happened to start, so cooling has to be measured
 * from the record rather than from now.
 */
export interface LicenseSeatLeaseRecord extends LicenseCapacityLeaseRecord {
  updatedAt: string;
}

interface Slot {
  key: string;
  profileId: string | null;
  coolingUntilMs: number | null;
  blockedByUnreconciledLease: boolean;
}

export interface LicenseKeyPoolOptions {
  keys: readonly string[];
  /** How long a key rests after a close that did not release its seat. */
  cooldownMs?: number;
  refusalCooldownMs?: number;
  now?: () => number;
  /**
   * Leases persisted by an earlier run.
   *
   * Without these the pool starts every key `idle`, which is only true if the last run closed every
   * browser cleanly. After a crash, a kill, or a power loss the vendor still counts those seats, so
   * a fresh pool hands out a key that the engine then refuses — and on a one-key install that is
   * the whole product unavailable for a lease, with no explanation the operator can act on.
   */
  leaseRecords?: readonly LicenseSeatLeaseRecord[];
}

/**
 * Conservative local waits after close/refusal. Neither duration proves vendor availability.
 */
export const LICENSE_SEAT_COOLDOWN_MS = 25 * 60_000;
export const LICENSE_SEAT_REFUSAL_COOLDOWN_MS = 30 * 60_000;

/** Enough to identify a key in a log without being able to reuse it. */
export function keyTail(key: string): string {
  return key.length <= 6 ? "*".repeat(key.length) : key.slice(-6);
}

/**
 * Might the vendor still be counting a seat for a lease left in this state?
 *
 * `reserved` is the one non-final state that never reached the engine: a key was picked but no
 * process was spawned, so no session was ever opened. Everything from `starting` onwards may have
 * opened one, and only `confirmed-released` proves it was given back.
 */
function holdsSeat(state: LicenseLeaseState): boolean {
  return state !== "confirmed-released" && state !== "reserved" && state !== "expired";
}

export class LicenseKeyPool {
  private readonly slots: Slot[];
  private readonly cooldownMs: number;
  private readonly refusalCooldownMs: number;
  private readonly now: () => number;
  private readonly leaseDeadlines = new Map<string, { revision: string; deadline: number }>();

  constructor(opts: LicenseKeyPoolOptions) {
    // Duplicates would advertise capacity the engine will not honour: the same key twice is still
    // one seat, and the second launch would be refused after the operator was told it was free.
    const unique = [...new Set(opts.keys.map((k) => k.trim()).filter((k) => k.length > 0))];
    this.slots = unique.map((key) => ({
      key,
      profileId: null,
      coolingUntilMs: null,
      blockedByUnreconciledLease: false,
    }));
    this.cooldownMs = opts.cooldownMs ?? LICENSE_SEAT_COOLDOWN_MS;
    this.refusalCooldownMs = Math.max(
      this.cooldownMs,
      opts.refusalCooldownMs ?? LICENSE_SEAT_REFUSAL_COOLDOWN_MS,
    );
    this.now = opts.now ?? Date.now;
    if (opts.leaseRecords?.length) this.seedFromLeases(opts.leaseRecords);
  }

  /**
   * Start keys whose last recorded lease never reached a confirmed release in `cooling`.
   *
   * A lease still resting when it was written is one this process cannot release: `session/end`
   * wants a lease_id and an instance_id that died with the browser. All this can do is decline to
   * offer the key until the vendor's own TTL has run, counted from when the lease last moved.
   *
   * An unparseable or future timestamp is treated as "just now", which errs towards resting a key
   * that may in fact be free. That costs a wait; the other direction costs a refused launch the
   * operator cannot explain.
   */
  private seedFromLeases(records: readonly LicenseSeatLeaseRecord[]): void {
    const t = this.now();
    for (const record of records) {
      if (!holdsSeat(record.state)) continue;
      const slot = this.slots.find((s) => fingerprintLicenseKey(s.key) === record.keyFingerprint);
      if (!slot) continue;
      if (["starting", "active", "ending", "pending-recovery"].includes(record.state)) {
        // These records may describe a browser that kept heartbeating after the app died. Its old
        // journal timestamp is not a lease-expiry clock, so only explicit recovery may free it —
        // which startup reconciliation owes on every start, however that browser ended.
        slot.blockedByUnreconciledLease = true;
        continue;
      }
      const deadline = this.leaseRetryAt(record, t);
      if (deadline > t) slot.coolingUntilMs = Math.max(slot.coolingUntilMs ?? 0, deadline);
    }
  }

  private leaseRetryAt(record: LicenseCapacityLeaseRecord, now: number): number {
    const revision = `${record.state}:${record.updatedAt}:${record.lastErrorCode}`;
    const cached = this.leaseDeadlines.get(record.keyFingerprint);
    if (cached?.revision === revision) return cached.deadline;
    const movedAt = Date.parse(record.updatedAt ?? "");
    const duration = record.state === "terminal-refused" || record.lastErrorCode === "LICENCE_RELEASE_UNCONFIRMED"
      ? this.refusalCooldownMs : this.cooldownMs;
    const deadline = (Number.isFinite(movedAt) ? Math.min(movedAt, now) : now) + duration;
    this.leaseDeadlines.set(record.keyFingerprint, { revision, deadline });
    return deadline;
  }

  /** Hold a key back until `restingSinceMs` plus a cooldown, unless that moment has already passed. */
  private rest(slot: Slot, restingSinceMs: number, nowMs: number, durationMs = this.cooldownMs): void {
    const until = restingSinceMs + durationMs;
    if (until <= nowMs) return;
    slot.coolingUntilMs = Math.max(slot.coolingUntilMs ?? 0, until);
  }

  private refresh(): void {
    const t = this.now();
    for (const slot of this.slots) {
      if (slot.coolingUntilMs !== null && t >= slot.coolingUntilMs) slot.coolingUntilMs = null;
    }
  }

  private stateOf(slot: Slot): LicenseKeyState {
    if (slot.profileId !== null) return "in-use";
    return slot.coolingUntilMs === null && !slot.blockedByUnreconciledLease ? "idle" : "cooling";
  }

  /**
   * Reserve a key for `profileId`, or null when none is free.
   *
   * Re-reserving for a profile that already holds one returns the same key, so a retry does not
   * quietly consume a second seat for the same profile.
   */
  acquire(profileId: string): string | null {
    this.refresh();
    const held = this.slots.find((s) => s.profileId === profileId);
    if (held) return held.key;
    const free = this.slots.find((s) => this.stateOf(s) === "idle");
    if (!free) return null;
    free.profileId = profileId;
    return free.key;
  }

  /** The key reserved for a profile, without reserving one. */
  keyFor(profileId: string): string | null {
    return this.slots.find((s) => s.profileId === profileId)?.key ?? null;
  }

  /**
   * Hand a key back.
   *
   * `seatReleased` requires independent release proof, or proof no engine was started.
   * A clean browser shutdown alone never supplies that proof.
   */
  release(profileId: string, seatReleased = false): void {
    const slot = this.slots.find((s) => s.profileId === profileId);
    if (!slot) return;
    slot.profileId = null;
    if (seatReleased) slot.coolingUntilMs = null;
    else this.rest(slot, this.now(), this.now());
  }

  /** The engine refused this key: something holds its seat that this pool cannot see. */
  markRefused(key: string): void {
    const slot = this.slots.find((s) => s.key === key);
    if (!slot) return;
    slot.profileId = null;
    this.rest(slot, this.now(), this.now(), this.refusalCooldownMs);
  }

  /**
   * Apply the verified outcome of a persisted lease reconciled during startup.
   *
   * `restingSinceMs` is when the seat started resting, for a caller that can prove the browser
   * died earlier than this moment — a machine boot, say. Omitted means it died just now, which is
   * the safe assumption whenever nothing better is known.
   */
  reconcilePersistedLease(
    keyFingerprint: string,
    seatReleased: boolean,
    restingSinceMs?: number,
    uncertainRelease = false,
  ): void {
    const slot = this.slots.find(
      (candidate) => fingerprintLicenseKey(candidate.key) === keyFingerprint,
    );
    if (!slot) return;
    slot.profileId = null;
    slot.blockedByUnreconciledLease = false;
    slot.coolingUntilMs = null;
    if (!seatReleased) this.rest(slot, restingSinceMs ?? this.now(), this.now(),
      uncertainRelease ? this.refusalCooldownMs : this.cooldownMs);
  }

  /** Keys that could be handed out right now. */
  availableCount(): number {
    this.refresh();
    return this.slots.filter((s) => this.stateOf(s) === "idle").length;
  }

  /**
   * When the next key becomes usable, for telling an operator how long the wait is.
   *
   * Null means the wait has no deadline this pool can name: either a key is free already, or every
   * key is held by a profile that is still open. Only a cooling key has a local retry deadline.
   */
  nextFreeAtMs(): number | null {
    this.refresh();
    if (this.slots.some((s) => this.stateOf(s) === "idle")) return null;
    const cooling = this.slots
      .filter((s) => this.stateOf(s) === "cooling" && s.coolingUntilMs !== null)
      .map((s) => s.coolingUntilMs as number);
    return cooling.length > 0 ? Math.min(...cooling) : null;
  }

  snapshot(): LicenseKeyPoolSnapshot {
    this.refresh();
    const keys = this.slots.map((slot) => ({
      keyTail: keyTail(slot.key),
      state: this.stateOf(slot),
      profileId: slot.profileId,
      cooldownEndsAt:
        slot.coolingUntilMs === null ? null : new Date(slot.coolingUntilMs).toISOString(),
    }));
    return {
      total: keys.length,
      idle: keys.filter((k) => k.state === "idle").length,
      inUse: keys.filter((k) => k.state === "in-use").length,
      cooling: keys.filter((k) => k.state === "cooling").length,
      keys,
    };
  }

  capacitySnapshot(
    leaseRecords: readonly LicenseCapacityLeaseRecord[] = [],
  ): LicenseCapacitySnapshot {
    this.refresh();
    const pendingFingerprints = new Set<string>();
    const coolingDeadlines = new Map<string, number>();
    const now = this.now();
    for (const record of leaseRecords) {
      if (record.state === "confirmed-released" || record.state === "expired") continue;
      if (record.state === "cooling" || record.state === "terminal-refused") {
        const deadline = this.leaseRetryAt(record, now);
        if (deadline <= now) continue;
        coolingDeadlines.set(record.keyFingerprint, deadline);
      } else {
        pendingFingerprints.add(record.keyFingerprint);
      }
    }

    const capacity: LicenseCapacitySnapshot = {
      total: this.slots.length,
      free: 0,
      active: 0,
      pendingRecovery: 0,
      cooling: 0,
    };
    const retryDeadlines: number[] = [];
    for (const slot of this.slots) {
      const fingerprint = fingerprintLicenseKey(slot.key);
      if (slot.profileId !== null) capacity.active += 1;
      else if (slot.blockedByUnreconciledLease || pendingFingerprints.has(fingerprint)) {
        capacity.pendingRecovery += 1;
      } else if (slot.coolingUntilMs !== null || coolingDeadlines.has(fingerprint)) {
        capacity.cooling += 1;
        const durableDeadline = coolingDeadlines.get(fingerprint);
        const deadline = Math.max(slot.coolingUntilMs ?? 0, durableDeadline ?? 0);
        if (deadline > now) retryDeadlines.push(deadline);
      } else capacity.free += 1;
    }
    if (capacity.free === 0 && retryDeadlines.length > 0) {
      capacity.retryAt = new Date(Math.min(...retryDeadlines)).toISOString();
    }
    return capacity;
  }
}
