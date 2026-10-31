import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cloakBrowserArchiveName,
  resolveCloakBrowserProManifest,
} from "./cloakbrowser-pro-channel.ts";
import {
  createNetworkRequestDeadlines,
  type DeadlineClock,
} from "./network-request-deadlines.ts";

const VERSION = "151.0.7922.108.6";
const HASH = "a".repeat(64);
const ARCHIVE = cloakBrowserArchiveName();

class ManualDeadlineClock implements DeadlineClock {
  private nextId = 1;
  private readonly callbacks = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(Number(handle));
  }

  delays(): number[] {
    return [...this.callbacks.values()].map(({ delayMs }) => delayMs);
  }

  fireNext(): void {
    const next = this.callbacks.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    assert.ok(next, "expected a pending deadline");
    this.callbacks.delete(next[0]);
    next[1].callback();
  }
}

test("stalled Electron requests abort on header, body-idle, and finalization deadlines", () => {
  const headerClock = new ManualDeadlineClock();
  const headerErrors: Error[] = [];
  let headerAborts = 0;
  const headerDeadline = createNetworkRequestDeadlines({
    label: "browser engine download",
    headerTimeoutMs: 101,
    bodyIdleTimeoutMs: 202,
    abort: () => {
      headerAborts += 1;
    },
    onTimeout: (error) => headerErrors.push(error),
    clock: headerClock,
  });

  assert.deepEqual(headerClock.delays(), [101]);
  headerClock.fireNext();
  assert.equal(headerAborts, 1);
  assert.match(headerErrors[0]?.message ?? "", /response headers.*101ms/i);
  headerDeadline.responseStarted();
  assert.deepEqual(headerClock.delays(), []);

  const bodyClock = new ManualDeadlineClock();
  const bodyErrors: Error[] = [];
  let bodyAborts = 0;
  const bodyDeadline = createNetworkRequestDeadlines({
    label: "browser engine download",
    headerTimeoutMs: 303,
    bodyIdleTimeoutMs: 404,
    abort: () => {
      bodyAborts += 1;
    },
    onTimeout: (error) => bodyErrors.push(error),
    clock: bodyClock,
  });

  bodyDeadline.responseStarted();
  assert.deepEqual(bodyClock.delays(), [404]);
  bodyDeadline.bodyActivity();
  assert.deepEqual(bodyClock.delays(), [404]);
  bodyClock.fireNext();
  assert.equal(bodyAborts, 1);
  assert.match(bodyErrors[0]?.message ?? "", /response body.*404ms/i);
  bodyDeadline.complete();
  assert.deepEqual(bodyClock.delays(), []);

  const finalizationClock = new ManualDeadlineClock();
  const finalizationErrors: Error[] = [];
  let finalizationAborts = 0;
  const finalizationDeadline = createNetworkRequestDeadlines({
    label: "browser engine download",
    headerTimeoutMs: 505,
    bodyIdleTimeoutMs: 606,
    finalizationTimeoutMs: 707,
    abort: () => {
      finalizationAborts += 1;
    },
    onTimeout: (error) => finalizationErrors.push(error),
    clock: finalizationClock,
  });
  finalizationDeadline.responseStarted();
  finalizationDeadline.finalizationStarted();
  assert.deepEqual(finalizationClock.delays(), [707]);
  finalizationClock.fireNext();
  assert.equal(finalizationAborts, 1);
  assert.match(finalizationErrors[0]?.message ?? "", /download finalization.*707ms/i);

  const throwingAbortClock = new ManualDeadlineClock();
  const throwingAbortDeadline = createNetworkRequestDeadlines({
    label: "completed request",
    abort: () => {
      throw new Error("already closed");
    },
    onTimeout: () => {},
    clock: throwingAbortClock,
  });
  assert.doesNotThrow(() => throwingAbortClock.fireNext());
  throwingAbortDeadline.complete();

  const completedClock = new ManualDeadlineClock();
  let completedAborts = 0;
  const completedDeadline = createNetworkRequestDeadlines({
    label: "completed request",
    abort: () => {
      completedAborts += 1;
    },
    onTimeout: () => assert.fail("a completed request must not time out"),
    clock: completedClock,
  });
  completedDeadline.responseStarted();
  completedDeadline.complete();
  assert.deepEqual(completedClock.delays(), []);
  assert.equal(completedAborts, 0);
});

