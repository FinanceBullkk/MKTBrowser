import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "./index.js";

test("an interrupted temporary write preserves the previous settings file", async (context) => {
  await withSettingsFile(async (path) => {
    const store = new SettingsStore(path);
    await store.update({ mcpHttpEnabled: false });
    const original = await readFile(path, "utf8");
    const write = fs.writeFileSync;
    context.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor) => {
      write(target, "partial write");
      throw new Error("simulated disk failure");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.update({ startupOrphanSweep: false }),
        /simulated disk failure/,
      );
      assert.equal(await readFile(path, "utf8"), original);
      assert.equal((await store.load()).mcpHttpEnabled, false);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
    await store.update({ startupOrphanSweep: false });
    assert.equal((await new SettingsStore(path).load()).mcpHttpEnabled, false);
  });
});

test("concurrent setting changes preserve both patches in memory and on disk", async () => {
  await withSettingsFile(async (path) => {
    const store = new SettingsStore(path);
    await Promise.all([
      store.update({ mcpHttpEnabled: false }),
      store.update({ cloakBrowserLicenseKey: "cb_concurrent" }),
      store.update({ startupOrphanSweep: false }),
    ]);
    for (const value of [await store.load(), await new SettingsStore(path).load()]) {
      assert.equal(value.mcpHttpEnabled, false);
      assert.equal(value.cloakBrowserLicenseKey, "cb_concurrent");
      assert.equal(value.startupOrphanSweep, false);
    }
  });
});

test("failed atomic replacement leaves cache unchanged, removes its temp file and permits retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-settings-retry-"));
  try {
    const path = join(root, "settings.json");
    const store = new SettingsStore(path);
    await store.update({ mcpHttpEnabled: false });
    const original = await readFile(path, "utf8");
    await rename(path, join(root, "original.json"));
    await mkdir(path);
    await assert.rejects(store.update({ startupOrphanSweep: false }));
    assert.equal((await store.load()).mcpHttpEnabled, false);
    assert.deepEqual((await readdir(root)).sort(), ["original.json", "settings.json"]);
    assert.equal(await readFile(join(root, "original.json"), "utf8"), original);
    await rm(path, { recursive: true });
    await rename(join(root, "original.json"), path);
    await store.update({ startupOrphanSweep: false });
    const loaded = await new SettingsStore(path).load();
    assert.equal(loaded.mcpHttpEnabled, false);
    assert.equal(loaded.startupOrphanSweep, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish settings to memory when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-settings-store-"));
  try {
    const store = new SettingsStore(root);
    await assert.rejects(store.update({ startupOrphanSweep: false }));
    assert.equal((await store.load()).mcpHttpEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The licence key list decides how many profiles can be open at once, so what the store folds in,
 * drops, or keeps is load-bearing rather than cosmetic. Each case is read back through a second
 * store instance, because the folding happens on load and not on write.
 */
async function withSettingsFile(fn: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-settings-keys-"));
  try {
    await fn(join(root, "settings.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fresh installations default to the only engine", async () => {
  await withSettingsFile(async (path) => {
    const loaded = await new SettingsStore(path).load();
    assert.equal(loaded.browserEngine, "cloakbrowser");
    assert.equal(loaded.cloakBrowserLicenseKey, "");
    assert.deepEqual(loaded.cloakBrowserLicenseKeys, []);
  });
});

test("preserves an explicit saved cloakbrowser selection without rewriting settings", async () => {
  await withSettingsFile(async (path) => {
    const original = JSON.stringify({ browserEngine: "cloakbrowser", startupOrphanSweep: false });
    await writeFile(path, original, "utf8");
    const loaded = await new SettingsStore(path).load();
    assert.equal(loaded.browserEngine, "cloakbrowser");
    assert.equal(loaded.startupOrphanSweep, false);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("a stored cft selection from an older build loads as cloakbrowser without crashing or rewriting", async () => {
  await withSettingsFile(async (path) => {
    const original = JSON.stringify({ browserEngine: "cft", startupOrphanSweep: false });
    await writeFile(path, original, "utf8");
    const loaded = await new SettingsStore(path).load();
    assert.equal(loaded.browserEngine, "cloakbrowser");
    assert.equal(loaded.startupOrphanSweep, false);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("missing or unsupported saved engine falls back to cloakbrowser without rewriting settings", async () => {
  await withSettingsFile(async (path) => {
    for (const saved of [{}, { browserEngine: "unsupported" }]) {
      const original = JSON.stringify(saved);
      await writeFile(path, original, "utf8");
      assert.equal((await new SettingsStore(path).load()).browserEngine, "cloakbrowser");
      assert.equal(await readFile(path, "utf8"), original);
    }
  });
});

test("folds the primary key into the list, first, so an older install keeps working", async () => {
  await withSettingsFile(async (path) => {
    await new SettingsStore(path).update({
      cloakBrowserLicenseKey: "cb_primary",
      cloakBrowserLicenseKeys: [],
    });
    const loaded = await new SettingsStore(path).load();
    assert.deepEqual(loaded.cloakBrowserLicenseKeys, ["cb_primary"]);
  });
});

test("drops a key listed twice, because the engine still grants it one seat", async () => {
  // Two slots on one key would advertise two sessions where there is one: the operator is told a
  // profile can open, and is then refused.
  await withSettingsFile(async (path) => {
    await new SettingsStore(path).update({
      cloakBrowserLicenseKey: "cb_primary",
      cloakBrowserLicenseKeys: ["cb_primary", "cb_second", "cb_second"],
    });
    const loaded = await new SettingsStore(path).load();
    assert.deepEqual(loaded.cloakBrowserLicenseKeys, ["cb_primary", "cb_second"]);
  });
});

test("keeps a retired primary that is still listed, which is why replacing one must remove it", async () => {
  // The store cannot tell a retired key from a deliberate one. Whoever changes the primary has to
  // drop the old value from the list, or rotation spends an attempt and a 17-minute cooldown on a
  // key the operator has already thrown away.
  await withSettingsFile(async (path) => {
    await new SettingsStore(path).update({
      cloakBrowserLicenseKey: "cb_new_primary",
      cloakBrowserLicenseKeys: ["cb_old_primary"],
    });
    const loaded = await new SettingsStore(path).load();
    assert.deepEqual(loaded.cloakBrowserLicenseKeys, ["cb_new_primary", "cb_old_primary"]);
  });
});
