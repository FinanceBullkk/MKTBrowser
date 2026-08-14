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
