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
 * A journal write must never fail a launch that would otherwise work. The journal exists to make
 * the *next* run correct; refusing to open a browser because a bookkeeping file could not be
 * written would trade a real capability for a hypothetical one. So every entry point here reports
 * failure to a logger and returns.
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
  reserve(input: { profileId: string; key: string }): Promise<LicenseLeaseRecord>;
  transition(
    profileId: string,
    nextState: LicenseLeaseState,
    updates?: { childPid?: number | null; lastErrorCode?: string | null },
  ): Promise<LicenseLeaseRecord>;
  releaseUnstartedReservation(profileId: string): Promise<LicenseLeaseRecord>;
}

export type LeaseRecorderLogger = (message: string) => void;

/** States from which the browser may already hold a session the vendor is counting. */
const STARTED_STATES: readonly LicenseLeaseState[] = ["starting", "active"];

export class LicenseLeaseRecorder {
  // Written out rather than as constructor parameter properties: the main-process tests run under
  // Node's strip-only TypeScript mode, which rejects that syntax.
  private readonly journal: LeaseJournalLike;
  private readonly log: LeaseRecorderLogger;

  constructor(journal: LeaseJournalLike, log: LeaseRecorderLogger = () => undefined) {
    this.journal = journal;
    this.log = log;
  }

  private async attempt(what: string, profileId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // Deliberately swallowed, deliberately loud. A lost write costs the next run its seat
      // truth, which is worth knowing about, but it is not worth a refused launch now.
      this.log(
        `[mkt-browser] lease journal ${what} failed for profile=${profileId}: ${String(error)}`,
      );
    }
  }

  /** A key has been picked for this profile, but nothing has been spawned yet. */
  async reserved(profileId: string, key: string): Promise<void> {
    await this.attempt("reserve", profileId, () => this.journal.reserve({ profileId, key }));
  }

  /** The engine process exists, so a session may now be open on the vendor. */
  async started(profileId: string, childPid: number | null): Promise<void> {
    if (this.journal.get(profileId)?.state !== "reserved") return;
    await this.attempt("starting", profileId, () =>
      this.journal.transition(profileId, "starting", { childPid }),
    );
  }

  /** The launch completed and the browser is serving. */
  async active(profileId: string): Promise<void> {
    if (this.journal.get(profileId)?.state !== "starting") return;
    await this.attempt("active", profileId, () => this.journal.transition(profileId, "active"));
  }

  /**
   * The browser is gone.
   *
   * `seatReleased` is the same honest answer the key pool is given: only a shutdown the browser
   * flushed itself hands the session back. Anything else leaves the seat resting, and recording it
   * as released is what makes the next launch pick a key the server still counts as taken.
   */
  async released(profileId: string, seatReleased: boolean): Promise<void> {
    const state = this.journal.get(profileId)?.state;
    if (state === undefined) return;

    if (state === "reserved") {
      // Never spawned, so no session was ever opened — and leaving the reservation behind would
      // block this key for every other profile.
      await this.attempt("release-unstarted", profileId, () =>
        this.journal.releaseUnstartedReservation(profileId),
      );
      return;
    }
    if (!STARTED_STATES.includes(state)) return;

    await this.attempt("ending", profileId, async () => {
      // A browser that died while still `starting` never reached `active`, and the journal has no
      // direct route from there to `ending` — it insists such a lease be marked for recovery
      // first, which is exactly what an unfinished launch is.
      if (state === "starting") {
        await this.journal.transition(profileId, "pending-recovery", {
          lastErrorCode: "LAUNCH_ENDED_EARLY",
        });
        if (!seatReleased) {
          await this.journal.transition(profileId, "cooling", { childPid: null });
          return;
        }
      }
      await this.journal.transition(profileId, "ending");
      await this.journal.transition(profileId, seatReleased ? "confirmed-released" : "cooling", {
        childPid: null,
      });
    });
  }

  /**
   * The engine refused this key: something the pool cannot see holds its seat.
   *
   * Recorded as terminal so a restart keeps resting the key instead of offering it again, which is
   * the loop that made one stale seat cost every launch a refusal.
   */
  async refused(profileId: string, errorCode = "LICENCE_SEAT_REFUSED"): Promise<void> {
    const state = this.journal.get(profileId)?.state;
    if (state !== "reserved" && state !== "starting") return;
    await this.attempt("terminal-refused", profileId, () =>
      this.journal.transition(profileId, "terminal-refused", {
        childPid: null,
        lastErrorCode: errorCode,
      }),
    );
  }
}
