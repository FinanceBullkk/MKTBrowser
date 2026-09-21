/**
 * Writing the launch/close path's licence-seat facts into the persistent lease journal.
 *
 * The journal and its recovery logic were built and tested but never connected to a launch, so the
 * only live record of which seats were held was `LicenseKeyPool`, which lives in memory. Every
 * restart therefore forgot that a crashed browser had left a session open on the vendor, offered
 * the key as free, and got the next launch refused. This module is the connection.
 *
 * Two rules shape it.
 *
 * A journal write must fail a licensed launch before the browser can create a vendor session.
 * Launching without durable seat truth makes the next restart unsafe, so failures are logged and
 * rethrown. Shutdown callers convert a failed release write into an in-memory cooling verdict.
 *
 * And a transition must be legal from wherever the record actually is. The driver reaches these
 * from several paths — a clean close, a kill, a refusal, a launch that died before it spawned —
 * and the journal rejects an illegal move rather than papering over it, so the current state is
 * read first and the legal route chosen from there.
 */

import type { LicenseLeaseRecord, LicenseLeaseState } from "./license-lease-journal.ts";

/** The part of `LicenseLeaseJournal` this module uses. Narrowed so tests need no real file. */
export interface LeaseJournalLike {
  get(profileId: string): LicenseLeaseRecord | null;
  reserve(input: {
    profileId: string;
    key: string;
    staleLeaseExpired?: boolean;
  }): Promise<LicenseLeaseRecord>;
  transition(
    profileId: string,
    nextState: LicenseLeaseState,
    updates?: { childPid?: number | null; lastErrorCode?: string | null },
  ): Promise<LicenseLeaseRecord>;
  releaseUnstartedReservation(profileId: string): Promise<LicenseLeaseRecord>;
}

export type LeaseRecorderLogger = (message: string) => void;

/** States from which the browser may already hold a session the vendor is counting. */
export class LicenseLeaseRecorder {
  // Written out rather than as constructor parameter properties: the main-process tests run under
  // Node's strip-only TypeScript mode, which rejects that syntax.
  private readonly journal: LeaseJournalLike;
  private readonly log: LeaseRecorderLogger;
  private readonly pendingRefusals = new Set<string>();

  constructor(journal: LeaseJournalLike, log: LeaseRecorderLogger = () => undefined) {
    this.journal = journal;
    this.log = log;
  }

  private async attempt(what: string, profileId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log(
        `[mkt-browser] lease journal ${what} failed for profile=${profileId}: ${String(error)}`,
      );
      throw new Error(`License lease journal ${what} failed.`, { cause: error });
    }
  }

  /** A key has been picked for this profile, but nothing has been spawned yet. */
  async reserved(profileId: string, key: string): Promise<void> {
    await this.attempt("reserve", profileId, () =>
      this.journal.reserve({ profileId, key, staleLeaseExpired: true }),
    );
  }

  /** The engine is about to spawn, so a vendor session may exist after the next instruction. */
  async started(profileId: string, childPid: number | null): Promise<void> {
    if (this.journal.get(profileId)?.state !== "reserved") {
      throw new Error(`License lease journal starting failed for profile=${profileId}.`);
    }
    await this.attempt("starting", profileId, () =>
      this.journal.transition(profileId, "starting", { childPid }),
    );
  }

  /** The launch completed and the browser is serving. */
  async active(profileId: string): Promise<void> {
    if (this.journal.get(profileId)?.state !== "starting") {
      throw new Error(`License lease journal active failed for profile=${profileId}.`);
    }
    await this.attempt("active", profileId, () => this.journal.transition(profileId, "active"));
  }

  /**
   * The browser is gone.
   *
   * `seatReleased` requires independent vendor release proof. Local shutdown alone is not proof;
   * an unstarted reservation is the only production path that can be released immediately.
   */
  async released(profileId: string, seatReleased: boolean, uncertainRelease = false): Promise<boolean> {
    // Cleanup must not downgrade a failed refusal write to the shorter ordinary-close wait.
    if (this.pendingRefusals.has(profileId)) await this.refused(profileId);
    const state = this.journal.get(profileId)?.state;
    if (state === undefined) return seatReleased;

    if (state === "reserved") {
      // Never spawned, so no session was ever opened — and leaving the reservation behind would
      // block this key for every other profile.
      await this.attempt("release-unstarted", profileId, () =>
        this.journal.releaseUnstartedReservation(profileId),
      );
      return true;
    }
    if (state === "confirmed-released" || state === "expired") return true;
    if (state === "cooling" || state === "terminal-refused") return false;

    await this.attempt("ending", profileId, async () => {
      // A browser that died while still `starting` never reached `active`, and the journal has no
      // direct route from there to `ending` — it insists such a lease be marked for recovery
      // first, which is exactly what an unfinished launch is.
      let currentState = state;
      if (currentState === "starting") {
        await this.journal.transition(profileId, "pending-recovery", {
          lastErrorCode: uncertainRelease ? "LICENCE_RELEASE_UNCONFIRMED" : "LAUNCH_ENDED_EARLY",
        });
        currentState = "pending-recovery";
        if (!seatReleased) {
          await this.journal.transition(profileId, "cooling", { childPid: null });
          return;
        }
      }
      if (currentState === "active" || currentState === "pending-recovery") {
        await this.journal.transition(profileId, "ending");
        currentState = "ending";
      }
      if (currentState !== "ending") {
        throw new Error(`A license lease in ${currentState} cannot complete release.`);
      }
      await this.journal.transition(profileId, seatReleased ? "confirmed-released" : "cooling", {
        childPid: null,
        lastErrorCode: seatReleased ? null : uncertainRelease ? "LICENCE_RELEASE_UNCONFIRMED" : undefined,
      });
    });
    return seatReleased;
  }

  /**
   * The engine refused this key: something the pool cannot see holds its seat.
   *
   * Recorded as terminal so a restart keeps resting the key instead of offering it again, which is
   * the loop that made one stale seat cost every launch a refusal.
   */
  async refused(profileId: string, errorCode = "LICENCE_SEAT_REFUSED"): Promise<void> {
    const state = this.journal.get(profileId)?.state;
    if (state === "terminal-refused") {
      this.pendingRefusals.delete(profileId);
      return;
    }
    if (state !== "reserved" && state !== "starting") {
      throw new Error(`License lease journal terminal-refused failed for profile=${profileId}.`);
    }
    this.pendingRefusals.add(profileId);
    await this.attempt("terminal-refused", profileId, () =>
      this.journal.transition(profileId, "terminal-refused", {
        childPid: null,
        lastErrorCode: errorCode,
      }),
    );
    this.pendingRefusals.delete(profileId);
  }
}
