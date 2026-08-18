import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCrx2, createCrx3, createZip } from "./crx-test-fixtures.ts";
import { unpackToStore } from "./crxPipeline.ts";
import { resolveLoadDir } from "./extensionStore.ts";

const manifest = JSON.stringify({
  manifest_version: 3,
  name: "Synthetic audit extension",
  version: "1.2.3",
});

const zip = createZip([{ name: "manifest.json", content: manifest }]);

async function fixture(): Promise<{
  root: string;
  source: string;
  store: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mkb-crx-audit-"));
  return {
    root,
    source: join(root, "extension.crx"),
    store: join(root, "store"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("H38: a valid CRX3 signature and requested Web Store ID are both required", async () => {
  const f = await fixture();
  try {
    const crx = createCrx3(zip);
    await writeFile(f.source, crx.bytes);

    const installed = await unpackToStore({
      source: f.source,
      storeRoot: f.store,
      origin: "web-store",
      expectedId: crx.id,
    });
    assert.equal(installed.id, crx.id);

    await assert.rejects(
      unpackToStore({
        source: f.source,
        storeRoot: join(f.root, "wrong-id-store"),
        origin: "web-store",
        expectedId: "a".repeat(32),
      }),
      /does not match requested Web Store ID/i,
    );
  } finally {
    await f.dispose();
  }
});

test("H38: tampered CRX3 and CRX2 signatures are rejected", async () => {
  const f = await fixture();
  try {
    for (const [version, crx] of [
      ["CRX3", createCrx3(zip, false)],
      ["CRX2", createCrx2(zip, false)],
    ] as const) {
      await writeFile(f.source, crx.bytes);
      await assert.rejects(
        unpackToStore({
          source: f.source,
          storeRoot: join(f.store, version),
          origin: "file",
        }),
        /signature/i,
      );
    }
  } finally {
    await f.dispose();
  }
});

test("H38: a valid CRX2 publisher signature remains supported", async () => {
  const f = await fixture();
  try {
    const crx = createCrx2(zip);
    await writeFile(f.source, crx.bytes);
    const installed = await unpackToStore({
      source: f.source,
      storeRoot: f.store,
      origin: "file",
    });
    assert.equal(installed.id, crx.id);
  } finally {
    await f.dispose();
  }
});

test("H38: ZIP entries cannot traverse outside the staging directory", async () => {
  const f = await fixture();
  const escaped = join(f.root, "escaped.txt");
  try {
    const traversalZip = createZip([
      { name: "manifest.json", content: manifest },
      { name: "../escaped.txt", content: "must not be written" },
    ]);
    const crx = createCrx3(traversalZip);
    await writeFile(f.source, crx.bytes);

    await assert.rejects(
      unpackToStore({ source: f.source, storeRoot: f.store, origin: "file" }),
      /out of bound path|invalid relative path|outside/i,
    );
    assert.equal(existsSync(escaped), false);
  } finally {
    await f.dispose();
  }
});

test("H38: a manifest version cannot escape the shared extension store", async () => {
  const f = await fixture();
  const sourceDir = join(f.root, "folder-extension");
  const escaped = join(f.root, "escaped");
  try {
    await mkdir(sourceDir);
    await writeFile(
      join(sourceDir, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Traversal attempt",
        version: "..\\..\\escaped",
      }),
    );

    await assert.rejects(
      unpackToStore({ source: sourceDir, storeRoot: f.store, origin: "folder" }),
      /unsafe extension version/i,
    );
    assert.equal(existsSync(escaped), false);
  } finally {
    await f.dispose();
  }
});

test("H38: persisted extension references cannot resolve outside their owned roots", () => {
  const profileDir = join("C:\\profiles", "profile-1");
  const storeRoot = "C:\\extension-store";
  const base = {
    id: "a".repeat(32),
    name: "Synthetic",
    version: "1.0.0",
    enabled: true,
    source: "file" as const,
  };

  assert.throws(
    () =>
      resolveLoadDir({ ...base, scope: "profile", dir: "..\\..\\outside" }, profileDir, storeRoot),
    /outside the profile data directory/i,
  );
  assert.throws(
    () =>
      resolveLoadDir({ ...base, scope: "shared", dir: "", version: ".." }, profileDir, storeRoot),
    /unsafe extension version/i,
  );
});
