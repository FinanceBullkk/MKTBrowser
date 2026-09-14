import assert from "node:assert/strict";
import test from "node:test";
import { auditProfileDirectories } from "./profile-directory-audit.ts";

test("reports nothing when the product and the disk agree", () => {
  const audit = auditProfileDirectories(["a", "b"], ["a", "b"]);
  assert.deepEqual(audit.orphanDirectories, []);
  assert.deepEqual(audit.missingDirectories, []);
});

test("separates a directory nobody owns from a profile with no data", () => {
  const audit = auditProfileDirectories(["a", "gone"], ["a", "orphan"]);
  // Browsing data the product no longer knows about - it still holds cookies and sessions.
  assert.deepEqual(audit.orphanDirectories, ["orphan"]);
  // The opposite failure: opening this profile would break, and the product cannot tell yet.
  assert.deepEqual(audit.missingDirectories, ["gone"]);
});

test("does not mistake the deletion staging directory for a profile", () => {
  // `.deleting` lives inside profilesRoot by design; counting it would invent an orphan on every
  // machine that has ever deleted a profile.
  const audit = auditProfileDirectories(["a"], ["a", ".deleting"]);
  assert.deepEqual(audit.orphanDirectories, []);
  assert.deepEqual(audit.directories, ["a"]);
});
