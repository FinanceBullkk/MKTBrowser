/**
 * Watching a launched browser for the moment its last window closes.
 *
 * Extracted from `ChromiumBrowserDriver.ts` on 18 September 2026 without changing behaviour.
 */
import type { WindowWatcher, WindowWatcherShutdownReason } from "./browser-process-tracking.ts";

export function createWindowWatcher(
  port: number,
  startedAt: string,
  isProcessAlive: () => boolean,
  onShutdown: (reason: WindowWatcherShutdownReason) => void,
): WindowWatcher {
  let zeroSinceMs: number | null = null;
  let unreachableSinceMs: number | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const triggerShutdown = (reason: WindowWatcherShutdownReason): void => {
    if (stopped) return;
    stop();
    onShutdown(reason);
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void poll(), 1000);
  };
  const poll = async (): Promise<void> => {
    // Don't start counting "zero windows" until Chromium has had a chance
    // to open its initial window (some 1-2s after spawn).
    const ageMs = Date.now() - new Date(startedAt).getTime();
    if (ageMs < 2000) {
      schedule();
      return;
    }
    try {
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 1000);
      let targets: Array<{ type?: string }>;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw Object.assign(new Error(`CDP returned ${res.status}`), {
            code: `HTTP_${res.status}`,
          });
        }
        targets = (await res.json()) as Array<{ type?: string }>;
      } finally {
        clearTimeout(fetchTimeout);
      }
      unreachableSinceMs = null;
      const targetTypes = targets.map((target) => target.type ?? null);
      const pages = targets.filter((t) => t.type === "page").length;
      if (pages === 0) {
        if (zeroSinceMs === null) {
          zeroSinceMs = Date.now();
        } else if (Date.now() - zeroSinceMs > 1500) {
          // Confirmed: zero pages for >1.5s. Treat as user closing the browser.
          triggerShutdown({ reason: "ZERO-PAGES", targetTypes });
        }
      } else {
        zeroSinceMs = null;
      }
    } catch (error) {
      // A failed poll cannot prove the page count stayed at zero.
      zeroSinceMs = null;
      // A Windows launcher handoff means the tracked process may not be the ChildProcess that
      // emitted exit. Confirm CDP is unavailable before finalizing the externally closed profile.
      if (unreachableSinceMs === null) unreachableSinceMs = Date.now();
      else if (Date.now() - unreachableSinceMs > 1500 && !isProcessAlive()) {
        triggerShutdown({ reason: "CDP-UNREACHABLE", errorCode: fetchErrorCode(error) });
      }
    } finally {
      schedule();
    }
  };

  schedule();
  return { stop };
}

export function fetchErrorCode(error: unknown): string {
  try {
    let current = error;
    const seen = new Set<object>();
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const code = Reflect.get(current, "code");
      if (typeof code === "string" || typeof code === "number") return String(code);
      current = Reflect.get(current, "cause");
    }
    return error instanceof Error ? error.name : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