test("Pro checksums fail closed before exchanging the licence key for an archive URL", async (t) => {
  const failures = [
    { name: "HTTP 503", response: () => new Response("unavailable", { status: 503 }) },
    {
      name: "network",
      response: () => {
        throw new Error("https://user:secret@invalid/?token=secret");
      },
    },
    { name: "malformed", response: () => new Response(`invalid  ${ARCHIVE}`) },
    { name: "missing digest", response: () => new Response(`${HASH}  another-platform.zip`) },
    { name: "empty", response: () => new Response("") },
    {
      name: "duplicate",
      response: () => new Response(`${HASH}  ${ARCHIVE}\n${"b".repeat(64)}  ${ARCHIVE}`),
    },
    { name: "trailing data", response: () => new Response(`${HASH}  ${ARCHIVE} untrusted`) },
    {
      name: "wrong version",
      response: () => new Response(`version=151.0.7922.108.2\n${HASH}  ${ARCHIVE}`),
    },
    {
      name: "body transfer",
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("https://user:secret@invalid/?token=secret"));
            },
          }),
        ),
    },
  ];
  for (const failure of failures) {
    await t.test(failure.name, async (context) => {
      let archiveRequests = 0;
      context.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        if (String(url).endsWith("/version")) return Response.json({ version: VERSION });
        if (String(url).endsWith("/SHA256SUMS")) return failure.response();
        archiveRequests += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://archive.example/engine.zip" },
        });
      });
      await assert.rejects(resolveCloakBrowserProManifest("synthetic-test-key"), (error: Error) => {
        assert.match(error.message, /SHA256SUMS|checksum/i);
        assert.doesNotMatch(error.message, /secret|token=|https?:/);
        return true;
      });
      assert.equal(archiveRequests, 0);
    });
  }
});

test("Pro accepts one valid archive checksum and never forwards auth to the redirected URL", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/version")) return Response.json({ version: VERSION });
    if (String(url).endsWith("/SHA256SUMS")) {
      return new Response(`version=${VERSION}\n${HASH.toUpperCase()} *${ARCHIVE}\n`);
    }
    return new Response(null, {
      status: 302,
      headers: { location: "https://archive.example/engine.zip?synthetic=1" },
    });
  });
  const manifest = await resolveCloakBrowserProManifest("synthetic-test-key");
  assert.equal(manifest.sha256, HASH);
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.headers, {});
});

test("bootstrap refuses absent or invalid digests before download or extraction", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron")
        return {
          url: "data:text/javascript,export const app = {}; export const net = {};",
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { ChromiumBootstrap } = await import("./ChromiumBootstrap.ts");
  for (const sha256 of [undefined, "", "not-a-sha256"]) {
    await t.test(`cloakbrowser: ${sha256 ?? "absent"}`, async (context) => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mkt-engine-checksum-"));
      context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
      const bootstrap = new ChromiumBootstrap({
        cacheDir,
        engine: "cloakbrowser",
        pinnedManifest: {
          version: VERSION,
          url: "https://archive.example/engine.zip",
          sha256,
        },
      });
      const states: string[] = [];
      bootstrap.on("status", (status) => states.push(status.kind));
      let transfers = 0;
      Object.defineProperty(bootstrap, "downloadAttempt", {
        value: async () => {
          transfers += 1;
          return HASH;
        },
      });
      await assert.rejects(bootstrap.ensure(), /checksum.*missing or invalid/i);
      assert.equal(transfers, 0);
      assert.ok(!states.includes("extracting"));
      assert.ok(!states.includes("ready"));
    });
  }
});

test("bootstrap rejects mismatched archive bytes without extraction", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron")
        return {
          url: "data:text/javascript,export const app = {}; export const net = {};",
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { ChromiumBootstrap } = await import("./ChromiumBootstrap.ts");
  const cacheDir = mkdtempSync(join(tmpdir(), "mkt-engine-mismatch-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const bootstrap = new ChromiumBootstrap({
    cacheDir,
    engine: "cloakbrowser",
    pinnedManifest: {
      version: VERSION,
      url: "https://archive.example/engine.zip",
      sha256: HASH,
    },
  });
  const states: string[] = [];
  bootstrap.on("status", (status) => states.push(status.kind));
  let transfers = 0;
  Object.defineProperty(bootstrap, "downloadAttempt", {
    value: async () => {
      transfers += 1;
      return "b".repeat(64);
    },
  });
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    realSetTimeout(callback, 0)) as typeof setTimeout);
  await assert.rejects(bootstrap.ensure(), /checksum mismatch/i);
  assert.equal(transfers, 5);
  assert.ok(!states.includes("extracting"));
  assert.ok(!states.includes("ready"));
});

test("keyless CloakBrowser also refuses absent sums instead of selecting an older release", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron")
        return {
          url: "data:text/javascript,export const app = {}; export const net = {};",
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { ChromiumBootstrap } = await import("./ChromiumBootstrap.ts");
  const cacheDir = mkdtempSync(join(tmpdir(), "mkt-keyless-checksum-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json([
      {
        tag_name: `chromium-v${VERSION}`,
        assets: [{ name: ARCHIVE, browser_download_url: "https://archive.example/engine.zip" }],
      },
      {
        tag_name: "chromium-v146.0.7680.177.5",
        assets: [{ name: ARCHIVE, browser_download_url: "https://archive.example/old.zip" }],
      },
    ]),
  );
  const bootstrap = new ChromiumBootstrap({
    cacheDir,
    engine: "cloakbrowser",
    allowUnpinnedManifest: true,
  });
  await assert.rejects(
    Reflect.get(bootstrap, "fetchKeylessCloakBrowserManifest").call(bootstrap),
    /no SHA256SUMS/,
  );
});
