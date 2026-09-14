import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ProfileManager, ManagedProfileLockedError } from "./ProfileManager.ts";
import {
  ProfileDeletionIncompleteError,
  UnsafeProfileDeletionPathError,
  permanentlyDeleteOwnedProfile,
} from "./permanent-profile-deletion.ts";

test("permanently deletes a managed profile only through the dedicated lifecycle", () => {
  const fixture = createFixture();
  const result = fixture.manager.createIdempotent(
    { name: "Managed deletion test" },
    { externalRef: "account-1", requestId: "request-1", requestHash: "hash-1" },
  );
  writeFileSync(path.join(result.profile.dataDir, "Cookies"), "synthetic");

  assert.throws(() => fixture.manager.delete(result.profile.id), ManagedProfileLockedError);
  fixture.manager.deletePermanently(result.profile.id);

  assert.equal(fixture.manager.get(result.profile.id), null);
  assert.equal(existsSync(result.profile.dataDir), false);
  fixture.cleanup();
});

test("leaves no quarantine directory behind inside the profile root", () => {
  const fixture = createFixture();
  const first = fixture.manager.createIdempotent(
    { name: "Quarantine cleanup one" },
    { externalRef: "account-q1", requestId: "request-q1", requestHash: "hash-q1" },
  );
  const second = fixture.manager.createIdempotent(
    { name: "Quarantine cleanup two" },
    { externalRef: "account-q2", requestId: "request-q2", requestHash: "hash-q2" },
  );

  fixture.manager.deletePermanently(first.profile.id);
  // An empty `.deleting` left inside profilesRoot makes every listing of that folder report one
  // profile more than the product has - which is how a directory count and the app disagree.
  assert.equal(existsSync(path.join(fixture.profilesRoot, ".deleting")), false);

  // Still reusable: the second deletion recreates and removes it again.
  fixture.manager.deletePermanently(second.profile.id);
  assert.equal(existsSync(path.join(fixture.profilesRoot, ".deleting")), false);
  assert.deepEqual(readdirSync(fixture.profilesRoot), []);
  fixture.cleanup();
});

test("refuses a database row that points outside the owned profile root", () => {
  const fixture = createFixture();
  const profile = fixture.manager.create({ name: "Unsafe path test" });
  fixture.manager.close();
  const outside = path.join(fixture.root, "outside-profile");
  writeFileSync(outside, "must survive");
  const db = new Database(fixture.dbPath);
  db.prepare(`UPDATE profiles SET data_dir = ? WHERE id = ?`).run(outside, profile.id);
  db.close();

  const reopened = new ProfileManager({
    dbPath: fixture.dbPath,
    profilesRoot: fixture.profilesRoot,
  });
  assert.throws(() => reopened.deletePermanently(profile.id), UnsafeProfileDeletionPathError);
  assert.ok(reopened.get(profile.id));
  assert.equal(existsSync(outside), true);
  reopened.close();
  fixture.removeRoot();
});

test("refuses a profile directory link that escapes the owned profile root", () => {
  const fixture = createFixture();
  const profile = fixture.manager.create({ name: "Unsafe link test" });
  fixture.manager.close();
  rmSync(profile.dataDir, { recursive: true, force: true });
  const outside = path.join(fixture.root, "outside-profile-directory");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "marker"), "must survive");
  symlinkSync(outside, profile.dataDir, process.platform === "win32" ? "junction" : "dir");

  const reopened = new ProfileManager({
    dbPath: fixture.dbPath,
    profilesRoot: fixture.profilesRoot,
  });
  assert.throws(() => reopened.deletePermanently(profile.id), UnsafeProfileDeletionPathError);
  assert.ok(reopened.get(profile.id));
  assert.equal(existsSync(path.join(outside, "marker")), true);
  reopened.close();
  fixture.removeRoot();
});

test("retries safely when files were removed but the database delete failed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mkt-browser-delete-retry-"));
  const profileId = "profile-1";
  const dataDir = path.join(root, profileId);
  mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, "marker"), "synthetic");
  let pending = false;
  let deleted = false;
  const input = {
    profileId,
    dataDir,
    profilesRoot: root,
    pending,
    markPending: () => {
      pending = true;
    },
    clearPending: () => {
      pending = false;
    },
    deleteRecord: () => {
      throw new Error("synthetic database failure");
    },
  };

  assert.throws(() => permanentlyDeleteOwnedProfile(input), ProfileDeletionIncompleteError);
  assert.equal(pending, true);
  assert.equal(existsSync(dataDir), false);

  permanentlyDeleteOwnedProfile({
    ...input,
    pending,
    deleteRecord: () => {
      deleted = true;
    },
  });
  assert.equal(deleted, true);
  rmSync(root, { recursive: true, force: true });
});

function createFixture(): {
  root: string;
  dbPath: string;
  profilesRoot: string;
  manager: ProfileManager;
  cleanup: () => void;
  removeRoot: () => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "mkt-browser-profile-delete-"));
  const dbPath = path.join(root, "profiles.db");
  const profilesRoot = path.join(root, "profiles");
  const manager = new ProfileManager({ dbPath, profilesRoot });
  return {
    root,
    dbPath,
    profilesRoot,
    manager,
    cleanup: () => {
      manager.close();
      rmSync(root, { recursive: true, force: true });
    },
    removeRoot: () => rmSync(root, { recursive: true, force: true }),
  };
}
