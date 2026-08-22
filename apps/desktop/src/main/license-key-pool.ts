/**
 * Which licence key each running profile is using, and which keys are free.
 *
 * The engine binds a session to the key it was given at spawn and refuses a second one with exit
 * 76, so concurrency is per key: N keys the operator holds means up to N profiles at once, one key
 * each. This pool is the bookkeeping for that — it hands out a key nobody is using, remembers who
 * has it, and takes it back on close.
 *
 * Two facts about the engine shape everything here.
 *
 * A key is not free the moment its profile closes. The seat is released during the browser's own
 * shutdown flush, so a close that reached SIGKILL leaves the seat held on the server for the 7-17
 * minutes the lease takes to expire, while this process has no way to release it — session/end
 * wants a lease_id and an instance_id that died with the browser. Such a key goes to `cooling`, not
 * `idle`, or the next launch would pick it and be refused.
 *
 * And the pool's view can be wrong. A seat can be held by something outside this app entirely — a
 * browser left by an earlier crash, another machine on the same key. So `markRefused` exists: when
 * a launch comes back with exit 76 the caller reports it, that key goes cooling, and the caller can
 * try the next one. The pool is a good guess that corrects itself, never an authority.
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
}

interface Slot {
  key: string;
  profileId: string | null;
  coolingUntilMs: number | null;
}

export interface LicenseKeyPoolOptions {
  keys: readonly string[];
  /** How long a key rests after a close that did not release its seat. */
  cooldownMs?: number;
  now?: () => number;
}

/** Enough to identify a key in a log without being able to reuse it. */
export function keyTail(key: string): string {
  return key.length <= 6 ? "*".repeat(key.length) : key.slice(-6);
}

export class LicenseKeyPool {
  private readonly slots: Slot[];
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: LicenseKeyPoolOptions) {
    // Duplicates would advertise capacity the engine will not honour: the same key twice is still
    // one seat, and the second launch would be refused after the operator was told it was free.
    const unique = [...new Set(opts.keys.map((k) => k.trim()).filter((k) => k.length > 0))];
    this.slots = unique.map((key) => ({ key, profileId: null, coolingUntilMs: null }));
    this.cooldownMs = opts.cooldownMs ?? 17 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  private refresh(): void {
    const t = this.now();
    for (const slot of this.slots) {
      if (slot.coolingUntilMs !== null && t >= slot.coolingUntilMs) slot.coolingUntilMs = null;
    }
  }

  private stateOf(slot: Slot): LicenseKeyState {
    if (slot.profileId !== null) return "in-use";
    return slot.coolingUntilMs === null ? "idle" : "cooling";
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

  /** Keys that could be handed out right now. */
  availableCount(): number {
    this.refresh();
    return this.slots.filter((s) => this.stateOf(s) === "idle").length;
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
      if (record.state === "confirmed-released") continue;
      if (record.state === "cooling" || record.state === "terminal-refused") {
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
