import {
  type LicenseCapacityObservation,
  LicenseCapacityObserver,
} from "./license-capacity-observer.ts";
import {
  type LicenseCapacitySnapshot,
  LicenseKeyPool,
} from "./license-key-pool.ts";
import { LicenseLeaseJournal } from "./license-lease-journal.ts";

export type LicenseSeatAvailability =
  | "ready"
  | "checking"
  | "in-use"
  | "cooling"
  | "recovering"
  | "unable-to-verify";

export interface LicenseSeatSnapshot extends LicenseCapacitySnapshot {
  availability: LicenseSeatAvailability;
  reason: string;
  observedAt?: string;
  freshUntil?: string;
  vendorActive?: number;
  vendorLimit?: number;
}

export type LicenseSeatAdmissionReason =
  | "ADMISSION_BUSY"
  | "NO_LICENSE_KEY"
  | "LOCAL_SESSION_ACTIVE"
  | "LOCAL_RECOVERY_PENDING"
  | "LOCAL_CAPACITY_UNAVAILABLE"
  | "LOCAL_STATE_CHANGED"
  | "VENDOR_CAPACITY_OCCUPIED"
  | "VENDOR_ACCESS_DENIED"
  | "VENDOR_RATE_LIMITED"
  | "VENDOR_RESPONSE_MALFORMED"
  | "VENDOR_REQUEST_TIMEOUT"
  | "VENDOR_UNREACHABLE"
  | "JOURNAL_PERSISTENCE_FAILED";

export class LicenseSeatAdmissionError extends Error {
  readonly reason: LicenseSeatAdmissionReason;

  constructor(reason: LicenseSeatAdmissionReason, message = admissionMessage(reason)) {
    super(message);
    this.name = "LicenseSeatAdmissionError";
    this.reason = reason;
  }
}

export interface LicenseSeatCoordinatorOptions {
  pool: LicenseKeyPool;
  journal: LicenseLeaseJournal;
  observer: LicenseCapacityObserver;
  fastReuseEnabled: boolean;
}

export class LicenseSeatCoordinator {
  private readonly pool: LicenseKeyPool;
  private readonly journal: LicenseLeaseJournal;
  private readonly observer: LicenseCapacityObserver;
  private readonly fastReuseEnabled: boolean;
  private admissionBusy = false;
  private refreshInFlight: Promise<LicenseSeatSnapshot> | null = null;
  private revision = 0;
  private transientReason: string | null = null;

  constructor(options: LicenseSeatCoordinatorOptions) {
    this.pool = options.pool;
    this.journal = options.journal;
    this.observer = options.observer;
    this.fastReuseEnabled = options.fastReuseEnabled;
  }

  invalidate(reason: string): void {
    this.revision += 1;
    this.transientReason = stableReason(reason, "LOCAL_STATE_CHANGED");
    this.observer.invalidate();
  }

  snapshot(): LicenseSeatSnapshot {
    const local = this.pool.capacitySnapshot(this.journal.snapshot());
    if (local.active > 0) return withAvailability(local, "in-use", "LOCAL_SESSION_ACTIVE");
    if (local.pendingRecovery > 0) {
      return withAvailability(local, "recovering", "LOCAL_RECOVERY_PENDING");
    }
    if (this.observer.isObserving()) {
      return withAvailability(local, "checking", "CHECKING_VENDOR_CAPACITY");
    }
    if (!this.fastReuseEnabled) {
      return local.free > 0
        ? withAvailability(local, "ready", "CONSERVATIVE_ROLLBACK")
        : withAvailability(local, "cooling", "LOCAL_COOLING");
    }

    const observation = this.observer.freshObservation();
    if (observation) return this.snapshotFromObservation(local, observation);
    if (local.cooling > 0) return withAvailability(local, "cooling", "LOCAL_COOLING");
    if (local.total === 0) return withAvailability(local, "unable-to-verify", "NO_LICENSE_KEY");
    return withAvailability(
      local,
      "unable-to-verify",
      this.observer.latestObservation() ? "CAPACITY_OBSERVATION_STALE" : (this.transientReason ?? "CAPACITY_NOT_CHECKED"),
    );
  }

