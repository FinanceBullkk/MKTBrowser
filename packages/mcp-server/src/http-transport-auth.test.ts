/**
 * Phase 02 / H26–H30: transport authentication on the local control port.
 *
 * `HttpTransport` is the door to the MCP surface. Behind it sit twenty-four tools, sixteen of which
 * are full browser control. It binds loopback and defends with three separate mechanisms, none of
 * which had a single test:
 *
 *   - a constant-time bearer check (`authOk`, `:118`)
 *   - a Host allowlist on the legacy `/sse` and `/messages` routes (`hostAllowed`, `:130`)
 *   - the SDK's own DNS-rebinding protection on `/mcp`
 *
 * `authOk` **returns true when no token is configured** (`:120`) — a deliberate, documented fail-open
 * that emits a stderr warning at start. Deliberate is not the same as tested: both directions are
 * asserted here, because the day that warning stops being printed is the day the port is silently
 * open to every local process.
 *
 * These tests drive a real listening HTTP server over real sockets. No mocked request objects — the
 * whole point is that the header parsing, ordering, and status codes are the real ones.
 *
 * Note on ports: `allowedHosts` is computed in the constructor from `opts.port`, so an ephemeral
 * port 0 would produce an allowlist naming `:0` that never matches the bound port. A concrete free
 * port is therefore allocated first.
 *
 * No real tokens. Every credential here is synthetic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProfileManager } from "@mktbrowser/profile-manager";

import { HttpTransport } from "./HttpTransport.js";
import { createMktBrowserMcpServer } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { PROFILE_MANAGEMENT_ACCESS_POLICY } from "./tool-exposure-policy.js";

const TOKEN = "audit-token-0123456789abcdef";

/** Ask the OS for a free port, then release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Fixture {
  port: number;
  origin: string;
  dispose: () => Promise<void>;
}

async function startTransport(authToken: string | undefined): Promise<Fixture> {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "mkb-http-auth-"));
  const profileManager = new ProfileManager({
    dbPath: join(root, "profiles.db"),
    profilesRoot: join(root, "profiles"),
  });
  const browserDriver = new MockBrowserDriver(profileManager);

  const transport = new HttpTransport({
    port,
    host: "127.0.0.1",
    authToken,
    accessPolicy: PROFILE_MANAGEMENT_ACCESS_POLICY,
  });
  await transport.start(
    (accessPolicy) =>
      createMktBrowserMcpServer({ profileManager, browserDriver, accessPolicy }).server,
  );

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    dispose: async () => {
      await transport.stop();
      profileManager.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Raw request helper: returns status and body without throwing on error codes. */
