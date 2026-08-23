import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "./index.js";

test("does not publish settings to memory when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-settings-store-"));
  try {
    const store = new SettingsStore(root);
    await assert.rejects(store.update({ browserEngine: "cft" }));
    assert.equal((await store.load()).browserEngine, "cloakbrowser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The licence key list decides how many profiles can be open at once, so what the store folds in,
 * drops, or keeps is load-bearing rather than cosmetic. Each case is read back through a second
 * store instance, because the folding happens on load and not on write.
 */
async function withSettingsFile(
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-settings-keys-"));
  try {
    await fn(join(root, "settings.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
