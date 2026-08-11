import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  IdempotentProfileCreateConflictError,
  ManagedProfileLockedError,
  ProfileManager,
} from "./ProfileManager.ts";

test("migrates existing profile databases to managed-create schema v2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-managed-migration-"));
  const dbPath = path.join(root, "profiles.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      proxy TEXT,
      fingerprint TEXT NOT NULL,
      data_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT
    );
  `);
  legacy.close();

  const manager = new ProfileManager({ dbPath, profilesRoot: path.join(root, "profiles") });
  manager.close();

  const migrated = new Database(dbPath, { readonly: true });
  const columns = migrated
    .prepare("PRAGMA table_info(profiles)")
    .all()
    .map((column) => (column as { name: string }).name);
  const indexes = migrated
    .prepare("PRAGMA index_list(profiles)")
    .all()
    .map((index) => (index as { name: string }).name);
  migrated.close();

  assert.ok(columns.includes("external_ref"));
  assert.ok(columns.includes("create_request_id"));
  assert.ok(columns.includes("create_request_hash"));
  assert.ok(indexes.includes("idx_profiles_external_ref"));
  assert.ok(indexes.includes("idx_profiles_create_request_id"));
  await rm(root, { recursive: true, force: true });
});

test("locks managed proxy, fingerprint, and deletion while preserving metadata edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-managed-lock-"));
  const manager = new ProfileManager({
    dbPath: path.join(root, "profiles.db"),
    profilesRoot: path.join(root, "profiles"),
  });

  try {
    const { profile } = manager.createIdempotent(
      { name: "Managed" },
      { externalRef: "account-1", requestId: "request-1", requestHash: "hash-1" },
    );
    assert.equal(profile.managed, true);
    assert.equal(manager.list()[0]?.managed, true);

    assert.throws(
      () => manager.update(profile.id, { proxy: { type: "http", host: "proxy", port: 8080 } }),
      ManagedProfileLockedError,
    );
    assert.throws(() => manager.update(profile.id, { fingerprint: {} }), ManagedProfileLockedError);
    assert.throws(() => manager.delete(profile.id), ManagedProfileLockedError);

    assert.equal(manager.update(profile.id, { name: "Managed metadata" }).name, "Managed metadata");
    assert.equal(
      manager.updateManagedProxy(profile.id, { type: "http", host: "proxy", port: 8080 }).proxy
        ?.host,
      "proxy",
    );
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciles exact managed-create retries without creating duplicate profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mkt-browser-managed-create-"));
  const manager = new ProfileManager({
    dbPath: path.join(root, "profiles.db"),
    profilesRoot: path.join(root, "profiles"),
  });
  const input = { name: "Managed profile", tags: ["mkttool"] };
  const metadata = {
    externalRef: "account-123",
    requestId: "request-abc",
    requestHash: "a".repeat(64),
  };

  const first = manager.createIdempotent(input, metadata);
  const exactRetry = manager.createIdempotent(input, metadata);
  const reconciledByExternalRef = manager.createIdempotent(input, {
    ...metadata,
    requestId: "request-after-timeout",
  });

  assert.equal(first.created, true);
  assert.equal(exactRetry.created, false);
  assert.equal(reconciledByExternalRef.created, false);
  assert.equal(exactRetry.profile.id, first.profile.id);
  assert.equal(reconciledByExternalRef.profile.id, first.profile.id);
  assert.equal(manager.list().length, 1);

  assert.throws(
    () =>
      manager.createIdempotent(input, {
        ...metadata,
        externalRef: "account-456",
        requestHash: "b".repeat(64),
      }),
    IdempotentProfileCreateConflictError,
  );
  assert.throws(
    () =>
      manager.createIdempotent(input, {
        ...metadata,
        requestId: "request-conflict",
        requestHash: "c".repeat(64),
      }),
    IdempotentProfileCreateConflictError,
  );

  const localA = manager.create({ name: "Local profile" });
  const localB = manager.create({ name: "Local profile" });
  assert.notEqual(localA.id, localB.id);
  assert.equal(manager.list().length, 3);

  manager.close();
  await rm(root, { recursive: true, force: true });
});