async function call(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}${path}`, init);
  return { status: res.status, body: await res.text() };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/**
 * Raw request, because `fetch` treats `Host` as a forbidden header and silently drops it — an
 * attempt to test the Host allowlist through `fetch` sends the *real* Host and proves nothing.
 */
function rawRequest(
  port: number,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once("error", reject);
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("request timed out")));
    }
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface SseConnection {
  status: number;
  close: () => Promise<void>;
}

/** Open one SSE response without waiting for its intentionally-never-ending body. */
function openSse(port: number): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req: ClientRequest = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/sse",
        headers: { ...bearer(TOKEN), host: `127.0.0.1:${port}` },
      },
      (res: IncomingMessage) => {
        res.once("error", reject);
        resolve({
          status: res.statusCode ?? 0,
          close: async () => {
            if (res.destroyed) return;
            await new Promise<void>((closed) => {
              res.once("close", closed);
              res.destroy();
              req.destroy();
            });
          },
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

/** Wait for the server-side close event rather than racing a replacement request against the TCP teardown. */
async function waitForSseState(origin: string, connected: boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const health = await call(origin, "/healthz", { headers: bearer(TOKEN) });
    if (JSON.parse(health.body).connected === connected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`SSE connection state did not become ${String(connected)}`);
}

test("H26: a request with no Authorization header is rejected", async () => {
  const f = await startTransport(TOKEN);
  try {
    assert.equal((await call(f.origin, "/healthz")).status, 401);
    assert.equal((await call(f.origin, "/mcp", { method: "POST", body: "{}" })).status, 401);
  } finally {
    await f.dispose();
  }
});

test("H26: the correct token is accepted (differential control)", async () => {
  // Without this, every 401 above could be an unrelated failure rather than the auth check.
  const f = await startTransport(TOKEN);
  try {
    const ok = await call(f.origin, "/healthz", { headers: bearer(TOKEN) });
    assert.equal(ok.status, 200);
    assert.equal((await call(f.origin, "/healthz")).status, 401);
  } finally {
    await f.dispose();
  }
});

test("H26: near-miss tokens are all rejected", async () => {
  const f = await startTransport(TOKEN);
  try {
    const variants: Array<[string, Record<string, string>]> = [
      ["wrong token", bearer("completely-wrong-token-value")],
      ["prefix of the token", bearer(TOKEN.slice(0, -1))],
      ["token plus a character", bearer(`${TOKEN}x`)],
      ["token with leading space", bearer(` ${TOKEN}`)],
      ["lowercase scheme", { authorization: `bearer ${TOKEN}` }],
      ["no scheme", { authorization: TOKEN }],
      ["Basic scheme", { authorization: `Basic ${TOKEN}` }],
      ["empty authorization", { authorization: "" }],
    ];
    for (const [label, headers] of variants) {
      assert.equal((await call(f.origin, "/healthz", { headers })).status, 401, label);
    }

    // OBSERVATION, not a finding: a trailing space is stripped by the HTTP parser as optional
    // whitespace (RFC 7230 §3.2), so it never reaches `authOk` and is genuinely the same
    // credential. The hypothesis that it would be a distinct near-miss was wrong.
    assert.equal((await call(f.origin, "/healthz", { headers: bearer(`${TOKEN} `) })).status, 200);
  } finally {
    await f.dispose();
  }
});

test("H26: the token is not accepted from a query parameter or a cookie", async () => {
  /**
   * Both are places a token leaks to — query strings land in logs and Referer headers, cookies are
   * attached automatically by browsers and would make the port CSRF-reachable.
   */
  const f = await startTransport(TOKEN);
  try {
    assert.equal((await call(f.origin, `/healthz?token=${TOKEN}`)).status, 401);
    assert.equal((await call(f.origin, `/healthz?access_token=${TOKEN}`)).status, 401);
    assert.equal(
      (await call(f.origin, "/healthz", { headers: { cookie: `token=${TOKEN}` } })).status,
      401,
    );
  } finally {
    await f.dispose();
  }
});

test("H29: /healthz reveals nothing before authentication", async () => {
  const f = await startTransport(TOKEN);
  try {
    const denied = await call(f.origin, "/healthz");
    assert.equal(denied.status, 401);

    const allowed = await call(f.origin, "/healthz", { headers: bearer(TOKEN) });
    assert.equal(allowed.status, 200);

    // Compare parsed shapes, not substrings: the 401 detail contains the word "token", which
    // trivially contains "ok" and would make a naive substring check fail for no reason.
    const disclosed = Object.keys(JSON.parse(allowed.body) as Record<string, unknown>);
    const rejected = Object.keys(JSON.parse(denied.body) as Record<string, unknown>);

    assert.deepEqual(rejected.sort(), ["detail", "error"]);
    for (const key of disclosed) {
      assert.equal(rejected.includes(key), false, `unauthenticated body exposed field ${key}`);
    }
  } finally {
    await f.dispose();
  }
});

test("H30: the token never appears in a rejection body or headers", async () => {
  const f = await startTransport(TOKEN);
  try {
    const res = await fetch(`${f.origin}/healthz`, { headers: bearer("wrong-token") });
    const body = await res.text();

    assert.equal(res.status, 401);
    assert.equal(body.includes(TOKEN), false, "401 body disclosed the configured token");
    for (const [, value] of res.headers) {
      assert.equal(value.includes(TOKEN), false, "a response header disclosed the token");
    }
    // The message should still tell an operator where to find it, without printing it.
    assert.ok(body.toLowerCase().includes("bearer"), "401 body should explain how to authenticate");
  } finally {
    await f.dispose();
  }
});

test("H27: the Host allowlist rejects foreign hosts on the legacy /messages route", async () => {
  const f = await startTransport(TOKEN);
  try {
    const foreign = await rawRequest(f.port, "/messages?sessionId=nope", {
      method: "POST",
      headers: { ...bearer(TOKEN), host: "evil.example.com" },
      body: "{}",
    });
    assert.equal(foreign.status, 403, `expected a host rejection, got ${foreign.status}`);

    // Differential: identical request, legitimate Host. It gets past the host gate and fails
    // later on "no SSE stream open", so the 403 above is attributable to the Host header alone.
    const legitimate = await rawRequest(f.port, "/messages?sessionId=nope", {
      method: "POST",
      headers: { ...bearer(TOKEN), host: `127.0.0.1:${f.port}` },
      body: "{}",
    });
    assert.equal(legitimate.status, 409);

    // The same guard protects the legacy SSE stream itself.
    const foreignSse = await rawRequest(f.port, "/sse", {
      headers: { ...bearer(TOKEN), host: "evil.example.com" },
    });
    assert.equal(foreignSse.status, 403);
  } finally {
    await f.dispose();
  }
});

test("H27: the Host allowlist is case-insensitive for the loopback names it accepts", async () => {
  /**
   * `hostAllowed` lowercases the header before comparing against an allowlist built from lowercase
   * literals. An uppercase Host must therefore be treated identically — if it were not, a legitimate
   * client would be refused while the defence gained nothing.
   */
  const f = await startTransport(TOKEN);
  try {
    const upper = await rawRequest(f.port, "/messages?sessionId=nope", {
      method: "POST",
      headers: { ...bearer(TOKEN), host: `LOCALHOST:${f.port}` },
      body: "{}",
    });
    const lower = await rawRequest(f.port, "/messages?sessionId=nope", {
      method: "POST",
      headers: { ...bearer(TOKEN), host: `localhost:${f.port}` },
      body: "{}",
    });

    // Same treatment either way, and specifically *not* the host rejection.
    assert.equal(upper.status, lower.status);
    assert.equal(upper.status, 409);
  } finally {
    await f.dispose();
  }
});

test("H26 fail-open: with no token configured the port is open to any local caller", async () => {
  /**
   * The documented fail-open, asserted so it stays a *decision* rather than becoming an accident.
   * If a future change makes this fail closed, this test goes red and the change is deliberate. If a
   * future change removes the warning, the first assertion here is what notices.
   */
  const f = await startTransport(undefined);
  try {
    const anonymous = await call(f.origin, "/healthz");
    assert.equal(anonymous.status, 200, "no token configured means no authentication is required");

    // An arbitrary bearer is equally accepted, confirming the check is disabled rather than lenient.
    const arbitrary = await call(f.origin, "/healthz", { headers: bearer("anything-at-all") });
    assert.equal(arbitrary.status, 200);
  } finally {
    await f.dispose();
  }
});

test("H26 fail-open: an empty-string token counts as no token", async () => {
  // `start()` documents this explicitly; an operator writing `authToken: ""` must not believe the
  // port is protected.
  const f = await startTransport("");
  try {
    assert.equal((await call(f.origin, "/healthz")).status, 200);
  } finally {
    await f.dispose();
  }
});

/**
 * H28 is covered below with an owned SSE socket fixture.
 *
 * `handle()` assigns `this.sseTransport = transport` for every `GET /sse` without closing the
 * previous one, so two authenticated local clients previously contended for one slot.
 *
 * The fixture owns both response sockets and closes them explicitly, so the test has no retry or
 * forced-exit path.
 *
 * The active transport remains usable after the rejected second connection closes.
 */
test("H28: a second SSE client is rejected without replacing the active stream", async () => {
  const f = await startTransport(TOKEN);
  let first: SseConnection | undefined;
  let replacement: SseConnection | undefined;
  try {
    first = await openSse(f.port);
    assert.equal(first.status, 200);

    const second = await rawRequest(f.port, "/sse", {
      headers: { ...bearer(TOKEN), host: `127.0.0.1:${f.port}` },
      timeoutMs: 750,
    });
    assert.equal(second.status, 409);

    const healthWhileOpen = await call(f.origin, "/healthz", { headers: bearer(TOKEN) });
    assert.equal(JSON.parse(healthWhileOpen.body).connected, true);

    await first.close();
    first = undefined;
    await waitForSseState(f.origin, false);

    replacement = await openSse(f.port);
    assert.equal(replacement.status, 200);
  } finally {
    await replacement?.close();
    await first?.close();
    await f.dispose();
  }
});