  refresh(): Promise<LicenseSeatSnapshot> {
    if (!this.fastReuseEnabled || this.admissionBusy) return Promise.resolve(this.snapshot());
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.performRefresh();
    this.refreshInFlight = refresh;
    const clear = () => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async performRefresh(): Promise<LicenseSeatSnapshot> {
    const local = this.pool.capacitySnapshot(this.journal.snapshot());
    if (local.total === 0 || local.active > 0 || local.pendingRecovery > 0) return this.snapshot();
    const candidate = this.pool.admissionCandidate("__capacity_refresh__");
    if (!candidate) return this.snapshot();

    const revision = this.revision;
    const observation = await this.observer.observe(candidate.key);
    if (revision !== this.revision) {
      this.transientReason = "LOCAL_STATE_CHANGED";
      return this.snapshot();
    }
    if (observation.state === "available" && candidate.state === "cooling") {
      await this.retireCoolingHold(candidate.keyFingerprint);
    }
    this.transientReason = null;
    return this.snapshot();
  }

  async runAdmission<T>(profileId: string, attempt: (key: string) => Promise<T>): Promise<T> {
    if (this.admissionBusy || this.refreshInFlight) {
      throw new LicenseSeatAdmissionError("ADMISSION_BUSY");
    }
    this.admissionBusy = true;
    try {
      const local = this.pool.capacitySnapshot(this.journal.snapshot());
      if (local.total === 0) throw new LicenseSeatAdmissionError("NO_LICENSE_KEY");
      if (local.active > 0) throw new LicenseSeatAdmissionError("LOCAL_SESSION_ACTIVE");
      if (local.pendingRecovery > 0) {
        throw new LicenseSeatAdmissionError("LOCAL_RECOVERY_PENDING");
      }

      const candidate = this.pool.admissionCandidate(profileId);
      if (!candidate) throw new LicenseSeatAdmissionError("LOCAL_CAPACITY_UNAVAILABLE");
      if (this.fastReuseEnabled) {
        const revision = this.revision;
        const observation = await this.observer.observe(candidate.key);
        if (revision !== this.revision) {
          throw new LicenseSeatAdmissionError("LOCAL_STATE_CHANGED");
        }
        const refusal = observationAdmissionReason(observation);
        if (refusal) throw new LicenseSeatAdmissionError(refusal);
        if (candidate.state === "cooling") {
          await this.retireCoolingHold(candidate.keyFingerprint);
          // Persisting the retired hold yields to the event loop. A close or engine change may
          // arrive during that write, so re-check before reserving the key and starting the engine.
          if (revision !== this.revision) {
            throw new LicenseSeatAdmissionError("LOCAL_STATE_CHANGED");
          }
        }
      }

      const key = this.pool.acquireCandidate(profileId, candidate.key);
      if (!key) throw new LicenseSeatAdmissionError("LOCAL_STATE_CHANGED");
      this.revision += 1;
      this.transientReason = null;
      this.observer.invalidate();
      try {
        return await attempt(key);
      } catch (error) {
        this.invalidate("launch-failed");
        throw error;
      }
    } finally {
      this.admissionBusy = false;
    }
  }

  private async retireCoolingHold(keyFingerprint: string): Promise<void> {
    try {
      const retired = await this.journal.expireBlockingKeyLease(
        keyFingerprint,
        "FRESH_CAPACITY_AVAILABLE",
      );
      if (!retired || !this.pool.retireObservedAvailableHold(keyFingerprint)) {
        throw new LicenseSeatAdmissionError("LOCAL_STATE_CHANGED");
      }
    } catch (error) {
      if (error instanceof LicenseSeatAdmissionError) throw error;
      throw new LicenseSeatAdmissionError("JOURNAL_PERSISTENCE_FAILED");
    }
  }

  private snapshotFromObservation(
    local: LicenseCapacitySnapshot,
    observation: LicenseCapacityObservation,
  ): LicenseSeatSnapshot {
    const details = observationDetails(observation);
    if (observation.state === "available" && local.free > 0) {
      return { ...withAvailability(local, "ready", observation.reason), ...details };
    }
    if (observation.state === "occupied") {
      return { ...withAvailability(local, "in-use", observation.reason), ...details };
    }
    return { ...withAvailability(local, "unable-to-verify", observation.reason), ...details };
  }
}

function observationAdmissionReason(
  observation: LicenseCapacityObservation,
): LicenseSeatAdmissionReason | null {
  switch (observation.state) {
    case "available": return null;
    case "occupied": return "VENDOR_CAPACITY_OCCUPIED";
    case "denied": return "VENDOR_ACCESS_DENIED";
    case "rate-limited": return "VENDOR_RATE_LIMITED";
    case "malformed": return "VENDOR_RESPONSE_MALFORMED";
    case "timeout": return "VENDOR_REQUEST_TIMEOUT";
    case "unreachable": return "VENDOR_UNREACHABLE";
  }
}

function withAvailability(
  capacity: LicenseCapacitySnapshot,
  availability: LicenseSeatAvailability,
  reason: string,
): LicenseSeatSnapshot {
  return { ...capacity, availability, reason };
}

function observationDetails(observation: LicenseCapacityObservation) {
  return {
    observedAt: observation.observedAt,
    freshUntil: observation.freshUntil,
    ...(observation.active === null ? {} : { vendorActive: observation.active }),
    ...(observation.limit === null ? {} : { vendorLimit: observation.limit }),
  };
}

function stableReason(value: string, fallback: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

function admissionMessage(reason: LicenseSeatAdmissionReason): string {
  const messages: Record<LicenseSeatAdmissionReason, string> = {
    ADMISSION_BUSY: "Another browser availability check is already running. Try once after it finishes.",
    NO_LICENSE_KEY: "No CloakBrowser licence key is configured on this PC.",
    LOCAL_SESSION_ACTIVE: "A browser profile is already open. Close it before opening another profile.",
    LOCAL_RECOVERY_PENDING: "MKT Browser is recovering a prior browser session. Finish recovery before trying once.",
    LOCAL_CAPACITY_UNAVAILABLE: "Local browser capacity is still cooling. Check availability before trying once.",
    LOCAL_STATE_CHANGED: "Browser state changed while availability was checked. Check again before trying once.",
    VENDOR_CAPACITY_OCCUPIED: "The licence provider reports that all session capacity is in use.",
    VENDOR_ACCESS_DENIED: "The licence provider denied the capacity check. Verify the configured licence.",
    VENDOR_RATE_LIMITED: "The licence provider rate-limited the capacity check. Wait before checking again.",
    VENDOR_RESPONSE_MALFORMED: "The licence provider returned an unreadable capacity response.",
    VENDOR_REQUEST_TIMEOUT: "The licence provider did not answer the capacity check in time.",
    VENDOR_UNREACHABLE: "The licence provider could not be reached to verify capacity.",
    JOURNAL_PERSISTENCE_FAILED: "MKT Browser could not durably record licence capacity state.",
  };
  return messages[reason];
}
