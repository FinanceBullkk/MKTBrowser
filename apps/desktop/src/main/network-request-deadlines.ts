export const ENGINE_METADATA_TIMEOUT_MS = 10_000;
export const ELECTRON_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
export const ELECTRON_RESPONSE_BODY_IDLE_TIMEOUT_MS = 60_000;
export const ELECTRON_WRITE_FINALIZATION_TIMEOUT_MS = 30_000;

export interface DeadlineClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NetworkRequestDeadlineController {
  responseStarted(): void;
  bodyActivity(): void;
  finalizationStarted(): void;
  complete(): void;
}

interface NetworkRequestDeadlineOptions {
  label: string;
  headerTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  abort: () => void;
  onTimeout: (error: Error) => void;
  clock?: DeadlineClock;
}

const systemClock: DeadlineClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function requirePositiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number.`);
  }
  return value;
}

/** Bounds response headers, streamed-body idle gaps, and output finalization. */
export function createNetworkRequestDeadlines(
  options: NetworkRequestDeadlineOptions,
): NetworkRequestDeadlineController {
  const headerTimeoutMs = requirePositiveTimeout(
    options.headerTimeoutMs ?? ELECTRON_RESPONSE_HEADER_TIMEOUT_MS,
    "headerTimeoutMs",
  );
  const bodyIdleTimeoutMs = requirePositiveTimeout(
    options.bodyIdleTimeoutMs ?? ELECTRON_RESPONSE_BODY_IDLE_TIMEOUT_MS,
    "bodyIdleTimeoutMs",
  );
  const finalizationTimeoutMs = requirePositiveTimeout(
    options.finalizationTimeoutMs ?? ELECTRON_WRITE_FINALIZATION_TIMEOUT_MS,
    "finalizationTimeoutMs",
  );
  const clock = options.clock ?? systemClock;
  let phase: "headers" | "body" | "finalization" | "complete" = "headers";
  let timer: unknown;

  const clear = (): void => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };

  const expire = (
    stage: "response headers" | "response body activity" | "download finalization",
    timeoutMs: number,
  ): void => {
    if (phase === "complete") return;
    phase = "complete";
    clear();
    const error = new Error(`${options.label} timed out waiting for ${stage} after ${timeoutMs}ms.`);
    try {
      options.onTimeout(error);
    } finally {
      try {
        options.abort();
      } catch {
        // The timeout failure is already authoritative; abort is best-effort cleanup.
      }
    }
  };

  const armHeader = (): void => {
    clear();
    timer = clock.setTimeout(
      () => expire("response headers", headerTimeoutMs),
      headerTimeoutMs,
    );
  };

  const armBody = (): void => {
    clear();
    timer = clock.setTimeout(
      () => expire("response body activity", bodyIdleTimeoutMs),
      bodyIdleTimeoutMs,
    );
  };

  const armFinalization = (): void => {
    clear();
    timer = clock.setTimeout(
      () => expire("download finalization", finalizationTimeoutMs),
      finalizationTimeoutMs,
    );
  };

  armHeader();

  return {
    responseStarted(): void {
      if (phase !== "headers") return;
      phase = "body";
      armBody();
    },
    bodyActivity(): void {
      if (phase === "body") armBody();
    },
    finalizationStarted(): void {
      if (phase !== "body") return;
      phase = "finalization";
      armFinalization();
    },
    complete(): void {
      if (phase === "complete") return;
      phase = "complete";
      clear();
    },
  };
}
