import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "bootstrap reuses a signed Relay activation without downloading its authenticated URL",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "mkt-activated-bootstrap-"));
    t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    const version = "152.0.7977.64";
    mkdirSync(join(cacheDir, "runtime"));
    writeFileSync(join(cacheDir, "runtime", "chrome.exe"), "disposable engine fixture");
    writeFileSync(join(cacheDir, "runtime", ".mkt-runtime.json"), JSON.stringify({ version }));
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
    const bootstrap = new ChromiumBootstrap({
      cacheDir,
      engine: "cloakbrowser",
      pinnedManifest: {
        version,
        url: "https://candidate.example/authenticated-engine.artifact",
        sha256: "a".repeat(64),
        sizeBytes: 202713690,
      },
    });
    let downloadCalled = false;
    Object.defineProperty(bootstrap, "download", {
      value: async () => {
        downloadCalled = true;
        throw new Error("Unexpected download of the already activated engine");
      },
    });
    assert.deepEqual(await bootstrap.ensure(), {
      kind: "ready",
      version,
      binaryPath: join(cacheDir, "runtime", "chrome.exe"),
    });
    assert.equal(downloadCalled, false);
    await assert.rejects(bootstrap.retry(), /Unexpected download of the already activated engine/);
    assert.equal(downloadCalled, true, "an explicit retry must still bypass the activated cache");
  },
);
