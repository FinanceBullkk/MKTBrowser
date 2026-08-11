import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { copyLegacyMultiZenData, findLegacyMultiZenImport } from "./legacy-multizen-import.ts";

test("copies legacy profiles without changing the MultiZen source tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-legacy-import-"));
  const appData = join(root, "roaming");
  const legacyData = join(appData, "MultiZen", "data");
  const legacyProfile = join(legacyData, "profiles", "profile-1");
  const currentData = join(root, "local", "MKTTool", "MKTBrowser", "data");

  try {
    await mkdir(legacyProfile, { recursive: true });
    await mkdir(join(legacyData, "extension-store", "extension-1", "1.0.0"), { recursive: true });
    await writeFile(join(legacyProfile, "Cookies"), "session-state", "utf8");
    await writeFile(
      join(legacyData, "extension-store", "extension-1", "1.0.0", "manifest.json"),
      "{}",
      "utf8",
    );
    createLegacyDatabase(join(legacyData, "profiles.db"), legacyProfile);
    const sourceHash = await hashTree(legacyData);

    const candidate = findLegacyMultiZenImport(appData, currentData);
    assert.deepEqual(candidate, { status: "ready", legacyDataRoot: legacyData, profileCount: 1 });

    const result = await copyLegacyMultiZenData(legacyData, currentData);
    assert.deepEqual(result, { profileCount: 1 });
    assert.equal(await hashTree(legacyData), sourceHash);
    assert.equal(await readFile(join(currentData, "profiles", "profile-1", "Cookies"), "utf8"), "session-state");
    assert.equal(
      await readFile(
        join(currentData, "extension-store", "extension-1", "1.0.0", "manifest.json"),
        "utf8",
      ),
      "{}",
    );

    const copiedDb = new Database(join(currentData, "profiles.db"), { readonly: true });
    try {
      const row = copiedDb.prepare("SELECT data_dir FROM profiles WHERE id = ?").get("profile-1") as {
        data_dir: string;
      };
      assert.equal(row.data_dir, win32.join(currentData, "profiles", "profile-1"));
    } finally {
      copiedDb.close();
    }
    assert.equal(findLegacyMultiZenImport(appData, currentData), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing MKT Browser data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-legacy-import-existing-"));
  const legacyData = join(root, "legacy");
  const currentData = join(root, "current");
  try {
    await mkdir(legacyData, { recursive: true });
    await mkdir(currentData, { recursive: true });
    createLegacyDatabase(join(legacyData, "profiles.db"), join(legacyData, "profiles", "profile-1"));
    await assert.rejects(
      copyLegacyMultiZenData(legacyData, currentData),
      /will not overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an unreadable legacy database without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-legacy-import-unreadable-"));
  const appData = join(root, "roaming");
  const legacyData = join(appData, "MultiZen", "data");
  try {
    await mkdir(legacyData, { recursive: true });
    await writeFile(join(legacyData, "profiles.db"), "not a sqlite database", "utf8");
    assert.deepEqual(findLegacyMultiZenImport(appData, join(root, "current")), {
      status: "unreadable",
      legacyDataRoot: legacyData,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an import when a database profile directory is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mkt-browser-legacy-import-missing-profile-"));
  const legacyData = join(root, "legacy");
  const currentData = join(root, "current");
  try {
    await mkdir(legacyData, { recursive: true });
    createLegacyDatabase(
      join(legacyData, "profiles.db"),
      join(legacyData, "profiles", "missing-profile"),
    );
    await assert.rejects(copyLegacyMultiZenData(legacyData, currentData), /directory is missing/);
    assert.equal(existsSync(currentData), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createLegacyDatabase(dbPath: string, dataDir: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT,
        tags TEXT NOT NULL,
        proxy TEXT,
        fingerprint TEXT NOT NULL,
        data_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO profiles
      (id, name, notes, tags, proxy, fingerprint, data_dir, created_at, updated_at, last_opened_at)
      VALUES (?, ?, NULL, '[]', NULL, '{}', ?, ?, ?, NULL)
    `).run("profile-1", "Legacy profile", dataDir, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  } finally {
    db.close();
  }
}

async function hashTree(root: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const hash = createHash("sha256");
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) await visit(path);
      else hash.update(await readFile(path));
    }
  }
  await visit(root);
  return hash.digest("hex");
}
