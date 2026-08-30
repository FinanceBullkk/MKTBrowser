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
 * A key is not free the moment its profile closes. The seat is released during the browser's own
 * shutdown flush, so a close that reached SIGKILL leaves the seat held on the server until the
 * lease expires, while this process has no way to release it — session/end wants a lease_id and an
 * instance_id that died with the browser. Such a key goes to `cooling`, not `idle`, or the next
 * launch would pick it and be refused.
 *
 * That expiry was measured on 24 August 2026 by abandoning a lease and asking for it back every
 * 30s: reclaimed after 15.1 minutes, against the `lease_ttl_seconds: 900` the server declares — so
 * the vendor enforces its stated TTL to within seconds, and an independent 15m19s observation in
 * the acceptance matrix agrees. The 17-minute cooldown below is that 900s plus two minutes of
 * margin for clock skew. Do not shorten it below 15 minutes.
 *
 * And the pool's view can be wrong. A seat can be held by something outside this app entirely — a
 * browser left by an earlier crash, another machine on the same key. So `markRefused` exists: when
 * a launch comes back with exit 76 the caller reports it, that key goes cooling, and the caller can
 * try the next one. The pool is a good guess that corrects itself, never an authority.
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
}

export interface LicenseCapacityLeaseRecord {
  keyFingerprint: string;
  state: LicenseLeaseState;
  updatedAt?: string;
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
 * How long a key rests after a close that did not hand its seat back.
 *
 * The vendor's measured lease TTL is 900s; this is that plus two minutes for clock skew. Do not
 * shorten it below 15 minutes.
 */
export const LICENSE_SEAT_COOLDOWN_MS = 17 * 60_000;

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
  private readonly now: () => number;

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
      const movedAtMs = Date.parse(record.updatedAt);
      this.rest(slot, Number.isNaN(movedAtMs) ? t : Math.min(movedAtMs, t), t);
    }
  }

  /** Hold a key back until `restingSinceMs` plus a cooldown, unless that moment has already passed. */
  private rest(slot: Slot, restingSinceMs: number, nowMs: number): void {
    const until = restingSinceMs + this.cooldownMs;
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
   * `seatReleased` is the caller's honest answer to "did the browser get to flush its own
   * shutdown". Only Browser.close does; a SIGTERM or SIGKILL does not, and claiming otherwise
   * would send the next launch at a seat the server still considers taken.
   */
  release(profileId: string, seatReleased: boolean): void {
    const slot = this.slots.find((s) => s.profileId === profileId);
    if (!slot) return;
    slot.profileId = null;
    slot.coolingUntilMs = seatReleased ? null : this.now() + this.cooldownMs;
  }

  /** The engine refused this key: something holds its seat that this pool cannot see. */
  markRefused(key: string): void {
    const slot = this.slots.find((s) => s.key === key);
    if (!slot) return;
    slot.profileId = null;
    slot.coolingUntilMs = this.now() + this.cooldownMs;
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
  ): void {
    const slot = this.slots.find(
      (candidate) => fingerprintLicenseKey(candidate.key) === keyFingerprint,
    );
    if (!slot) return;
    slot.profileId = null;
    slot.blockedByUnreconciledLease = false;
    slot.coolingUntilMs = null;
    if (!seatReleased) this.rest(slot, restingSinceMs ?? this.now(), this.now());
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
   * key is held by a profile that is still open and will free it whenever it is closed. Only a
   * cooling key has a time attached, because only a cooling key is waiting on the vendor's clock
   * rather than on the operator.
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
    const coolingFingerprints = new Set<string>();
    for (const record of leaseRecords) {
      if (record.state === "confirmed-released" || record.state === "expired") continue;
      if (record.state === "cooling" || record.state === "terminal-refused") {
        const updatedAt = record.updatedAt === undefined ? Number.NaN : Date.parse(record.updatedAt);
        if (!Number.isNaN(updatedAt) && updatedAt + this.cooldownMs <= this.now()) continue;
        coolingFingerprints.add(record.keyFingerprint);
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
    for (const slot of this.slots) {
      const fingerprint = fingerprintLicenseKey(slot.key);
      if (slot.profileId !== null) capacity.active += 1;
      else if (slot.coolingUntilMs !== null || coolingFingerprints.has(fingerprint)) {
        capacity.cooling += 1;
      } else if (pendingFingerprints.has(fingerprint)) capacity.pendingRecovery += 1;
      else capacity.free += 1;
    }
    return capacity;
  }
}
