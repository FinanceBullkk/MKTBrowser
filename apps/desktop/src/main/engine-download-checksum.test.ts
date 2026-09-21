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

const VERSION = "151.0.7922.108.6";
const HASH = "a".repeat(64);
const ARCHIVE = cloakBrowserArchiveName();

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
  for (const engine of ["cloakbrowser", "cft"] as const) {
    for (const sha256 of [undefined, "", "not-a-sha256"]) {
      await t.test(`${engine}: ${sha256 ?? "absent"}`, async (context) => {
        const cacheDir = mkdtempSync(join(tmpdir(), "mkt-engine-checksum-"));
        context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
        const bootstrap = new ChromiumBootstrap({
          cacheDir,
          engine,
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

test("unpinned CFT retains its explicitly limited development checksum behavior", async (t) => {
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
  const cacheDir = mkdtempSync(join(tmpdir(), "mkt-cft-checksum-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const bootstrap = new ChromiumBootstrap({ cacheDir, engine: "cft", allowUnpinnedManifest: true });
  let transfers = 0;
  Object.defineProperty(bootstrap, "downloadAttempt", {
    value: async () => {
      transfers += 1;
      return HASH;
    },
  });
  assert.equal(
    await Reflect.get(bootstrap, "download").call(
      bootstrap,
      { version: "152.0.7977.64", url: "https://archive.example/engine.zip" },
      join(cacheDir, "engine.partial"),
    ),
    HASH,
  );
  assert.equal(transfers, 1);
});
