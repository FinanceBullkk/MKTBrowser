/**
 * Staged CDP readiness within a single fixed budget, reusing the supplied
 * session (connect() is idempotent). Stages, each polled on a fixed backoff:
 *   1. `/json/version` answers — the DevTools HTTP endpoint is up.
 *   2. `/json/list` reports at least one `type === "page"` target — Chromium
 *      has actually opened a page (chrome-remote-interface attaches to a page
 *      by default, so connecting before one exists throws).
 *   3. `session.connect()` succeeds — websocket attached + Page.enable done.
 *
 * Throws if the budget is exhausted at any stage; the caller is responsible
 * for tearing down the half-launched browser.
 *
 * `fetch` and `sleep` are injectable so the staged ladder / budget behaviour
 * can be exercised without a real Chromium endpoint.
 */
export interface ReadinessResponseLike {
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface ReadinessSession {
  connect(): Promise<void>;
}

export interface CdpReadinessTimings {
  versionMs: number;
  pageTargetMs: number;
  attachMs: number;
  totalMs: number;
}

export interface ReadinessDeps {
  fetch: (url: string) => Promise<ReadinessResponseLike>;
  sleep: (ms: number) => Promise<void>;
}

const defaultReadinessDeps: ReadinessDeps = {
  fetch: (url) => fetch(url),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function waitForCdpSessionReady(
  port: number,
  session: ReadinessSession,
  budgetMs: number,
  deps: ReadinessDeps = defaultReadinessDeps,
): Promise<CdpReadinessTimings> {
  const startedAtMs = Date.now();
  const deadline = startedAtMs + budgetMs;
  let lastError: unknown = null;
  let versionReady = false;
  let versionReadyAtMs = startedAtMs;

  // Stage 1: /json/version answers.
  while (Date.now() < deadline) {
    try {
      const res = await withinDeadline(
        deps.fetch(`http://127.0.0.1:${port}/json/version`),
        deadline,
        "CDP /json/version fetch",
      );
      if (res.ok) {
        lastError = null;
        versionReady = true;
        versionReadyAtMs = Date.now();
        break;
      }
    } catch (e) {
      lastError = e;
    }
    await readinessBackoff(deps, deadline);
  }
  if (!versionReady) {
    throw new Error(
      `CDP /json/version not ready on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
    );
  }

  // Stage 2: a page target exists.
  let pageReady = false;
  let pageReadyAtMs = versionReadyAtMs;
  while (Date.now() < deadline) {
    try {
      const res = await withinDeadline(
        deps.fetch(`http://127.0.0.1:${port}/json/list`),
        deadline,
        "CDP /json/list fetch",
      );
      if (res.ok) {
        const targets = (await withinDeadline(
          res.json(),
          deadline,
          "CDP /json/list decode",
        )) as Array<{ type?: string }>;
        if (targets.some((t) => t.type === "page")) {
          lastError = null;
          pageReady = true;
          pageReadyAtMs = Date.now();
          break;
        }
      }
    } catch (e) {
      lastError = e;
    }
    await readinessBackoff(deps, deadline);
  }
  if (!pageReady) {
    throw new Error(
      `No CDP page target on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
    );
  }

  // Stage 3: connect + attach (idempotent; returns immediately once attached).
  while (Date.now() < deadline) {
    try {
      await withinDeadline(session.connect(), deadline, "CDP connect/attach");
      const completedAtMs = Date.now();
      return {
        versionMs: versionReadyAtMs - startedAtMs,
        pageTargetMs: pageReadyAtMs - versionReadyAtMs,
        attachMs: completedAtMs - pageReadyAtMs,
        totalMs: completedAtMs - startedAtMs,
      };
    } catch (e) {
      lastError = e;
      await readinessBackoff(deps, deadline);
    }
  }
  throw new Error(
    `CDP connect/attach failed on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
  );
}

async function readinessBackoff(deps: ReadinessDeps, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return;
  await withinDeadline(
    deps.sleep(Math.min(200, remainingMs)),
    deadline,
    "CDP readiness backoff",
  ).catch(() => {});
}

function withinDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(new Error(`${label} exceeded readiness deadline`));

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} exceeded readiness deadline`)),
      remainingMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
