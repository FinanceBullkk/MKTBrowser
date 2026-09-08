import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findActivatedWindowsEngine } from "./activated-windows-engine-cache.ts";

const version = "152.0.7977.64";
function fixture(t: test.TestContext) {
  const cache = mkdtempSync(join(tmpdir(), "mkt-activated-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(cache, "runtime"));
  writeFileSync(join(cache, "runtime", "chrome.exe"), "disposable engine fixture");
  writeFileSync(join(cache, "runtime", ".mkt-runtime.json"), JSON.stringify({ version }));
  return cache;
}

test("recognizes the Relay-installed pinned runtime without a Browser download index", async (t) => {
  const cache = fixture(t);
  assert.deepEqual(await findActivatedWindowsEngine(cache, { version }, "win32"), {
    version,
    binaryPath: join(cache, "runtime", "chrome.exe"),
  });
});

test("requires the signed version even if the directory contains an executable", async (t) => {
  const cache = fixture(t);
  assert.equal(await findActivatedWindowsEngine(cache, null, "win32"), null);
  assert.equal(await findActivatedWindowsEngine(cache, { version: "151.0.0.0" }, "win32"), null);
  assert.equal(await findActivatedWindowsEngine(cache, { version }, "linux"), null);
});

test("rejects missing or malformed runtime metadata and missing executable", async (t) => {
  const cache = fixture(t);
  const metadata = join(cache, "runtime", ".mkt-runtime.json");
  for (const value of ["{", "null", "[]", JSON.stringify({ version: 152 })]) {
    writeFileSync(metadata, value);
    assert.equal(await findActivatedWindowsEngine(cache, { version }, "win32"), null);
  }
  rmSync(metadata);
  assert.equal(await findActivatedWindowsEngine(cache, { version }, "win32"), null);
  writeFileSync(metadata, JSON.stringify({ version }));
  rmSync(join(cache, "runtime", "chrome.exe"));
  assert.equal(await findActivatedWindowsEngine(cache, { version }, "win32"), null);
  writeFileSync(join(cache, "runtime", "chrome.exe"), "");
  assert.equal(await findActivatedWindowsEngine(cache, { version }, "win32"), null);
  rmSync(join(cache, "runtime", "chrome.exe"));
  mkdirSync(join(cache, "runtime", "chrome.exe"));
  assert.equal(await findActivatedWindowsEngine(cache, { version }, "win32"), null);
});
