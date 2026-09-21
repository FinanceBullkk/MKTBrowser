export const CLOAKBROWSER_CAPACITY_ENDPOINT =
  "https://cloakbrowser.dev/api/license/session/count";

export type LicenseCapacityObservationState =
  | "available"
  | "occupied"
  | "denied"
  | "rate-limited"
  | "malformed"
  | "timeout"
  | "unreachable";

export interface LicenseCapacityObservation {
  state: LicenseCapacityObservationState;
  reason: string;
  active: number | null;
  limit: number | null;
  /** Response-completion time, not request start or proof of a specific lease release. */
  observedAt: string;
  /** Display-only wall-clock projection; freshness decisions use a monotonic clock. */
  freshUntil: string;
}

type CapacityFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface LicenseCapacityObserverOptions {
  fetch?: CapacityFetch;
  endpoint?: string;
  timeoutMs?: number;
  freshnessMs?: number;
  maxResponseBytes?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
}

interface CachedObservation {
  value: LicenseCapacityObservation;
  expiresAtMonotonicMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FRESHNESS_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;

class ResponseTooLargeError extends Error {}

export class LicenseCapacityObserver {
  private readonly fetchRequest: CapacityFetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly freshnessMs: number;
  private readonly maxResponseBytes: number;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private generation = 0;
  private observedKey: string | null = null;
  private cached: CachedObservation | null = null;
  private inFlight: {
    key: string;
    generation: number;
    promise: Promise<LicenseCapacityObservation>;
  } | null = null;

  constructor(options: LicenseCapacityObserverOptions = {}) {
    this.fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? CLOAKBROWSER_CAPACITY_ENDPOINT;
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.freshnessMs = positiveInteger(options.freshnessMs, DEFAULT_FRESHNESS_MS);
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  }

  observe(key: string): Promise<LicenseCapacityObservation> {
    const normalizedKey = key.trim();
    if (
      this.inFlight?.key === normalizedKey &&
      this.inFlight.generation === this.generation
    ) {
      return this.inFlight.promise;
    }

    if (this.observedKey !== normalizedKey) {
      // A result is scoped to the credential that produced it. Rotating keys while an older
      // request is pending must invalidate both the cached value and that late response.
      this.generation += 1;
      this.cached = null;
      this.observedKey = normalizedKey;
    }

    const generation = this.generation;
    const promise = this.request(normalizedKey).then((observation) => {
      if (generation === this.generation) {
        this.cached = {
          value: observation,
          expiresAtMonotonicMs: this.monotonicNow() + this.freshnessMs,
        };
      }
      return observation;
    });
    this.inFlight = { key: normalizedKey, generation, promise };
    const clear = () => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = null;
  }

  isObserving(): boolean {
    return this.inFlight?.generation === this.generation;
  }

  freshObservation(): LicenseCapacityObservation | null {
    if (!this.cached || this.monotonicNow() > this.cached.expiresAtMonotonicMs) return null;
    return { ...this.cached.value };
  }

  latestObservation(): LicenseCapacityObservation | null {
    return this.cached ? { ...this.cached.value } : null;
  }

  private async request(key: string): Promise<LicenseCapacityObservation> {
    if (!key) return this.result("denied", "LICENSE_KEY_MISSING", null, null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchRequest(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ license_key: key }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        return controller.signal.aborted
          ? this.result("timeout", "REQUEST_TIMEOUT", null, null)
          : this.result("unreachable", "NETWORK_UNREACHABLE", null, null);
      }

      if (response.status === 429) {
        discardResponseBody(response);
        return this.result("rate-limited", "RATE_LIMITED", null, null);
      }
      if (!response.ok) {
        discardResponseBody(response);
        return this.result("denied", `HTTP_${response.status}`, null, null);
      }

      let text: string;
      try {
        text = await readBoundedText(response, this.maxResponseBytes);
      } catch (error) {
        if (controller.signal.aborted) {
          return this.result("timeout", "REQUEST_TIMEOUT", null, null);
        }
        return error instanceof ResponseTooLargeError
          ? this.result("malformed", "RESPONSE_TOO_LARGE", null, null)
          : this.result("unreachable", "NETWORK_UNREACHABLE", null, null);
      }

      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return this.result("malformed", "INVALID_JSON", null, null);
      }

      const record = objectRecord(body);
      const active = record?.active;
      const limit = record?.limit;
      if (
        !Number.isSafeInteger(active) ||
        Number(active) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(active) > Number(limit)
      ) {
        return this.result("malformed", "INVALID_CAPACITY_COUNTS", null, null);
      }

      const state = Number(active) < Number(limit) ? "available" : "occupied";
      return this.result(
        state,
        state === "available" ? "CAPACITY_AVAILABLE" : "CAPACITY_OCCUPIED",
        Number(active),
        Number(limit),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private result(
    state: LicenseCapacityObservationState,
    reason: string,
    active: number | null,
    limit: number | null,
  ): LicenseCapacityObservation {
    const completedAt = this.wallNow();
    return {
      state,
      reason,
      active,
      limit,
      observedAt: new Date(completedAt).toISOString(),
      freshUntil: new Date(completedAt + this.freshnessMs).toISOString(),
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function defaultMonotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}
