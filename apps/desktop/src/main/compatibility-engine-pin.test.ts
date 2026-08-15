import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { win32 } from "node:path";
import test from "node:test";
import {
  compatibilityUpdaterRoot,
  isCachedEngineVersionAllowed,
  isDisposableUnpinnedEngineRun,
  readCompatibilityActivationBlock,
  readCompatibilityEnginePin,
} from "./compatibility-engine-pin.ts";

test("reads the active engine pin from the shared MKTTool compatibility root", () => {
  const local = windowsTempRoot();
  const root = compatibilityUpdaterRoot(local);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    win32.join(root, "active-engine.json"),
    JSON.stringify({
      schemaVersion: 1,
      sequence: 2,
      engineKind: "cloakbrowser",
      version: "145.0.0.0",
      url: "https://releases.example/engine.zip",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
    }),
  );
  assert.equal(readCompatibilityEnginePin(local)?.engineKind, "cloakbrowser");
  rmSync(local, { recursive: true, force: true });
});

test("blocks Browser startup while a durable activation marker exists", () => {
  const local = windowsTempRoot();
  const root = compatibilityUpdaterRoot(local);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    win32.join(root, "activation-marker.json"),
    JSON.stringify({ schemaVersion: 1, sequence: 3, manifestDigest: "b".repeat(64), phase: "activating" }),
  );
  assert.match(readCompatibilityActivationBlock(local) ?? "", /prevent a mixed-version profile launch/);
  rmSync(local, { recursive: true, force: true });
});

test("allows unpinned engines only for explicit disposable development runs", () => {
  assert.equal(
    isDisposableUnpinnedEngineRun({
      isPackaged: false,
      environmentEnabled: true,
      hasExplicitUserDataDir: true,
    }),
    true,
  );
  assert.equal(
    isDisposableUnpinnedEngineRun({
      isPackaged: true,
      environmentEnabled: true,
      hasExplicitUserDataDir: true,
    }),
    false,
  );
  assert.equal(
    isDisposableUnpinnedEngineRun({
      isPackaged: false,
      environmentEnabled: false,
      hasExplicitUserDataDir: true,
    }),
    false,
  );
  assert.equal(
    isDisposableUnpinnedEngineRun({
      isPackaged: false,
      environmentEnabled: true,
      hasExplicitUserDataDir: false,
    }),
    false,
  );
});

test("rejects a cached runtime whose version differs from the signed engine pin", () => {
  const pin = {
    schemaVersion: 1 as const,
    sequence: 2,
    engineKind: "cloakbrowser" as const,
    version: "146.0.7680.177.5",
    url: "https://releases.example/engine.zip",
    sha256: "a".repeat(64),
    sizeBytes: 1024,
  };
  assert.equal(isCachedEngineVersionAllowed(pin.version, pin), true);
  assert.equal(isCachedEngineVersionAllowed("146.0.7680.177.4", pin), false);
});

function windowsTempRoot(): string {
  return mkdtempSync(win32.join(os.tmpdir().replaceAll("/", "\\"), "mkt-pin-"));
}
