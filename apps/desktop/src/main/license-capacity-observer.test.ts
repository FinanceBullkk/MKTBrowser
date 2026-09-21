import assert from "node:assert/strict";
import test from "node:test";
import { LicenseCapacityObserver } from "./license-capacity-observer.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("classifies fresh available and occupied capacity from bounded integer responses", async () => {
  let now = 1_000;
  const replies = [jsonResponse({ active: 0, limit: 1 }), jsonResponse({ active: 1, limit: 1 })];
  const observer = new LicenseCapacityObserver({
    fetch: async () => replies.shift()!,
    wallNow: () => now,
    monotonicNow: () => now,
    freshnessMs: 5_000,
  });

  const available = await observer.observe("cb_fixture");
  assert.equal(available.state, "available");
  assert.equal(available.active, 0);
  assert.equal(available.limit, 1);
  assert.equal(observer.freshObservation()?.state, "available");

  now += 5_001;
  assert.equal(observer.freshObservation(), null);
  const occupied = await observer.observe("cb_fixture");
  assert.equal(occupied.state, "occupied");
  assert.equal(occupied.active, 1);
});

test("distinguishes denial, rate limiting, malformed responses, timeout, and unreachable network", async () => {
  const cases: Array<{
    expected: string;
    reason: string;
    fetch: (input: string, init: RequestInit) => Promise<Response>;
  }> = [
    {
      expected: "denied",
      reason: "HTTP_403",
      fetch: async () => jsonResponse({ error: "invalid_key_cb_secret_fragment" }, 403),
    },
    {
      expected: "rate-limited",
      reason: "RATE_LIMITED",
      fetch: async () => new Response("not-json", { status: 429 }),
    },
    {
      expected: "denied",
      reason: "HTTP_500",
      fetch: async () => new Response("not-json", { status: 500 }),
    },
    {
      expected: "malformed",
      reason: "INVALID_CAPACITY_COUNTS",
      fetch: async () => jsonResponse({ active: -1, limit: 1 }),
    },
    {
      expected: "timeout",
      reason: "REQUEST_TIMEOUT",
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    },
    {
      expected: "unreachable",
      reason: "NETWORK_UNREACHABLE",
      fetch: async () => { throw new TypeError("offline"); },
    },
  ];

  for (const entry of cases) {
    const observer = new LicenseCapacityObserver({ fetch: entry.fetch, timeoutMs: 1 });
    const result = await observer.observe("cb_fixture");
    assert.equal(result.state, entry.expected);
    assert.equal(result.reason, entry.reason);
    assert.doesNotMatch(result.reason, /SECRET|FRAGMENT/);
  }
});

test("treats response stream failures as network errors and only parsed success bodies as JSON", async () => {
  const streamFailure = new LicenseCapacityObserver({
    fetch: async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }), { status: 200 }),
  });
  const invalidJson = new LicenseCapacityObserver({
    fetch: async () => new Response("not-json", { status: 200 }),
  });

  const streamResult = await streamFailure.observe("cb_fixture");
  const jsonResult = await invalidJson.observe("cb_fixture");
  assert.deepEqual([streamResult.state, streamResult.reason], ["unreachable", "NETWORK_UNREACHABLE"]);
  assert.deepEqual([jsonResult.state, jsonResult.reason], ["malformed", "INVALID_JSON"]);
});

test("applies the request timeout while reading a response body", async () => {
  const observer = new LicenseCapacityObserver({
    fetch: async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"active":0'));
          init.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    },
    timeoutMs: 10,
  });

  const result = await observer.observe("cb_fixture");
  assert.equal(result.state, "timeout");
  assert.equal(result.reason, "REQUEST_TIMEOUT");
});

test("coalesces duplicate checks and rejects an invalidated late observation", async () => {
  let calls = 0;
  let resolveResponse!: (response: Response) => void;
  const observer = new LicenseCapacityObserver({
    fetch: async () => {
      calls += 1;
      return await new Promise<Response>((resolve) => { resolveResponse = resolve; });
    },
  });

  const first = observer.observe("cb_fixture");
  const duplicate = observer.observe("cb_fixture");
  assert.equal(calls, 1);
  observer.invalidate();
  assert.equal(observer.isObserving(), false);
  resolveResponse(jsonResponse({ active: 0, limit: 1 }));

  assert.equal((await first).state, "available");
  assert.equal((await duplicate).state, "available");
  assert.equal(observer.freshObservation(), null);
});

test("starts a new same-key request after invalidation and cannot publish the older result", async () => {
  const responses: Array<(response: Response) => void> = [];
  const observer = new LicenseCapacityObserver({
    fetch: async () => await new Promise<Response>((resolve) => responses.push(resolve)),
  });

  const oldRequest = observer.observe("cb_fixture");
  observer.invalidate();
  const currentRequest = observer.observe("cb_fixture");
  assert.equal(responses.length, 2);

  responses[0]!(jsonResponse({ active: 0, limit: 1 }));
  assert.equal((await oldRequest).state, "available");
  assert.equal(observer.freshObservation(), null);
  assert.equal(observer.isObserving(), true);

  responses[1]!(jsonResponse({ active: 1, limit: 1 }));
  assert.equal((await currentRequest).state, "occupied");
  assert.equal(observer.freshObservation()?.state, "occupied");
  assert.equal(observer.isObserving(), false);
});

test("a different key invalidates an older out-of-order observation", async () => {
  const responses = new Map<string, (response: Response) => void>();
  const observer = new LicenseCapacityObserver({
    fetch: async (_input, init) => {
      const key = JSON.parse(String(init.body)).license_key as string;
      return await new Promise<Response>((resolve) => responses.set(key, resolve));
    },
  });

  const oldKey = observer.observe("cb_old");
  const newKey = observer.observe("cb_new");
  responses.get("cb_new")!(jsonResponse({ active: 0, limit: 1 }));
  assert.equal((await newKey).state, "available");

  responses.get("cb_old")!(jsonResponse({ active: 1, limit: 1 }));
  assert.equal((await oldKey).state, "occupied");
  assert.equal(observer.freshObservation()?.state, "available");
});

test("rejects an oversized response before parsing provider data", async () => {
  const observer = new LicenseCapacityObserver({
    fetch: async () => new Response("x".repeat(65), { status: 200 }),
    maxResponseBytes: 64,
  });

  const result = await observer.observe("cb_fixture");
  assert.equal(result.state, "malformed");
  assert.equal(result.reason, "RESPONSE_TOO_LARGE");
});
